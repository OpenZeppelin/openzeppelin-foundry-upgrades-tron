const { createHash } = require('node:crypto');

const { TronWeb, utils } = require('tronweb');

const { toEvmAddress, toTronHexAddress } = require('./address-codec.cjs');
const { translateReceipt } = require('./receipts.cjs');

const TXID_PATTERN = /^(?:0x)?[0-9a-f]{64}$/i;
const HEX_BYTES_PATTERN = /^(?:0x)?(?:[0-9a-f]{2})+$/i;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_RECEIPT_TIMEOUT_MS = 120_000;
const DEFAULT_BROADCAST_ATTEMPTS = 3;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTxId(value) {
  if (typeof value !== 'string' || !TXID_PATTERN.test(value)) throw new Error('Invalid native transaction ID');
  return value.replace(/^0x/i, '').toLowerCase();
}

function normalizeSignedBytes(value) {
  if (typeof value !== 'string' || !HEX_BYTES_PATTERN.test(value)) {
    throw new Error('Invalid signed native transaction bytes');
  }
  return value.replace(/^0x/i, '').toLowerCase();
}

function stripHex(value, label, allowEmpty = true) {
  if (typeof value !== 'string' || !/^(?:0x)?(?:[0-9a-f]{2})*$/i.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  const normalized = value.replace(/^0x/i, '').toLowerCase();
  if (!allowEmpty && normalized.length === 0) throw new Error(`Invalid ${label}`);
  return normalized;
}

function encodeVarint(value) {
  let remaining = BigInt(value);
  const encoded = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) byte |= 0x80;
    encoded.push(byte);
  } while (remaining !== 0n);
  return Buffer.from(encoded);
}

function readCanonicalVarint(bytes, offset, label) {
  let value = 0n;
  let shift = 0n;
  for (let index = offset; index < bytes.length && index < offset + 10; index += 1) {
    const byte = bytes[index];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`Malformed signed native transaction protobuf ${label}`);
      }
      const encoded = encodeVarint(value);
      const consumed = bytes.subarray(offset, index + 1);
      if (!consumed.equals(encoded)) {
        throw new Error(`Noncanonical signed native transaction protobuf ${label}`);
      }
      return { value: Number(value), offset: index + 1 };
    }
    shift += 7n;
  }
  throw new Error(`Overlong signed native transaction protobuf ${label}`);
}

function parseCanonicalSignedTransaction(signedNativeTransaction) {
  const bytes = Buffer.from(normalizeSignedBytes(signedNativeTransaction), 'hex');
  let offset = 0;
  let rawData;
  let signatureCount = 0;
  const canonicalFields = [];
  while (offset < bytes.length) {
    const tag = readCanonicalVarint(bytes, offset, 'tag');
    offset = tag.offset;
    if (tag.value !== 0x0a && tag.value !== 0x12) {
      throw new Error('Unsupported signed native transaction protobuf field');
    }
    if (tag.value === 0x0a && (rawData !== undefined || signatureCount !== 0)) {
      throw new Error('Duplicate or out-of-order signed native transaction raw_data');
    }
    if (tag.value === 0x12 && rawData === undefined) {
      throw new Error('Signed native transaction signature precedes raw_data');
    }
    const length = readCanonicalVarint(bytes, offset, 'length');
    offset = length.offset;
    const end = offset + length.value;
    if (end > bytes.length) throw new Error('Malformed signed native transaction protobuf');
    const payload = bytes.subarray(offset, end);
    if (tag.value === 0x0a) {
      if (payload.length === 0) throw new Error('Signed native transaction has empty raw_data');
      rawData = bytes.subarray(offset, end);
    } else {
      if (payload.length !== 65) throw new Error('Signed native transaction signature must be 65 bytes');
      signatureCount += 1;
    }
    canonicalFields.push(Buffer.from([tag.value]), encodeVarint(payload.length), payload);
    offset = end;
  }
  if (rawData === undefined || rawData.length === 0) throw new Error('Signed native transaction is missing raw_data');
  if (signatureCount === 0) throw new Error('Signed native transaction is missing a signature');
  if (!Buffer.concat(canonicalFields).equals(bytes)) {
    throw new Error('Noncanonical signed native transaction protobuf wrapper');
  }
  return { rawData, signatureCount };
}

function nativeTxIdFromSignedBytes(signedNativeTransaction) {
  const { rawData } = parseCanonicalSignedTransaction(signedNativeTransaction);
  return createHash('sha256').update(rawData).digest('hex');
}

