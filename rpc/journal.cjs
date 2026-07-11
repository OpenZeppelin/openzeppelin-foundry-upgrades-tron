const { isDeepStrictEqual } = require('node:util');
const { randomUUID } = require('node:crypto');

const { keccak256 } = require('ethers');

const { validateChainIdentity } = require('./store.cjs');

const JOURNAL_VERSION = 1;
const TRANSACTION_HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const NATIVE_TRANSACTION_ID_PATTERN = /^(?:0x)?[0-9a-fA-F]{64}$/;
const HEX_BYTES_PATTERN = /^(?:0x)?(?:[0-9a-fA-F]{2})+$/;
const OWNER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STATES = new Set(['received', 'native-built', 'broadcast', 'confirmed', 'failed']);

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
    const failedAfterBuild = exactKeys(
      record,
      [...baseKeys, 'failure', 'nativeTransactionId', 'signedNativeTransaction'].sort(),
    );
    if (!failedBeforeBuild && !failedAfterBuild) {
      throw new Error('Corrupt transaction journal record');
    }
    if (failedAfterBuild) {
      try {
        validateNativeTransaction({
          signedNativeTransaction: record.signedNativeTransaction,
          nativeTransactionId: record.nativeTransactionId,
        });
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
  const nativeKeys = [...baseKeys, 'nativeTransactionId', 'signedNativeTransaction'];
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
  if (!isObject(journal) || journal.version !== JOURNAL_VERSION || !isObject(journal.records)) {
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
    this.store = store;
    this.chainIdentity = validateChainIdentity(chainIdentity);
    this.ownerId = validateOwnerId(options.ownerId ?? randomUUID());
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
        if (existing.buildClaimOwner === this.ownerId) {
          return { record: existing, shouldBuild: false };
        }

        const claimed = { ...existing, buildClaimOwner: this.ownerId };
        journal.records[sourceTransactionHash] = claimed;
        chain.transactionJournal = journal;
        return { record: claimed, shouldBuild: true };
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

  recordNativeBuilt(sourceTransactionHash, nativeTransaction) {
    const hash = normalizeSourceHash(sourceTransactionHash);
    const native = validateNativeTransaction(nativeTransaction);
    return this.store.transaction(this.chainIdentity, chain => {
      const journal = requireJournal(chain);
      const record = this._requireRecord(journal, hash);
      if (record.state === 'native-built') {
        if (
          record.signedNativeTransaction !== native.signedNativeTransaction ||
          record.nativeTransactionId !== native.nativeTransactionId
        ) {
          throw new Error('Native transaction retry conflict');
        }
        return record;
      }
      if (record.state !== 'received') {
        transitionError(record, 'native-built');
      }
      if (record.buildClaimOwner !== this.ownerId) {
        throw new Error('Native build claim is owned by another journal instance');
      }

      const next = {
        sourceTransactionHash: record.sourceTransactionHash,
        signedEthereumTransaction: record.signedEthereumTransaction,
        state: 'native-built',
        ...native,
      };
      journal.records[hash] = next;
      chain.transactionJournal = journal;
      return next;
    });
  }

  recordBroadcast(sourceTransactionHash) {
    return this._advance(sourceTransactionHash, 'native-built', 'broadcast');
  }

  recordConfirmed(sourceTransactionHash, receipt) {
    const hash = normalizeSourceHash(sourceTransactionHash);
    const persistedReceipt = durableReceipt(receipt);
    return this.store.transaction(this.chainIdentity, chain => {
      const journal = requireJournal(chain);
      const record = this._requireRecord(journal, hash);
      if (record.state === 'confirmed') {
        if (!isDeepStrictEqual(record.receipt, persistedReceipt)) {
          throw new Error('Confirmed receipt retry conflict');
        }
        return record;
      }
      if (record.state !== 'broadcast') {
        transitionError(record, 'confirmed');
      }

      const next = { ...record, state: 'confirmed', receipt: persistedReceipt };
      journal.records[hash] = next;
      chain.transactionJournal = journal;
      return next;
    });
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
    const record = journal.records[sourceTransactionHash];
    if (record === undefined) {
      throw new Error(`Unknown source transaction ${sourceTransactionHash}`);
    }
    return record;
  }
}

module.exports = {
  JOURNAL_VERSION,
  TransactionJournal,
};
