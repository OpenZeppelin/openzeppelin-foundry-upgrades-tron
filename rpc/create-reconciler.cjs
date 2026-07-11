'use strict';

const { getCreateAddress } = require('ethers');

const { toEvmAddress } = require('./address-codec.cjs');
const {
  requireIndexes,
  resolveContractMetadataInChain,
  setContractMetadataInChain,
  setMappingInChain,
} = require('./address-map.cjs');
const {
  recordConfirmedInChain,
  recordNativeBuiltInChain,
  recordRetainedFailureInChain,
  requireJournal,
  validateOperationContext,
} = require('./journal.cjs');
const { internalCreateTransactions } = require('./receipts.cjs');

const RECONCILIATION_VERSION = 1;
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;
const TRANSPARENT_PROXY_SUFFIX =
  'openzeppelin-tron-solidity/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy';
const TRANSPARENT_PROXY_FILE = 'TransparentUpgradeableProxy.sol';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAddress(value, label, allowZero = false) {
  let address;
  try {
    address = toEvmAddress(value);
  } catch (error) {
    throw new CreateReconciliationError('INVALID_CHILD_CREATE_TRACE', `Invalid ${label} address`, { cause: error });
  }
  if (!allowZero && address === ZERO_ADDRESS) {
    throw new CreateReconciliationError('INVALID_CHILD_CREATE_TRACE', `Invalid ${label} address`);
  }
  return address;
}

class CreateReconciliationError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'CreateReconciliationError';
    this.code = code;
  }
}

function emptyReconciliation() {
  return { version: RECONCILIATION_VERSION, nextNonceByCaller: {} };
}

function requireReconciliation(chain) {
  const state = chain.childCreateReconciliation;
  if (state === undefined) return emptyReconciliation();
  if (
    !isObject(state) ||
    Object.keys(state).sort().join(',') !== 'nextNonceByCaller,version' ||
    state.version !== RECONCILIATION_VERSION ||
    !isObject(state.nextNonceByCaller)
  ) {
    throw new Error('Corrupt child CREATE reconciliation state');
  }
  for (const [caller, nonce] of Object.entries(state.nextNonceByCaller)) {
    if (
      normalizeAddress(caller, 'persisted child CREATE caller') !== caller ||
      typeof nonce !== 'string' ||
      !/^[1-9][0-9]*$/.test(nonce)
    ) {
      throw new Error('Corrupt child CREATE reconciliation counter');
    }
  }
  return state;
}

function contractMetadata(kind, identity) {
  return kind === null || identity === null ? undefined : { contractKind: kind, artifactIdentity: identity };
}

function proxyAdminMetadata(callerMetadata) {
  if (
    callerMetadata?.contractKind === 'transparent-proxy' ||
    callerMetadata?.artifactIdentity?.fullyQualifiedName?.endsWith(TRANSPARENT_PROXY_SUFFIX)
  ) {
    const callerIdentity = callerMetadata.artifactIdentity;
    if (!callerIdentity.sourceName.endsWith(TRANSPARENT_PROXY_FILE)) {
      throw new CreateReconciliationError(
        'INVALID_TRANSPARENT_PROXY_METADATA',
        'Transparent proxy artifact identity cannot derive its ProxyAdmin child',
      );
    }
    const sourceName = `${callerIdentity.sourceName.slice(0, -TRANSPARENT_PROXY_FILE.length)}ProxyAdmin.sol`;
    return {
      contractKind: 'proxy-admin',
      artifactIdentity: {
        sourceName,
        contractName: 'ProxyAdmin',
        fullyQualifiedName: `${sourceName}:ProxyAdmin`,
      },
    };
  }
  return undefined;
}