function serializeSignedTransaction(transaction) {
  if (!isObject(transaction) || !Array.isArray(transaction.signature) || transaction.signature.length === 0) {
    throw new Error('Native transaction is not signed');
  }
  const protobuf = utils.transaction.txJsonToPb(transaction);
  for (const signature of transaction.signature) {
    const normalized = stripHex(signature, 'native transaction signature', false);
    protobuf.addSignature(Uint8Array.from(utils.code.hexStr2byteArray(normalized)));
  }
  const serialized = utils.bytes.byteArray2hexStr(protobuf.serializeBinary()).toLowerCase();
  const computedTxId = nativeTxIdFromSignedBytes(serialized);
  if (normalizeTxId(transaction.txID) !== computedTxId) throw new Error('Native transaction ID mismatch');
  return serialized;
}

function positiveInteger(value, label, fallback) {
  const actual = value ?? fallback;
  if (!Number.isSafeInteger(actual) || actual <= 0) throw new Error(`Invalid ${label}`);
  return actual;
}

function normalizeCallValue(value) {
  let parsed;
  if (typeof value === 'bigint') {
    parsed = value;
  } else if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    parsed = BigInt(value);
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    parsed = BigInt(value);
  } else {
    throw new Error('Invalid call value');
  }
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid call value');
  return Number(parsed);
}

function emptyResponse(value) {
  return !isObject(value) || Object.keys(value).length === 0;
}

function responseTxId(response) {
  return response.txid ?? response.txID ?? response.transaction?.txID;
}

function responseMessage(response) {
  if (typeof response.message !== 'string') return '';
  if (/^(?:[0-9a-f]{2})+$/i.test(response.message)) {
    return Buffer.from(response.message, 'hex').toString('utf8');
  }
  return response.message;
}

function duplicateResponse(response) {
  const code = typeof response.code === 'string' ? response.code : '';
  const message = responseMessage(response);
  return /DUP_TRANSACTION/i.test(code) || /duplicate transaction/i.test(message);
}

const RETRYABLE_NETWORK_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETDOWN',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function numericHttpStatus(error) {
  const candidates = [error?.status, error?.statusCode, error?.response?.status, error?.code];
  for (const candidate of candidates) {
    if (Number.isInteger(candidate)) return candidate;
    if (typeof candidate === 'string' && /^[0-9]{3}$/.test(candidate)) return Number(candidate);
  }
  return undefined;
}

function retryableTransportError(error) {
  const seen = new Set();
  let current = error;
  while ((typeof current === 'object' && current !== null) || typeof current === 'function') {
    if (seen.has(current)) return false;
    seen.add(current);
    const status = numericHttpStatus(current);
    if (status !== undefined) return status === 408 || status === 429 || (status >= 500 && status <= 599);
    if (typeof current.code === 'string' && RETRYABLE_NETWORK_CODES.has(current.code.toUpperCase())) return true;
    const message = typeof current.message === 'string' ? current.message : '';
    if (/network|socket|reset|timed?\s*out|timeout|offline|outage|fetch failed/i.test(message)) return true;
    current = current.cause;
  }
  return false;
}

class RetryableNativeQueryError extends Error {
  constructor(path, cause) {
    super(`Transient TRON query failure at ${path}`, { cause });
    this.name = 'RetryableNativeQueryError';
  }
}

class TronClient {
  constructor(options = {}) {
    if (!isObject(options) || !isObject(options.config)) throw new Error('TRON client configuration is required');
    const { config } = options;
    if (
      typeof config.privateKey !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(config.privateKey) ||
      !Number.isSafeInteger(config.feeLimit) ||
      config.feeLimit <= 0 ||
      typeof config.fullHost !== 'string'
    ) {
      throw new Error('Invalid TRON client configuration');
    }
    this.config = config;
    this.tronWeb =
      options.tronWeb ?? new TronWeb({ fullHost: config.fullHost, privateKey: config.privateKey.toLowerCase() });
    this.transport =
      options.transport ??
      Object.freeze({
        request: (path, body) => this.tronWeb.fullNode.request(path, body, 'post'),
      });
    if (!isObject(this.transport) || typeof this.transport.request !== 'function') {
      throw new Error('Invalid TRON node transport');
    }
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (delay => new Promise(resolve => setTimeout(resolve, delay)));
    this.pollIntervalMs = positiveInteger(options.pollIntervalMs, 'receipt poll interval', DEFAULT_POLL_INTERVAL_MS);
    this.receiptTimeoutMs = positiveInteger(options.receiptTimeoutMs, 'receipt timeout', DEFAULT_RECEIPT_TIMEOUT_MS);
    this.maxBroadcastAttempts = positiveInteger(
      options.maxBroadcastAttempts,
      'broadcast attempt count',
      DEFAULT_BROADCAST_ATTEMPTS,
    );
  }

