import { decodeInternalTransactionNote } from '@openzeppelin/tron-runtime';

import { toEvmAddress } from './address-codec.js';

const HASH_PATTERN = /^(?:0x)?[0-9a-f]{64}$/i;
const SOURCE_HASH_PATTERN = /^0x[0-9a-f]{64}$/i;
const ZERO_BLOOM = `0x${'00'.repeat(256)}`;

// A native TRON transaction/receipt snapshot is external, dynamically-shaped JSON with no
// canonical type in this codebase (its shape also varies between deployment/call receipts, and
// the consumer-supplied internal-transaction-like fixtures accepted by `internalCreateAttempts`/
// `internalCreateTransactions`). `any` is used deliberately throughout this module for that
// content, matching its original untyped JS handling.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonAny = any;

/** Options accepted by {@link translateReceipt}. */
export interface TranslateReceiptContext {
  sourceTransactionHash?: string;
  predictedContractAddress?: string;
  resolveAddress?: (address: string) => string | undefined;
  resolveInternalAddress?: (address: string) => string | undefined;
}

/** One normalized native internal transaction, as embedded in {@link TranslatedReceipt}. */
export interface TranslatedInternalTransaction {
  hash: string;
  callerAddress: string;
  transferToAddress: string;
  note: string | null;
  rejected: boolean;
  callValueInfo: unknown[];
}

/** One normalized Ethereum-shaped log entry, as embedded in {@link TranslatedReceipt}. */
export interface TranslatedLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  transactionIndex: string;
  blockHash: string;
  logIndex: string;
  removed: false;
}

/** TRON-specific fields embedded in {@link TranslatedReceipt}. */
export interface TranslatedReceiptTron {
  nativeTransactionId: string;
  actualContractAddress: string | null;
  energyUsageTotal: string;
  energyFee: string;
  netFee: string;
  fee: string;
  blockTimestamp: string;
  result: string;
  resultMessage: string | null;
  internalTransactions: TranslatedInternalTransaction[];
}

/** The shape returned by a successful {@link translateReceipt} call. */
export interface TranslatedReceipt {
  transactionHash: string;
  transactionIndex: string;
  blockHash: string;
  blockNumber: string;
  from: string;
  to: string | null;
  cumulativeGasUsed: string;
  gasUsed: string;
  contractAddress: string | null;
  logs: TranslatedLog[];
  logsBloom: string;
  status: '0x1' | '0x0';
  type: '0x0';
  effectiveGasPrice: string;
  tron: TranslatedReceiptTron;
}

function isObject(value: unknown): value is Record<string, JsonAny> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeHash(value: JsonAny, label: string): string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return `0x${value.replace(/^0x/i, '').toLowerCase()}`;
}

function toBigInt(value: JsonAny, label: string, fallback = 0n): bigint {
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

function quantity(value: JsonAny, label: string, fallback = 0n): string {
  return `0x${toBigInt(value, label, fallback).toString(16)}`;
}

function normalizeData(value: JsonAny, label: string): string {
  if (value === undefined || value === null || value === '') return '0x';
  if (typeof value !== 'string' || !/^(?:0x)?(?:[0-9a-f]{2})*$/i.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return `0x${value.replace(/^0x/i, '').toLowerCase()}`;
}

function resolvedAddress(address: JsonAny, resolveAddress?: (address: string) => string | undefined): string {
  const evm = toEvmAddress(address);
  return toEvmAddress(resolveAddress?.(evm) ?? evm);
}

function decodeResultMessage(value: JsonAny): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(value)) {
    throw new Error('Invalid native result message');
  }
  return Buffer.from(value, 'hex').toString('utf8');
}

function contractData(transaction: JsonAny): { type: JsonAny; value: JsonAny } {
  const contract = transaction?.raw_data?.contract?.[0];
  if (!isObject(contract) || !isObject(contract.parameter) || !isObject(contract.parameter.value)) {
    throw new Error('Invalid native transaction contract');
  }
  return { type: contract.type, value: contract.parameter.value };
}

function translateInternalTransaction(
  transaction: JsonAny,
  resolveAddress?: (address: string) => string | undefined,
): TranslatedInternalTransaction {
  if (!isObject(transaction)) throw new Error('Invalid native internal transaction');
  if (transaction.rejected !== undefined && typeof transaction.rejected !== 'boolean') {
    throw new Error('Invalid native internal transaction rejected marker');
  }
  return {
    hash: normalizeHash(transaction.hash, 'internal transaction hash'),
    callerAddress: resolvedAddress(transaction.caller_address, resolveAddress),
    transferToAddress: resolvedAddress(transaction.transferTo_address, resolveAddress),
    note: decodeInternalTransactionNote(transaction.note),
    rejected: transaction.rejected === true,
    callValueInfo: Array.isArray(transaction.callValueInfo) ? structuredClone(transaction.callValueInfo) : [],
  };
}