function assertChildMappingAvailable(chain, indexes, predictedAddress, actualAddress, childMetadata) {
  const existingPredicted = indexes.byPredicted[predictedAddress];
  const existingActual = indexes.byActual[actualAddress];
  if (existingPredicted !== undefined && childMetadata !== undefined) {
    const existingMetadata = resolveContractMetadataInChain(chain, predictedAddress);
    if (
      existingMetadata !== undefined &&
      (existingMetadata.contractKind !== childMetadata.contractKind ||
        JSON.stringify(existingMetadata.artifactIdentity) !== JSON.stringify(childMetadata.artifactIdentity))
    ) {
      throw new CreateReconciliationError(
        'CHILD_CREATE_SIMULATION_CONFLICT',
        `Simulated child metadata conflicts with ${predictedAddress}`,
      );
    }
  }
  if (existingPredicted !== undefined || existingActual !== undefined) {
    throw new CreateReconciliationError(
      'CHILD_CREATE_SIMULATION_CONFLICT',
      `Simulated child mapping conflicts with persisted address state for ${predictedAddress}`,
    );
  }
}

function validateSimulation(simulation, nativeTransactionId) {
  if (!isObject(simulation) || simulation.traceComplete !== true || !Array.isArray(simulation.childCreateAttempts)) {
    throw new CreateReconciliationError(
      'SIMULATION_INCOMPLETE',
      'Exact simulation did not provide a complete child CREATE trace',
    );
  }
  if (
    typeof simulation.nativeTransactionId !== 'string' ||
    simulation.nativeTransactionId.replace(/^0x/i, '').toLowerCase() !==
      nativeTransactionId.replace(/^0x/i, '').toLowerCase()
  ) {
    throw new CreateReconciliationError(
      'SIMULATION_TRANSACTION_MISMATCH',
      'Exact simulation transaction ID does not match the signed native transaction',
    );
  }
  return simulation.childCreateAttempts;
}

function derivePlan(chain, simulation, rawOperationContext, nativeTransactionId) {
  const operationContext = validateOperationContext(rawOperationContext);
  const attempts = validateSimulation(simulation, nativeTransactionId);
  const indexes = requireIndexes(chain);
  const reconciliation = requireReconciliation(chain);
  const provisional = new Map();

  const addCaller = (actual, predicted, metadata) => {
    const normalizedActual = normalizeAddress(actual, 'actual caller');
    const normalizedPredicted = normalizeAddress(predicted, 'predicted caller');
    const existing = provisional.get(normalizedActual);
    if (existing !== undefined && existing.predicted !== normalizedPredicted) {
      throw new CreateReconciliationError('CHILD_CREATE_CALLER_CONFLICT', 'Conflicting provisional caller mapping');
    }
    provisional.set(normalizedActual, { predicted: normalizedPredicted, metadata });
  };

  addCaller(operationContext.from, operationContext.from);
  const operationMetadata = contractMetadata(operationContext.contractKind, operationContext.artifactIdentity);
  addCaller(
    operationContext.actualTarget,
    operationContext.kind === 'deployment' ? operationContext.predictedContractAddress : operationContext.to,
    operationMetadata,
  );

  const resolveCaller = actual => {
    const local = provisional.get(actual);
    if (local !== undefined) return local;
    const persistedPredicted = indexes.byActual[actual];
    const directPredicted = indexes.byPredicted[actual] === undefined ? undefined : actual;
    const predicted = persistedPredicted ?? directPredicted;
    if (predicted === undefined) {
      throw new CreateReconciliationError(
        'CHILD_CREATE_CALLER_UNMAPPED',
        `Cannot reverse-resolve child CREATE caller ${actual}`,
      );
    }
    return { predicted, metadata: resolveContractMetadataInChain(chain, predicted) };
  };

  const nextByCaller = new Map();
  const counterBases = {};
  const plannedAttempts = attempts.map((rawAttempt, index) => {
    if (!isObject(rawAttempt) || typeof rawAttempt.success !== 'boolean') {
      throw new CreateReconciliationError('INVALID_CHILD_CREATE_TRACE', `Invalid child CREATE attempt ${index}`);
    }
    if (rawAttempt.index !== undefined && rawAttempt.index !== index) {
      throw new CreateReconciliationError('INVALID_CHILD_CREATE_TRACE', 'Child CREATE attempt order is invalid');
    }
    const actualCaller = normalizeAddress(rawAttempt.callerAddress, 'child CREATE caller');
    const simulatedActualAddress = normalizeAddress(
      rawAttempt.createdAddress,
      'simulated child CREATE',
      !rawAttempt.success,
    );
    const caller = resolveCaller(actualCaller);
    const base = reconciliation.nextNonceByCaller[caller.predicted] ?? '1';
    if (!nextByCaller.has(caller.predicted)) {
      nextByCaller.set(caller.predicted, BigInt(base));
      counterBases[caller.predicted] = base;
    }
    const nonce = nextByCaller.get(caller.predicted);
    nextByCaller.set(caller.predicted, nonce + 1n);
    const predictedAddress = getCreateAddress({ from: caller.predicted, nonce }).toLowerCase();
    const childMetadata = rawAttempt.success ? proxyAdminMetadata(caller.metadata) : undefined;
    if (rawAttempt.success) {
      assertChildMappingAvailable(chain, indexes, predictedAddress, simulatedActualAddress, childMetadata);
      addCaller(simulatedActualAddress, predictedAddress, childMetadata);
    }
    return {
      index,
      actualCaller,
      predictedCaller: caller.predicted,
      nonce: nonce.toString(),
      predictedAddress,
      simulatedActualAddress,
      success: rawAttempt.success,
      ...(childMetadata === undefined ? {} : { childMetadata }),
    };
  });
  const counterFinals = Object.fromEntries(
    [...nextByCaller.entries()].map(([caller, next]) => [caller, next.toString()]),
  );
  return {
    operationContext,
    childCreatePlan: {
      version: RECONCILIATION_VERSION,
      sender: operationContext.from,
      attempts: plannedAttempts,
      counterBases,
      counterFinals,
    },
  };
}