  ownerAddress(ownerAddress) {
    const address = ownerAddress ?? this.tronWeb.defaultAddress?.hex;
    return toTronHexAddress(address);
  }

  async signBuiltTransaction(transaction) {
    if (!isObject(transaction)) throw new Error('Native transaction builder returned no transaction');
    const signed = await this.tronWeb.trx.sign(transaction, this.config.privateKey);
    const signedNativeTransaction = serializeSignedTransaction(signed);
    return {
      signedNativeTransaction,
      nativeTransactionId: nativeTxIdFromSignedBytes(signedNativeTransaction),
      transaction: signed,
    };
  }

  async buildCreate({ abi, bytecode, constructorData = '', ownerAddress, name = '', callValue = 0 } = {}) {
    if (!Array.isArray(abi)) throw new Error('Invalid contract ABI');
    const exactCallValue = normalizeCallValue(callValue);
    const options = {
      abi,
      bytecode: stripHex(bytecode, 'contract bytecode', false),
      callValue: exactCallValue,
      feeLimit: this.config.feeLimit,
      name,
      rawParameter: stripHex(constructorData, 'constructor data'),
    };
    const transaction = await this.tronWeb.transactionBuilder.createSmartContract(
      options,
      this.ownerAddress(ownerAddress),
    );
    return this.signBuiltTransaction(transaction);
  }

  async buildCall({ contractAddress, data = '', ownerAddress, callValue = 0 } = {}) {
    const exactCallValue = normalizeCallValue(callValue);
    const wrapper = await this.tronWeb.transactionBuilder.triggerSmartContract(
      toTronHexAddress(contractAddress),
      '',
      {
        callValue: exactCallValue,
        feeLimit: this.config.feeLimit,
        input: stripHex(data, 'call data'),
        txLocal: true,
      },
      [],
      this.ownerAddress(ownerAddress),
    );
    if (!isObject(wrapper) || wrapper.result?.result !== true) {
      throw new Error(`Native call prebuild failed${wrapper?.result?.message ? `: ${wrapper.result.message}` : ''}`);
    }
    return this.signBuiltTransaction(wrapper.transaction);
  }

  async simulateSigned(signedNativeTransaction, expectedNativeTransactionId) {
    const signed = normalizeSignedBytes(signedNativeTransaction);
    const nativeTransactionId = nativeTxIdFromSignedBytes(signed);
    if (
      expectedNativeTransactionId !== undefined &&
      normalizeTxId(expectedNativeTransactionId) !== nativeTransactionId
    ) {
      throw new Error('Native transaction ID mismatch before simulation');
    }
    let response;
    try {
      response = await this.transport.request('wallet/simulatesignedtransaction', { transaction: signed });
    } catch (error) {
      throw new Error('Exact signed-transaction simulation is unavailable', { cause: error });
    }
    if (!isObject(response) || response.result?.result !== true) {
      throw new Error(
        `Exact signed-transaction simulation failed${responseMessage(response ?? {}) ? `: ${responseMessage(response)}` : ''}`,
      );
    }
    if (normalizeTxId(responseTxId(response)) !== nativeTransactionId) {
      throw new Error('Exact simulation transaction ID mismatch');
    }
    if (response.trace_complete !== true || !Array.isArray(response.child_create_attempts)) {
      throw new Error('Exact simulation did not provide a complete child CREATE trace');
    }
    const childCreateAttempts = response.child_create_attempts.map((attempt, index) => {
      try {
        if (!isObject(attempt) || typeof attempt.success !== 'boolean') throw new Error('invalid attempt');
        return {
          index,
          callerAddress: toEvmAddress(attempt.caller_address),
          createdAddress: toEvmAddress(attempt.created_address),
          success: attempt.success,
        };
      } catch (error) {
        throw new Error(`Invalid child CREATE trace attempt ${index}`, { cause: error });
      }
    });
    const energyUsed = response.energy_used;
    if (!Number.isSafeInteger(energyUsed) || energyUsed < 0) throw new Error('Invalid exact simulation energy usage');
    return { nativeTransactionId, energyUsed, traceComplete: true, childCreateAttempts };
  }