function internalCreateAttempts(receipt: JsonAny): JsonAny[] {
  if (!isObject(receipt?.tron) || !Array.isArray(receipt.tron.internalTransactions)) {
    throw new Error('Confirmed receipt has no internal transaction list');
  }
  // Classify fail-closed: the wrapper stores the runtime-decoded note (a string, or
  // null when the raw note was absent/malformed). A missing or malformed note is rejected
  // instead of being silently treated as a non-CREATE, which would hide an unaccounted child.
  return receipt.tron.internalTransactions.filter((transaction: JsonAny, index: number) => {
    if (!isObject(transaction)) {
      throw new Error(`Confirmed receipt internal transaction ${index} is malformed`);
    }
    if (typeof transaction.note !== 'string') {
      throw new Error(`Confirmed receipt internal transaction ${index} has a missing or malformed note`);
    }
    // Fail closed on a hex-like but MALFORMED (odd-length) note. java-tron emits even-length hex,
    // which the wrapper decodes to text before this point; a note that still reads as raw hex here
    // and is odd-length (e.g. "6372656174650" or "0x6372656174650") is a truncated/corrupt marker
    // and must not be silently classified as a non-CREATE — a "create" could be hiding behind it.
    const hexBody = transaction.note.replace(/^0x/i, '');
    if (/^[0-9a-f]+$/i.test(hexBody) && hexBody.length % 2 === 1) {
      throw new Error(`Confirmed receipt internal transaction ${index} has a malformed (odd-length hex) note`);
    }
    // Normalize surrounding whitespace and trailing NUL padding before the `create` comparison so a
    // real child creation reported with padding noise (e.g. "create ", " create ", or the hex
    // 63726561746500 which decodes to "create\0") is not silently classified as a non-CREATE and
    // hidden. Interior content is untouched, so a present-but-different note stays non-create.
    return (
      transaction.note
        .replace(/^[\s\0]+/, '')
        .replace(/[\s\0]+$/, '')
        .toLowerCase() === 'create'
    );
  });
}

function internalCreateTransactions(receipt: JsonAny): JsonAny[] {
  return internalCreateAttempts(receipt).filter(transaction => transaction.rejected !== true);
}

function translateReceipt(snapshot: JsonAny, context: TranslateReceiptContext = {}): TranslatedReceipt {
  if (!isObject(snapshot) || !isObject(snapshot.transaction) || !isObject(snapshot.info)) {
    throw new Error('A confirmed native receipt is required');
  }
  const sourceTransactionHash = context.sourceTransactionHash;
  if (typeof sourceTransactionHash !== 'string' || !SOURCE_HASH_PATTERN.test(sourceTransactionHash)) {
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

  let actualContractAddress: string | null = null;
  if (info.contract_address !== undefined && info.contract_address !== null && info.contract_address !== '') {
    actualContractAddress = toEvmAddress(info.contract_address);
  }
  const contractAddress = isCreation
    ? context.predictedContractAddress === undefined
      ? actualContractAddress
      : toEvmAddress(context.predictedContractAddress)
    : null;

  const logs: TranslatedLog[] = (info.log ?? []).map((log: JsonAny, index: number) => {
    if (!isObject(log) || !Array.isArray(log.topics)) throw new Error('Invalid native receipt log');
    return {
      address: resolvedAddress(log.address, resolveAddress),
      topics: log.topics.map((topic: JsonAny) => normalizeHash(topic, 'log topic')),
      data: normalizeData(log.data, 'log data'),
      blockNumber,
      transactionHash: sourceTransactionHash.toLowerCase(),
      transactionIndex,
      blockHash,
      logIndex: quantity(index, 'log index'),
      removed: false,
    };
  });

  const internalTransactions: TranslatedInternalTransaction[] = (info.internal_transactions ?? []).map(
    (transaction: JsonAny) => translateInternalTransaction(transaction, resolveInternalAddress),
  );

  return {
    transactionHash: sourceTransactionHash.toLowerCase(),
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

export { internalCreateAttempts, internalCreateTransactions, translateReceipt };