function receiptCreations(receipt, nativeTransactionId) {
  if (!isObject(receipt) || !isObject(receipt.tron)) {
    throw new CreateReconciliationError('CHILD_CREATE_MISMATCH', 'Confirmed receipt has no internal transaction list');
  }
  const receiptTxId = receipt.tron.nativeTransactionId;
  if (
    typeof receiptTxId !== 'string' ||
    receiptTxId.replace(/^0x/i, '').toLowerCase() !== nativeTransactionId.replace(/^0x/i, '').toLowerCase()
  ) {
    throw new CreateReconciliationError('CHILD_CREATE_MISMATCH', 'Confirmed receipt native transaction ID mismatch');
  }
  let internalCreations;
  try {
    internalCreations = internalCreateTransactions(receipt);
  } catch (error) {
    throw new CreateReconciliationError('CHILD_CREATE_MISMATCH', error.message, { cause: error });
  }
  return internalCreations.map((transaction, index) => ({
    index,
    callerAddress: normalizeAddress(transaction.callerAddress, 'receipt internal caller'),
    actualAddress: normalizeAddress(transaction.transferToAddress, 'receipt internal creation'),
  }));
}

function normalizeReceiptHash(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) {
    throw new CreateReconciliationError('TOP_LEVEL_RECEIPT_MISMATCH', 'Receipt source transaction hash is invalid');
  }
  return value.toLowerCase();
}

