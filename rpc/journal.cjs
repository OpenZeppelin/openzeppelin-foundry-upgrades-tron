const { isDeepStrictEqual } = require('node:util');
const { randomUUID } = require('node:crypto');

const { getCreateAddress, keccak256 } = require('ethers');

const { toEvmAddress } = require('./address-codec.cjs');
const { validateChainIdentity } = require('./store.cjs');

const JOURNAL_VERSION = 1;
const TRANSACTION_HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const NATIVE_TRANSACTION_ID_PATTERN = /^(?:0x)?[0-9a-fA-F]{64}$/;
const HEX_BYTES_PATTERN = /^(?:0x)?(?:[0-9a-fA-F]{2})+$/;
const OWNER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTRACT_KIND_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const STATES = new Set(['received', 'native-built', 'broadcast', 'confirmed', 'failed']);
const SIMULATION_MODES = new Set(['exact-signed', 'constant-create', 'constant-call']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function exactKeys(object, expected) {
  const actual = Object.keys(object).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function normalizeSourceTransaction(signedEthereumTransaction) {
  if (
    typeof signedEthereumTransaction !== 'string' ||
    !signedEthereumTransaction.startsWith('0x') ||
    !HEX_BYTES_PATTERN.test(signedEthereumTransaction)
  ) {
    throw new Error('Invalid signed Ethereum transaction');
  }
  return signedEthereumTransaction.toLowerCase();
}

function normalizeSourceHash(sourceTransactionHash) {
  if (typeof sourceTransactionHash !== 'string') {
    throw new Error('Invalid source transaction hash');
  }
  const normalized = sourceTransactionHash.toLowerCase();
  if (!TRANSACTION_HASH_PATTERN.test(normalized)) {
    throw new Error('Invalid source transaction hash');
  }
  return normalized;
}

function validateNativeTransaction(nativeTransaction) {
  if (!isObject(nativeTransaction)) {
    throw new Error('Invalid native transaction');
  }
  if (
    typeof nativeTransaction.signedNativeTransaction !== 'string' ||
    !HEX_BYTES_PATTERN.test(nativeTransaction.signedNativeTransaction)
  ) {
    throw new Error('Invalid signed native transaction bytes');
  }
  if (
    typeof nativeTransaction.nativeTransactionId !== 'string' ||
    !NATIVE_TRANSACTION_ID_PATTERN.test(nativeTransaction.nativeTransactionId)
  ) {
    throw new Error('Invalid native transaction txid');
  }
  if (!exactKeys(nativeTransaction, ['nativeTransactionId', 'signedNativeTransaction'])) {
    throw new Error('Invalid native transaction');
  }
  return structuredClone(nativeTransaction);
}

function validateFailure(failure) {
  if (
    !isObject(failure) ||
    !exactKeys(failure, ['code', 'message']) ||
    typeof failure.code !== 'string' ||
    failure.code.length === 0 ||
    typeof failure.message !== 'string' ||
    failure.message.length === 0
  ) {
    throw new Error('Invalid terminal failure');
  }
  return structuredClone(failure);
}

function validateOwnerId(ownerId) {
  if (typeof ownerId !== 'string' || !OWNER_ID_PATTERN.test(ownerId)) {
    throw new Error('Invalid transaction journal owner ID');
  }
  return ownerId;
}

function durableReceipt(receipt) {
  try {
    if (!isObject(receipt)) {
      throw new Error('receipt must be an object');
    }
    const clonedReceipt = structuredClone(receipt);
    const normalized = JSON.parse(JSON.stringify(clonedReceipt));
    if (!isDeepStrictEqual(clonedReceipt, normalized)) {
      throw new Error('receipt is not JSON-safe');
    }
    return normalized;
  } catch (error) {
    throw new Error('Invalid confirmed receipt', { cause: error });
  }
}

function normalizeAddress(value, label, nullable = false) {
  if (nullable && value === null) return null;
  try {
    return toEvmAddress(value);
  } catch (error) {
    throw new Error(`Invalid ${label} address`, { cause: error });
  }
}

function validateArtifactIdentity(identity, nullable = false) {
  if (nullable && identity === null) return null;
  if (
    !isObject(identity) ||
    !exactKeys(identity, ['contractName', 'fullyQualifiedName', 'sourceName']) ||
    typeof identity.sourceName !== 'string' ||
    identity.sourceName.length === 0 ||
    typeof identity.contractName !== 'string' ||
    identity.contractName.length === 0 ||
    identity.fullyQualifiedName !== `${identity.sourceName}:${identity.contractName}`
  ) {
    throw new Error('Invalid artifact identity');
  }
  return structuredClone(identity);
}

function validateOperationContext(context) {
  const keys = [
    'actualTarget',
    'artifactIdentity',
    'contractKind',
    'from',
    'kind',
    'nonce',
    'predictedContractAddress',
    'provenanceHash',
    'to',
  ];
  if (!isObject(context) || !exactKeys(context, keys)) throw new Error('Invalid native operation context');
  if (context.kind !== 'deployment' && context.kind !== 'call') throw new Error('Invalid native operation context');
  if (typeof context.nonce !== 'string' || !DECIMAL_PATTERN.test(context.nonce)) {
    throw new Error('Invalid native operation nonce');
  }
  const contractKind = context.contractKind;
  if (contractKind !== null && (typeof contractKind !== 'string' || !CONTRACT_KIND_PATTERN.test(contractKind))) {
    throw new Error('Invalid native operation contract kind');
  }
  const provenanceHash = context.provenanceHash;
  if (
    provenanceHash !== null &&
    (typeof provenanceHash !== 'string' || !TRANSACTION_HASH_PATTERN.test(provenanceHash))
  ) {
    throw new Error('Invalid native operation provenance hash');
  }
  const normalized = {
    kind: context.kind,
    from: normalizeAddress(context.from, 'operation sender'),
    to: normalizeAddress(context.to, 'operation target', true),
    nonce: context.nonce,
    predictedContractAddress: normalizeAddress(context.predictedContractAddress, 'predicted contract', true),
    actualTarget: normalizeAddress(context.actualTarget, 'actual target'),
    contractKind,
    artifactIdentity: validateArtifactIdentity(context.artifactIdentity, true),
    provenanceHash: provenanceHash?.toLowerCase() ?? null,
  };
  if (
    (normalized.contractKind === null) !== (normalized.artifactIdentity === null) ||
    (normalized.kind === 'deployment' && (normalized.to !== null || normalized.predictedContractAddress === null)) ||
    (normalized.kind === 'call' && (normalized.to === null || normalized.predictedContractAddress !== null))
  ) {
    throw new Error('Invalid native operation context');
  }
  return normalized;
}

function validateChildMetadata(metadata) {
  if (
    !isObject(metadata) ||
    !exactKeys(metadata, ['artifactIdentity', 'contractKind']) ||
    typeof metadata.contractKind !== 'string' ||
    !CONTRACT_KIND_PATTERN.test(metadata.contractKind)
  ) {
    throw new Error('Invalid child contract metadata');
  }
  return {
    contractKind: metadata.contractKind,
    artifactIdentity: validateArtifactIdentity(metadata.artifactIdentity),
  };
}

function validateCounterMap(value, label) {
  if (!isObject(value)) throw new Error(`Invalid child CREATE ${label}`);
  const normalized = {};
  for (const [caller, nonce] of Object.entries(value)) {
    const address = normalizeAddress(caller, 'child CREATE caller');
    if (address !== caller || typeof nonce !== 'string' || !/^[1-9][0-9]*$/.test(nonce)) {
      throw new Error(`Invalid child CREATE ${label}`);
    }
    normalized[address] = nonce;
  }
  return normalized;
}

function validateChildCreatePlan(plan) {
  if (
    !isObject(plan) ||
    !exactKeys(plan, [
      'attempts',
      'counterBases',
      'counterFinals',
      'mode',
      'sender',
      'simulationRootAddress',
      'version',
    ]) ||
    plan.version !== 1 ||
    !SIMULATION_MODES.has(plan.mode) ||
    !Array.isArray(plan.attempts)
  ) {
    throw new Error('Invalid child CREATE plan');
  }
  const counterBases = validateCounterMap(plan.counterBases, 'counter bases');
  const counterFinals = validateCounterMap(plan.counterFinals, 'counter finals');
  if (Object.keys(counterBases).sort().join(',') !== Object.keys(counterFinals).sort().join(',')) {
    throw new Error('Invalid child CREATE counter plan');
  }
  for (const caller of Object.keys(counterBases)) {
    if (BigInt(counterFinals[caller]) < BigInt(counterBases[caller])) {
      throw new Error('Invalid child CREATE counter plan');
    }
  }
  const expectedNext = Object.fromEntries(
    Object.entries(counterBases).map(([caller, nonce]) => [caller, BigInt(nonce)]),
  );
  const attempts = plan.attempts.map((attempt, index) => {
    const hasMetadata = own(attempt, 'childMetadata');
    const keys = [
      'actualCaller',
      ...(hasMetadata ? ['childMetadata'] : []),
      'index',
      'nonce',
      'predictedAddress',
      'predictedCaller',
      'simulatedActualAddress',
      'success',
    ].sort();
    if (
      !isObject(attempt) ||
      !exactKeys(attempt, keys) ||
      attempt.index !== index ||
      typeof attempt.nonce !== 'string' ||
      !/^[1-9][0-9]*$/.test(attempt.nonce) ||
      typeof attempt.success !== 'boolean'
    ) {
      throw new Error('Invalid child CREATE attempt plan');
    }
    const predictedCaller = normalizeAddress(attempt.predictedCaller, 'predicted child CREATE caller');
    if (expectedNext[predictedCaller] === undefined || BigInt(attempt.nonce) !== expectedNext[predictedCaller]) {
      throw new Error('Invalid child CREATE attempt counter');
    }
    const predictedAddress = normalizeAddress(attempt.predictedAddress, 'predicted child');
    if (
      predictedAddress !==
      getCreateAddress({ from: predictedCaller, nonce: expectedNext[predictedCaller] }).toLowerCase()
    ) {
      throw new Error('Invalid child CREATE predicted address');
    }
    expectedNext[predictedCaller] += 1n;
    return {
      index,
      actualCaller: normalizeAddress(attempt.actualCaller, 'actual child CREATE caller'),
      predictedCaller,
      nonce: attempt.nonce,
      predictedAddress,
      simulatedActualAddress: normalizeAddress(attempt.simulatedActualAddress, 'simulated child'),
      success: attempt.success,
      ...(hasMetadata ? { childMetadata: validateChildMetadata(attempt.childMetadata) } : {}),
    };
  });
  for (const [caller, next] of Object.entries(expectedNext)) {
    if (next !== BigInt(counterFinals[caller])) throw new Error('Invalid child CREATE final counter');
  }
  return {
    version: 1,
    mode: plan.mode,
    sender: normalizeAddress(plan.sender, 'child CREATE sender'),
    simulationRootAddress: normalizeAddress(plan.simulationRootAddress, 'simulation root'),
    attempts,
    counterBases,
    counterFinals,
  };
}

function validatePreparation(preparation) {
  if (!isObject(preparation) || !exactKeys(preparation, ['childCreatePlan', 'operationContext'])) {
    throw new Error('Native operation context and child CREATE plan are required');
  }
  const operationContext = validateOperationContext(preparation.operationContext);
  const childCreatePlan = validateChildCreatePlan(preparation.childCreatePlan);
  if (operationContext.from !== childCreatePlan.sender) {
    throw new Error('Native operation and child CREATE sender mismatch');
  }
  return { operationContext, childCreatePlan };
}

function validateRecord(record, expectedHash) {
  if (!isObject(record) || !STATES.has(record.state)) {
    throw new Error('Corrupt transaction journal record');
  }

  let sourceTransactionHash;
  let signedEthereumTransaction;
  try {
    sourceTransactionHash = normalizeSourceHash(record.sourceTransactionHash);
    signedEthereumTransaction = normalizeSourceTransaction(record.signedEthereumTransaction);
  } catch (error) {
    throw new Error('Corrupt transaction journal record', { cause: error });
  }
  if (
    sourceTransactionHash !== expectedHash ||
    record.sourceTransactionHash !== sourceTransactionHash ||
    record.signedEthereumTransaction !== signedEthereumTransaction ||
    keccak256(signedEthereumTransaction) !== sourceTransactionHash
  ) {
    throw new Error('Corrupt transaction journal record');
  }

  const baseKeys = ['signedEthereumTransaction', 'sourceTransactionHash', 'state'];
  if (record.state === 'received') {
    try {
      validateOwnerId(record.buildClaimOwner);
    } catch (error) {
      throw new Error('Corrupt transaction journal record', { cause: error });
    }
    if (!exactKeys(record, [...baseKeys, 'buildClaimOwner'].sort())) {
      throw new Error('Corrupt transaction journal record');
    }
    return record;
  }

  if (record.state === 'failed') {
    try {
      validateFailure(record.failure);
    } catch (error) {
      throw new Error('Corrupt transaction journal record', { cause: error });
    }
    const failedBeforeBuild = exactKeys(record, [...baseKeys, 'failure'].sort());
    const preparedFailureKeys = [
      ...baseKeys,
      'childCreatePlan',
      'failure',
      'nativeTransactionId',
      'operationContext',
      'signedNativeTransaction',
    ];
    const failedAfterBuild = exactKeys(record, preparedFailureKeys.sort());
    const failedAfterReceipt = exactKeys(record, [...preparedFailureKeys, 'receipt'].sort());
    if (!failedBeforeBuild && !failedAfterBuild && !failedAfterReceipt) {
      throw new Error('Corrupt transaction journal record');
    }
    if (failedAfterBuild || failedAfterReceipt) {
      try {
        validateNativeTransaction({
          signedNativeTransaction: record.signedNativeTransaction,
          nativeTransactionId: record.nativeTransactionId,
        });
        const normalizedPreparation = validatePreparation({
          operationContext: record.operationContext,
          childCreatePlan: record.childCreatePlan,
        });
        if (
          !isDeepStrictEqual(record.operationContext, normalizedPreparation.operationContext) ||
          !isDeepStrictEqual(record.childCreatePlan, normalizedPreparation.childCreatePlan)
        ) {
          throw new Error('noncanonical prepared operation');
        }
        if (failedAfterReceipt && !isDeepStrictEqual(record.receipt, durableReceipt(record.receipt))) {
          throw new Error('noncanonical retained receipt');
        }
      } catch (error) {
        throw new Error('Corrupt transaction journal record', { cause: error });
      }
    }
    return record;
  }

  try {
    validateNativeTransaction({
      signedNativeTransaction: record.signedNativeTransaction,
      nativeTransactionId: record.nativeTransactionId,
    });
  } catch (error) {
    throw new Error('Corrupt transaction journal record', { cause: error });
  }
  let normalizedPreparation;
  try {
    normalizedPreparation = validatePreparation({
      operationContext: record.operationContext,
      childCreatePlan: record.childCreatePlan,
    });
  } catch (error) {
    throw new Error('Corrupt transaction journal record', { cause: error });
  }
  if (
    !isDeepStrictEqual(record.operationContext, normalizedPreparation.operationContext) ||
    !isDeepStrictEqual(record.childCreatePlan, normalizedPreparation.childCreatePlan)
  ) {
    throw new Error('Corrupt transaction journal record');
  }
  const nativeKeys = [
    ...baseKeys,
    'childCreatePlan',
    'nativeTransactionId',
    'operationContext',
    'signedNativeTransaction',
  ];
  if (record.state === 'native-built' || record.state === 'broadcast') {
    if (!exactKeys(record, nativeKeys.sort())) {
      throw new Error('Corrupt transaction journal record');
    }
    return record;
  }

  if (!own(record, 'receipt') || !exactKeys(record, [...nativeKeys, 'receipt'].sort())) {
    throw new Error('Corrupt transaction journal record');
  }
  let normalizedReceipt;
  try {
    normalizedReceipt = durableReceipt(record.receipt);
  } catch (error) {
    throw new Error('Corrupt transaction journal record', { cause: error });
  }
  if (!isDeepStrictEqual(record.receipt, normalizedReceipt)) {
    throw new Error('Corrupt transaction journal record');
  }
  return record;
}

function emptyJournal() {
  return { version: JOURNAL_VERSION, records: {} };
}

function requireJournal(chain) {
  const journal = chain.transactionJournal;
  if (journal === undefined) {
    return emptyJournal();
  }
  if (
    !isObject(journal) ||
    !exactKeys(journal, ['records', 'version']) ||
    journal.version !== JOURNAL_VERSION ||
    !isObject(journal.records)
  ) {
    throw new Error('Corrupt transaction journal');
  }
  for (const [sourceTransactionHash, record] of Object.entries(journal.records)) {
    if (!TRANSACTION_HASH_PATTERN.test(sourceTransactionHash)) {
      throw new Error('Corrupt transaction journal');
    }
    validateRecord(record, sourceTransactionHash);
  }
  return journal;
}

function requireRecord(journal, sourceTransactionHash) {
  const record = journal.records[sourceTransactionHash];
  if (record === undefined) throw new Error(`Unknown source transaction ${sourceTransactionHash}`);
  return record;
}

function recordNativeBuiltInChain(chain, sourceTransactionHash, nativeTransaction, preparation, ownerId) {
  const hash = normalizeSourceHash(sourceTransactionHash);
  const native = validateNativeTransaction(nativeTransaction);
  const prepared = validatePreparation(preparation);
  const journal = requireJournal(chain);
  const record = requireRecord(journal, hash);
  if (record.state === 'native-built') {
    if (
      record.signedNativeTransaction !== native.signedNativeTransaction ||
      record.nativeTransactionId !== native.nativeTransactionId ||
      !isDeepStrictEqual(record.operationContext, prepared.operationContext) ||
      !isDeepStrictEqual(record.childCreatePlan, prepared.childCreatePlan)
    ) {
      throw new Error('Native transaction retry conflict');
    }
    return record;
  }
  if (record.state !== 'received') transitionError(record, 'native-built');
  if (record.buildClaimOwner !== validateOwnerId(ownerId)) {
    throw new Error('Native build claim is owned by another journal instance');
  }
  const next = {
    sourceTransactionHash: record.sourceTransactionHash,
    signedEthereumTransaction: record.signedEthereumTransaction,
    state: 'native-built',
    ...native,
    ...prepared,
  };
  journal.records[hash] = next;
  chain.transactionJournal = journal;
  return next;
}

function recordConfirmedInChain(chain, sourceTransactionHash, receipt) {
  const hash = normalizeSourceHash(sourceTransactionHash);
  const persistedReceipt = durableReceipt(receipt);
  const journal = requireJournal(chain);
  const record = requireRecord(journal, hash);
  if (record.state === 'confirmed') {
    if (!isDeepStrictEqual(record.receipt, persistedReceipt)) throw new Error('Confirmed receipt retry conflict');
    return record;
  }
  if (record.state !== 'broadcast') transitionError(record, 'confirmed');
  const next = { ...record, state: 'confirmed', receipt: persistedReceipt };
  journal.records[hash] = next;
  chain.transactionJournal = journal;
  return next;
}

function recordRetainedFailureInChain(chain, sourceTransactionHash, failure, receipt) {
  const hash = normalizeSourceHash(sourceTransactionHash);
  const durableFailure = validateFailure(failure);
  const persistedReceipt = durableReceipt(receipt);
  const journal = requireJournal(chain);
  const record = requireRecord(journal, hash);
  if (record.state !== 'broadcast') transitionError(record, 'failed');
  const next = { ...record, state: 'failed', failure: durableFailure, receipt: persistedReceipt };
  journal.records[hash] = next;
  chain.transactionJournal = journal;
  return next;
}

function transitionError(record, targetState) {
  throw new Error(`Illegal journal transition from ${record.state} to ${targetState}`);
}

class TransactionJournal {
  constructor(store, chainIdentity, options = {}) {
    if (
      store === null ||
      typeof store !== 'object' ||
      typeof store.transaction !== 'function' ||
      typeof store.readChain !== 'function'
    ) {
      throw new Error('A durable store is required');
    }
    if (!isObject(options)) {
      throw new Error('Invalid transaction journal options');
    }
    if (options.allowRecovery !== undefined && typeof options.allowRecovery !== 'boolean') {
      throw new Error('Invalid transaction journal recovery option');
    }
    this.store = store;
    this.chainIdentity = validateChainIdentity(chainIdentity);
    this.ownerId = validateOwnerId(options.ownerId ?? randomUUID());
    this.allowRecovery = options.allowRecovery === true;
  }

  receive(signedEthereumTransaction) {
    const source = normalizeSourceTransaction(signedEthereumTransaction);
    const sourceTransactionHash = keccak256(source);
    return this.store.transaction(this.chainIdentity, chain => {
      const journal = requireJournal(chain);
      const existing = journal.records[sourceTransactionHash];
      if (existing !== undefined) {
        if (existing.signedEthereumTransaction !== source) {
          throw new Error('Source transaction retry conflict');
        }
        if (existing.state !== 'received') {
          return { record: existing, shouldBuild: false };
        }
        return { record: existing, shouldBuild: false };
      }

      const record = {
        sourceTransactionHash,
        signedEthereumTransaction: source,
        state: 'received',
        buildClaimOwner: this.ownerId,
      };
      journal.records[sourceTransactionHash] = record;
      chain.transactionJournal = journal;
      return { record, shouldBuild: true };
    });
  }

  // Startup recovery only: the caller must hold the adapter's exclusive
  // state/server lock before using this compare-and-swap ownership transfer.
  recoverReceived(sourceTransactionHash, expectedOwnerId) {
    if (!this.allowRecovery) {
      throw new Error('Transaction journal recovery is not enabled');
    }
    const hash = normalizeSourceHash(sourceTransactionHash);
    const previousOwner = validateOwnerId(expectedOwnerId);

    return this.store.transaction(this.chainIdentity, chain => {
      const journal = requireJournal(chain);
      const record = this._requireRecord(journal, hash);
      if (record.state !== 'received') {
        throw new Error(`Transaction in ${record.state} state cannot recover a received build claim`);
      }
      if (previousOwner === this.ownerId) {
        throw new Error('Recovery owner conflict: previous and current owners must differ');
      }
      if (record.buildClaimOwner !== previousOwner) {
        throw new Error('Recovery owner conflict: persisted owner does not match expected owner');
      }

      const claimed = { ...record, buildClaimOwner: this.ownerId };
      journal.records[hash] = claimed;
      chain.transactionJournal = journal;
      return { record: claimed, shouldBuild: true };
    });
  }

  recordNativeBuilt(sourceTransactionHash, nativeTransaction, preparation) {
    return this.store.transaction(this.chainIdentity, chain =>
      recordNativeBuiltInChain(chain, sourceTransactionHash, nativeTransaction, preparation, this.ownerId),
    );
  }

  recordBroadcast(sourceTransactionHash) {
    return this._advance(sourceTransactionHash, 'native-built', 'broadcast');
  }

  recordConfirmed(sourceTransactionHash, receipt) {
    return this.store.transaction(this.chainIdentity, chain =>
      recordConfirmedInChain(chain, sourceTransactionHash, receipt),
    );
  }

  recordFailed(sourceTransactionHash, failure) {
    const hash = normalizeSourceHash(sourceTransactionHash);
    const durableFailure = validateFailure(failure);
    return this.store.transaction(this.chainIdentity, chain => {
      const journal = requireJournal(chain);
      const record = this._requireRecord(journal, hash);
      if (record.state === 'failed') {
        if (!isDeepStrictEqual(record.failure, durableFailure)) {
          throw new Error('Terminal failure retry conflict');
        }
        return record;
      }
      if (record.state === 'confirmed') {
        transitionError(record, 'failed');
      }
      if (record.state === 'received' && record.buildClaimOwner !== this.ownerId) {
        throw new Error('Native build claim is owned by another journal instance');
      }

      const next = {
        sourceTransactionHash: record.sourceTransactionHash,
        signedEthereumTransaction: record.signedEthereumTransaction,
        state: 'failed',
        ...(own(record, 'signedNativeTransaction')
          ? {
              signedNativeTransaction: record.signedNativeTransaction,
              nativeTransactionId: record.nativeTransactionId,
              operationContext: record.operationContext,
              childCreatePlan: record.childCreatePlan,
            }
          : {}),
        failure: durableFailure,
      };
      journal.records[hash] = next;
      chain.transactionJournal = journal;
      return next;
    });
  }

  get(sourceTransactionHash) {
    const hash = normalizeSourceHash(sourceTransactionHash);
    const chain = this.store.readChain(this.chainIdentity);
    if (chain === undefined) {
      return undefined;
    }
    const record = requireJournal(chain).records[hash];
    return record === undefined ? undefined : structuredClone(record);
  }

  list() {
    const chain = this.store.readChain(this.chainIdentity);
    if (chain === undefined) {
      return [];
    }
    return Object.values(requireJournal(chain).records)
      .map(record => structuredClone(record))
      .sort((left, right) => left.sourceTransactionHash.localeCompare(right.sourceTransactionHash));
  }

  _advance(sourceTransactionHash, expectedState, targetState) {
    const hash = normalizeSourceHash(sourceTransactionHash);
    return this.store.transaction(this.chainIdentity, chain => {
      const journal = requireJournal(chain);
      const record = this._requireRecord(journal, hash);
      if (record.state === targetState) {
        return record;
      }
      if (record.state !== expectedState) {
        transitionError(record, targetState);
      }

      const next = { ...record, state: targetState };
      journal.records[hash] = next;
      chain.transactionJournal = journal;
      return next;
    });
  }

  _requireRecord(journal, sourceTransactionHash) {
    return requireRecord(journal, sourceTransactionHash);
  }
}

module.exports = {
  JOURNAL_VERSION,
  TransactionJournal,
  recordConfirmedInChain,
  recordNativeBuiltInChain,
  recordRetainedFailureInChain,
  requireJournal,
  validateChildCreatePlan,
  validateOperationContext,
};