  async broadcastSigned(signedNativeTransaction, expectedNativeTransactionId) {
    const signed = normalizeSignedBytes(signedNativeTransaction);
    const nativeTransactionId = nativeTxIdFromSignedBytes(signed);
    if (
      expectedNativeTransactionId !== undefined &&
      normalizeTxId(expectedNativeTransactionId) !== nativeTransactionId
    ) {
      throw new Error('Native transaction ID mismatch before broadcast');
    }
    let lastError;
    for (let attempt = 1; attempt <= this.maxBroadcastAttempts; attempt += 1) {
      try {
        const response = await this.transport.request('wallet/broadcasthex', { transaction: signed });
        const reported = responseTxId(response);
        if (reported !== undefined && normalizeTxId(reported) !== nativeTransactionId) {
          throw new Error('Broadcast returned a different native transaction ID');
        }
        if (response?.result === true) return { nativeTransactionId, duplicate: false };
        if (duplicateResponse(response ?? {})) return { nativeTransactionId, duplicate: true };
        throw new Error(
          `Native transaction broadcast failed${responseMessage(response ?? {}) ? `: ${responseMessage(response)}` : ''}`,
        );
      } catch (error) {
        if (/different native transaction ID/.test(error.message)) throw error;
        lastError = error;
        if (attempt < this.maxBroadcastAttempts) await this.sleep(this.pollIntervalMs);
      }
    }
    throw lastError;
  }

  async getTransaction(nativeTransactionId) {
    const txid = normalizeTxId(nativeTransactionId);
    const request = async (path, body) => {
      try {
        return await this.transport.request(path, body);
      } catch (error) {
        if (!retryableTransportError(error)) throw error;
        throw new RetryableNativeQueryError(path, error);
      }
    };
    const [transaction, info] = await Promise.all([
      request('wallet/gettransactionbyid', { value: txid }),
      request('walletsolidity/gettransactioninfobyid', { value: txid }),
    ]);
    if (emptyResponse(transaction)) return null;
    if (normalizeTxId(transaction.txID) !== txid)
      throw new Error('Native transaction query returned a different transaction ID');
    if (emptyResponse(info) || info.blockNumber === undefined || !isObject(info.receipt)) {
      return { transaction, info: null, confirmed: false };
    }
    if (normalizeTxId(info.id) !== txid)
      throw new Error('Native transaction receipt returned a different transaction ID');
    if (!Number.isSafeInteger(info.blockNumber) || info.blockNumber < 0) {
      throw new Error('Invalid confirmed block number');
    }
    const block = await request('walletsolidity/getblockbynum', { num: info.blockNumber });
    if (
      emptyResponse(block) ||
      typeof block.blockID !== 'string' ||
      !Array.isArray(block.transactions) ||
      !Number.isSafeInteger(block.block_header?.raw_data?.number) ||
      block.block_header.raw_data.number < 0 ||
      block.block_header.raw_data.number !== info.blockNumber
    ) {
      throw new Error('Confirmed solid block number or transaction list mismatch');
    }
    const blockHash = normalizeTxId(block.blockID);
    if (info.blockHash !== undefined && normalizeTxId(info.blockHash) !== blockHash) {
      throw new Error('Confirmed solid block hash mismatch');
    }
    const matchingIndexes = [];
    for (let index = 0; index < block.transactions.length; index += 1) {
      const blockTransaction = block.transactions[index];
      if (!isObject(blockTransaction) || typeof blockTransaction.txID !== 'string') {
        throw new Error('Invalid confirmed solid block transaction');
      }
      if (normalizeTxId(blockTransaction.txID) === txid) matchingIndexes.push(index);
    }
    if (matchingIndexes.length !== 1) {
      throw new Error('Confirmed transaction is not uniquely present in its solid block');
    }
    const transactionIndex = matchingIndexes[0];
    if (info.transactionIndex !== undefined && info.transactionIndex !== transactionIndex) {
      throw new Error('Confirmed transaction index mismatch');
    }
    return {
      transaction,
      info: { ...info, blockHash, transactionIndex },
      confirmed: true,
    };
  }

  async waitForReceipt(nativeTransactionId, context = {}) {
    const txid = normalizeTxId(nativeTransactionId);
    const deadline = this.now() + this.receiptTimeoutMs;
    let lastCause;
    for (;;) {
      let snapshot;
      try {
        snapshot = await this.getTransaction(txid);
      } catch (error) {
        if (!(error instanceof RetryableNativeQueryError)) throw error;
        lastCause = error.cause ?? error;
      }
      if (snapshot?.confirmed === true) return translateReceipt(snapshot, context);
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for native transaction ${txid}`, { cause: lastCause });
      }
      await this.sleep(Math.min(this.pollIntervalMs, remaining));
    }
  }
}

module.exports = {
  TronClient,
  nativeTxIdFromSignedBytes,
  retryableTransportError,
  serializeSignedTransaction,
};