function assertTopLevelReceipt(record, receipt) {
  if (!isObject(receipt) || !isObject(receipt.tron)) {
    throw new CreateReconciliationError('TOP_LEVEL_RECEIPT_MISMATCH', 'Confirmed receipt shape is invalid');
  }
  let from;
  try {
    from = toEvmAddress(receipt.from);
  } catch (error) {
    throw new CreateReconciliationError('TOP_LEVEL_RECEIPT_MISMATCH', 'Confirmed receipt sender is invalid', {
      cause: error,
    });
  }
  const context = record.operationContext;
  if (normalizeReceiptHash(receipt.transactionHash) !== record.sourceTransactionHash || from !== context.from) {
    throw new CreateReconciliationError(
      'TOP_LEVEL_RECEIPT_MISMATCH',
      'Confirmed receipt does not match its source transaction and sender',
    );
  }
  if (context.kind === 'deployment') {
    let predictedContractAddress;
    let actualContractAddress;
    try {
      predictedContractAddress = toEvmAddress(receipt.contractAddress);
      actualContractAddress = toEvmAddress(receipt.tron.actualContractAddress);
    } catch (error) {
      throw new CreateReconciliationError(
        'TOP_LEVEL_RECEIPT_MISMATCH',
        'Confirmed deployment receipt addresses are invalid',
        { cause: error },
      );
    }
    if (
      receipt.to !== null ||
      predictedContractAddress !== context.predictedContractAddress ||
      actualContractAddress !== context.actualTarget
    ) {
      throw new CreateReconciliationError(
        'TOP_LEVEL_RECEIPT_MISMATCH',
        'Confirmed deployment receipt does not match its predicted and actual addresses',
      );
    }
    return;
  }

  let to;
  try {
    to = toEvmAddress(receipt.to);
  } catch (error) {
    throw new CreateReconciliationError('TOP_LEVEL_RECEIPT_MISMATCH', 'Confirmed call target is invalid', {
      cause: error,
    });
  }
  if (to !== context.to || receipt.contractAddress !== null || receipt.tron.actualContractAddress !== null) {
    throw new CreateReconciliationError(
      'TOP_LEVEL_RECEIPT_MISMATCH',
      'Confirmed call receipt does not match its target',
    );
  }
}

function rewriteInternalCreations(receipt, actualToPredicted) {
  const persisted = structuredClone(receipt);
  persisted.tron.internalTransactions = persisted.tron.internalTransactions.map(transaction => ({
    ...transaction,
    callerAddress: actualToPredicted.get(transaction.callerAddress) ?? transaction.callerAddress,
    transferToAddress: actualToPredicted.get(transaction.transferToAddress) ?? transaction.transferToAddress,
  }));
  return persisted;
}

class CreateReconciler {
  constructor(journal, addressMap) {
    if (
      !isObject(journal) ||
      !isObject(addressMap) ||
      journal.store === undefined ||
      journal.store !== addressMap.store ||
      journal.chainIdentity !== addressMap.chainIdentity
    ) {
      throw new Error('Create reconciler requires a journal and address map sharing one durable store');
    }
    this.journal = journal;
    this.addressMap = addressMap;
    this.store = journal.store;
    this.chainIdentity = journal.chainIdentity;
  }

  recordPreparedNative(sourceTransactionHash, nativeTransaction, simulation, operationContext) {
    let preparation;
    try {
      return this.store.transaction(this.chainIdentity, chain => {
        preparation = derivePlan(chain, simulation, operationContext, nativeTransaction.nativeTransactionId);
        return recordNativeBuiltInChain(
          chain,
          sourceTransactionHash,
          nativeTransaction,
          preparation,
          this.journal.ownerId,
        );
      });
    } catch (error) {
      const failure =
        error instanceof CreateReconciliationError
          ? error
          : new CreateReconciliationError('CHILD_CREATE_PREFLIGHT_FAILED', error.message, { cause: error });
      if (this.journal.get(sourceTransactionHash)?.state === 'received') {
        this.journal.recordFailed(sourceTransactionHash, { code: failure.code, message: failure.message });
      }
      throw failure;
    }
  }

