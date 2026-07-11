const { toEvmAddress } = require('./address-codec.cjs');

const HASH_PATTERN = /^(?:0x)?[0-9a-f]{64}$/i;
const SOURCE_HASH_PATTERN = /^0x[0-9a-f]{64}$/i;
const ZERO_BLOOM = `0x${'00'.repeat(256)}`;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeHash(value, label) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return `0x${value.replace(/^0x/i, '').toLowerCase()}`;
}

function toBigInt(value, label, fallback = 0n) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}`);
    return BigInt(value);
  }
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error(`Invalid ${label}`);
    return value;
  }
  if (typeof value === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error(`Invalid ${label}`);
    return parsed;
  }
  throw new Error(`Invalid ${label}`);
}

function quantity(value, label, fallback = 0n) {
  return `0x${toBigInt(value, label, fallback).toString(16)}`;
}

function normalizeData(value, label) {
  if (value === undefined || value === null || value === '') return '0x';
  if (typeof value !== 'string' || !/^(?:0x)?(?:[0-9a-f]{2})*$/i.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return `0x${value.replace(/^0x/i, '').toLowerCase()}`;
}

function resolvedAddress(address, resolveAddress) {
  const evm = toEvmAddress(address);
  return toEvmAddress(resolveAddress?.(evm) ?? evm);
}

function decodeResultMessage(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(value)) {
    throw new Error('Invalid native result message');
  }
  return Buffer.from(value, 'hex').toString('utf8');
}

function decodeInternalNote(value) {
  if (typeof value !== 'string') return '';
  if (/^(?:[0-9a-f]{2})+$/i.test(value)) return Buffer.from(value, 'hex').toString('utf8');
  return value;
}

function contractData(transaction) {
  const contract = transaction?.raw_data?.contract?.[0];
  if (!isObject(contract) || !isObject(contract.parameter) || !isObject(contract.parameter.value)) {
    throw new Error('Invalid native transaction contract');
  }
  return { type: contract.type, value: contract.parameter.value };
}

function translateInternalTransaction(transaction, resolveAddress) {
  if (!isObject(transaction)) throw new Error('Invalid native internal transaction');
  if (transaction.rejected !== undefined && typeof transaction.rejected !== 'boolean') {
    throw new Error('Invalid native internal transaction rejected marker');
  }
  return {
    hash: normalizeHash(transaction.hash, 'internal transaction hash'),
    callerAddress: resolvedAddress(transaction.caller_address, resolveAddress),
    transferToAddress: resolvedAddress(transaction.transferTo_address, resolveAddress),
    note: decodeInternalNote(transaction.note),
    rejected: transaction.rejected === true,
    callValueInfo: Array.isArray(transaction.callValueInfo) ? structuredClone(transaction.callValueInfo) : [],
  };
}

function internalCreateAttempts(receipt) {
  if (!isObject(receipt?.tron) || !Array.isArray(receipt.tron.internalTransactions)) {
    throw new Error('Confirmed receipt has no internal transaction list');
  }
  return receipt.tron.internalTransactions.filter(
    transaction =>
      isObject(transaction) && typeof transaction.note === 'string' && transaction.note.toLowerCase() === 'create',
  );
}

function internalCreateTransactions(receipt) {
  return internalCreateAttempts(receipt).filter(transaction => transaction.rejected !== true);
}

function translateReceipt(snapshot, context = {}) {
  if (!isObject(snapshot) || !isObject(snapshot.transaction) || !isObject(snapshot.info)) {
    throw new Error('A confirmed native receipt is required');
  }
  if (typeof context.sourceTransactionHash !== 'string' || !SOURCE_HASH_PATTERN.test(context.sourceTransactionHash)) {
    throw new Error('Invalid source transaction hash');
  }

  const transaction = snapshot.transaction;
  const info = snapshot.info;
  const nativeTransactionId = normalizeHash(info.id, 'native transaction id').slice(2);
  if (
    transaction.txID !== undefined &&
    normalizeHash(transaction.txID, 'native transaction id').slice(2) !== nativeTransactionId
  ) {
    throw new Error('Native transaction ID mismatch');
  }

  const blockNumber = quantity(info.blockNumber, 'block number');
  const blockHash = normalizeHash(info.blockHash, 'block hash');
  const nativeTransactionIndex = info.transactionIndex ?? info.transaction_index;
  if (nativeTransactionIndex === undefined || nativeTransactionIndex === null) {
    throw new Error('Invalid transaction index');
  }
  const transactionIndex = quantity(nativeTransactionIndex, 'transaction index');
  const { type: contractType, value: nativeContract } = contractData(transaction);
  const resolveAddress = typeof context.resolveAddress === 'function' ? context.resolveAddress : undefined;
  const resolveInternalAddress =
    typeof context.resolveInternalAddress === 'function' ? context.resolveInternalAddress : resolveAddress;
  const from = resolvedAddress(nativeContract.owner_address, resolveAddress);
  const isCreation = contractType === 'CreateSmartContract';
  const to = isCreation ? null : resolvedAddress(nativeContract.contract_address, resolveAddress);

  const energyUsage = toBigInt(info.receipt?.energy_usage_total, 'energy usage');
  const energyFee = toBigInt(info.receipt?.energy_fee, 'energy fee');
  const netFee = toBigInt(info.receipt?.net_fee, 'network fee');
  const fee = toBigInt(info.fee, 'fee');
  const priceNumerator = energyFee > 0n ? energyFee : fee;
  const effectiveGasPrice = energyUsage === 0n ? 0n : (priceNumerator + energyUsage - 1n) / energyUsage;
  const result = info.receipt?.result ?? transaction.ret?.[0]?.contractRet;
  if (typeof result !== 'string' || result.length === 0) throw new Error('Invalid native receipt result');

  let actualContractAddress = null;
  if (info.contract_address !== undefined && info.contract_address !== null && info.contract_address !== '') {
    actualContractAddress = toEvmAddress(info.contract_address);
  }
  const contractAddress = isCreation
    ? context.predictedContractAddress === undefined
      ? actualContractAddress
      : toEvmAddress(context.predictedContractAddress)
    : null;

  const logs = (info.log ?? []).map((log, index) => {
    if (!isObject(log) || !Array.isArray(log.topics)) throw new Error('Invalid native receipt log');
    return {
      address: resolvedAddress(log.address, resolveAddress),
      topics: log.topics.map(topic => normalizeHash(topic, 'log topic')),
      data: normalizeData(log.data, 'log data'),
      blockNumber,
      transactionHash: context.sourceTransactionHash.toLowerCase(),
      transactionIndex,
      blockHash,
      logIndex: quantity(index, 'log index'),
      removed: false,
    };
  });

  const internalTransactions = (info.internal_transactions ?? []).map(transaction =>
    translateInternalTransaction(transaction, resolveInternalAddress),
  );

  return {
    transactionHash: context.sourceTransactionHash.toLowerCase(),
    transactionIndex,
    blockHash,
    blockNumber,
    from,
    to,
    cumulativeGasUsed: `0x${energyUsage.toString(16)}`,
    gasUsed: `0x${energyUsage.toString(16)}`,
    contractAddress,
    logs,
    logsBloom: ZERO_BLOOM,
    status: result === 'SUCCESS' ? '0x1' : '0x0',
    type: '0x0',
    effectiveGasPrice: `0x${effectiveGasPrice.toString(16)}`,
    tron: {
      nativeTransactionId,
      actualContractAddress,
      energyUsageTotal: `0x${energyUsage.toString(16)}`,
      energyFee: `0x${energyFee.toString(16)}`,
      netFee: `0x${netFee.toString(16)}`,
      fee: `0x${fee.toString(16)}`,
      blockTimestamp: quantity(info.blockTimeStamp, 'block timestamp'),
      result,
      resultMessage: decodeResultMessage(info.resMessage),
      internalTransactions,
    },
  };
}

module.exports = {
  internalCreateAttempts,
  internalCreateTransactions,
  translateReceipt,
};