  reconcile(sourceTransactionHash, receipt) {
    const existing = this.journal.get(sourceTransactionHash);
    if (existing?.state === 'confirmed') return existing;
    if (existing?.state === 'failed') {
      throw new CreateReconciliationError(existing.failure.code, existing.failure.message);
    }
    try {
      return this.store.transaction(this.chainIdentity, chain => {
        const journal = requireJournal(chain);
        const record = journal.records[sourceTransactionHash.toLowerCase()];
        if (record === undefined) throw new Error(`Unknown source transaction ${sourceTransactionHash}`);
        if (record.state !== 'broadcast') {
          throw new CreateReconciliationError(
            'CHILD_CREATE_STATE_MISMATCH',
            `Transaction in ${record.state} state cannot reconcile a receipt`,
          );
        }
        assertTopLevelReceipt(record, receipt);
        const successful = record.childCreatePlan.attempts.filter(attempt => attempt.success);
        const creations = receiptCreations(receipt, record.nativeTransactionId);
        if (successful.length !== creations.length) {
          throw new CreateReconciliationError(
            'CHILD_CREATE_MISMATCH',
            `Simulation expected ${successful.length} internal creations but receipt contained ${creations.length}`,
          );
        }
        for (let index = 0; index < successful.length; index += 1) {
          if (
            successful[index].actualCaller !== creations[index].callerAddress ||
            successful[index].simulatedActualAddress !== creations[index].actualAddress
          ) {
            throw new CreateReconciliationError(
              'CHILD_CREATE_MISMATCH',
              `Receipt internal creation order differs at successful attempt ${index}`,
            );
          }
        }

        const reconciliation = requireReconciliation(chain);
        for (const [caller, base] of Object.entries(record.childCreatePlan.counterBases)) {
          if ((reconciliation.nextNonceByCaller[caller] ?? '1') !== base) {
            throw new CreateReconciliationError(
              'CHILD_CREATE_COUNTER_CONFLICT',
              `Child CREATE counter changed for ${caller}`,
            );
          }
        }

        const actualToPredicted = new Map();
        if (record.operationContext.kind === 'deployment') {
          setMappingInChain(chain, {
            predicted: record.operationContext.predictedContractAddress,
            actual: record.operationContext.actualTarget,
            creator: record.operationContext.from,
            sender: record.operationContext.from,
            sourceTransaction: record.sourceTransactionHash,
          });
          actualToPredicted.set(record.operationContext.actualTarget, record.operationContext.predictedContractAddress);
          if (record.operationContext.contractKind !== null) {
            setContractMetadataInChain(chain, {
              predicted: record.operationContext.predictedContractAddress,
              contractKind: record.operationContext.contractKind,
              artifactIdentity: record.operationContext.artifactIdentity,
              sourceTransaction: record.sourceTransactionHash,
            });
          }
        }
        for (let index = 0; index < successful.length; index += 1) {
          const planned = successful[index];
          const creation = creations[index];
          setMappingInChain(chain, {
            predicted: planned.predictedAddress,
            actual: creation.actualAddress,
            creator: planned.predictedCaller,
            sender: record.childCreatePlan.sender,
            sourceTransaction: record.sourceTransactionHash,
          });
          actualToPredicted.set(creation.actualAddress, planned.predictedAddress);
          if (planned.childMetadata !== undefined) {
            setContractMetadataInChain(chain, {
              predicted: planned.predictedAddress,
              ...planned.childMetadata,
              sourceTransaction: record.sourceTransactionHash,
            });
          }
        }
        for (const [caller, next] of Object.entries(record.childCreatePlan.counterFinals)) {
          reconciliation.nextNonceByCaller[caller] = next;
        }
        chain.childCreateReconciliation = reconciliation;
        const persistedReceipt = rewriteInternalCreations(receipt, actualToPredicted);
        return recordConfirmedInChain(chain, sourceTransactionHash, persistedReceipt);
      });
    } catch (error) {
      let failure;
      if (error instanceof CreateReconciliationError) {
        failure = error;
      } else if (/mapping|metadata.*conflict|conflict/i.test(error.message)) {
        failure = new CreateReconciliationError('CHILD_CREATE_CONFLICT', error.message, { cause: error });
      } else {
        failure = new CreateReconciliationError('CHILD_CREATE_RECONCILIATION_FAILED', error.message, {
          cause: error,
        });
      }
      this.store.transaction(this.chainIdentity, chain =>
        recordRetainedFailureInChain(
          chain,
          sourceTransactionHash,
          { code: failure.code, message: failure.message },
          receipt,
        ),
      );
      throw failure;
    }
  }

  nextNonce(predictedCaller) {
    const caller = normalizeAddress(predictedCaller, 'predicted caller');
    const chain = this.store.readChain(this.chainIdentity);
    if (chain === undefined) return 1n;
    return BigInt(requireReconciliation(chain).nextNonceByCaller[caller] ?? '1');
  }
}

module.exports = {
  CreateReconciler,
  CreateReconciliationError,
  RECONCILIATION_VERSION,
};
