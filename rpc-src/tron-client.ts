import { TronWeb } from 'tronweb';

import {
  buildCall as runtimeBuildCall,
  buildCreate as runtimeBuildCreate,
  nativeTxIdFromSignedBytes,
  retryableTransportError,
  serializeSignedTransaction,
  signBuiltTransaction as runtimeSignBuiltTransaction,
} from '@openzeppelin/tron-runtime';
import type { BuildCallOptions, BuildCreateOptions, BuiltTransaction } from '@openzeppelin/tron-runtime';

import { nativeContractAddress, toEvmAddress, toTronHexAddress } from './address-codec.js';
import { translateReceipt } from './receipts.js';
import type { TranslateReceiptContext, TranslatedReceipt } from './receipts.js';

const TXID_PATTERN = /^(?:0x)?[0-9a-f]{64}$/i;
const HEX_BYTES_PATTERN = /^(?:0x)?(?:[0-9a-f]{2})+$/i;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_RECEIPT_TIMEOUT_MS = 120_000;
const DEFAULT_BROADCAST_ATTEMPTS = 3;
const DEFAULT_SIMULATION_READINESS_TIMEOUT_MS = 10_000;
const SIMULATION_PROBE_INITCODE = '6000600053600160006000f0506460006000fd6000526005601b6000f05060006000f3';

// Native TRON node responses, signed/built transaction JSON, and caller-supplied options this
// module validates at runtime are external, dynamically-shaped data with no canonical type in
// this codebase (mirrors the convention in rpc-src/receipts.ts). `any` is used deliberately
// throughout this module for that content, matching its original untyped JS handling.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonAny = any;

/** The TRON account/network configuration a {@link TronClient} is constructed with. */
export interface TronClientConfig {
  privateKey: string;
  feeLimit: number;
  fullHost: string;
}

/** The minimal TRON node transport surface a {@link TronClient} depends on. */
export interface TronTransport {
  request(path: string, body: JsonAny, options?: { signal?: AbortSignal }): Promise<JsonAny>;
}

/** Options accepted by the {@link TronClient} constructor. */
export interface TronClientOptions {
  config: TronClientConfig;
  tronWeb?: TronWeb;
  transport?: TronTransport;
  now?: () => number;
  sleep?: (delay: number) => Promise<void>;
  pollIntervalMs?: number;
  receiptTimeoutMs?: number;
  maxBroadcastAttempts?: number;
  simulationReadinessTimeoutMs?: number;
}

/** Options accepted by {@link TronClient#simulateSigned} / {@link TronClient#simulatePayload}. */
export interface SimulateOptions {
  signal?: AbortSignal;
}

/** One simulated (or exact) child CREATE attempt within a {@link SimulationResult}. */
export interface ChildCreateAttemptResult {
  index: number;
  callerAddress: string;
  createdAddress: string;
  success: boolean;
  kind?: string;
}

/** The result of {@link TronClient#simulateSigned} / {@link TronClient#simulatePayload}. */
export interface SimulationResult {
  mode: 'exact-signed' | 'constant-create' | 'constant-call';
  nativeTransactionId: string;
  simulationRootAddress: string;
  energyUsed: number;
  traceComplete: true;
  childCreateAttempts: ChildCreateAttemptResult[];
}

/** The result of {@link TronClient#broadcastSigned}. */
export interface BroadcastResult {
  nativeTransactionId: string;
  duplicate: boolean;
}

/** The result of {@link TronClient#getTransaction}. */
export interface NativeTransactionSnapshot {
  transaction: JsonAny;
  info: JsonAny | null;
  confirmed: boolean;
}

interface SimulationPayloadBody {
  owner_address: string;
  contract_address: string;
  data: string;
  call_value: number;
  visible: false;
}

interface SimulationPayload {
  mode: 'constant-create' | 'constant-call';
  body: SimulationPayloadBody;
}

function isObject(value: unknown): value is Record<string, JsonAny> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTxId(value: JsonAny): string {
  if (typeof value !== 'string' || !TXID_PATTERN.test(value)) throw new Error('Invalid native transaction ID');
  return value.replace(/^0x/i, '').toLowerCase();
}

function normalizeSignedBytes(value: JsonAny): string {
  if (typeof value !== 'string' || !HEX_BYTES_PATTERN.test(value)) {
    throw new Error('Invalid signed native transaction bytes');
  }
  return value.replace(/^0x/i, '').toLowerCase();
}

function stripHex(value: JsonAny, label: string, allowEmpty = true): string {
  if (typeof value !== 'string' || !/^(?:0x)?(?:[0-9a-f]{2})*$/i.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  const normalized = value.replace(/^0x/i, '').toLowerCase();
  if (!allowEmpty && normalized.length === 0) throw new Error(`Invalid ${label}`);
  return normalized;
}

function positiveInteger(value: JsonAny, label: string, fallback: number): number {
  const actual = value ?? fallback;
  if (!Number.isSafeInteger(actual) || actual <= 0) throw new Error(`Invalid ${label}`);
  return actual;
}

function normalizeCallValue(value: JsonAny): number {
  let parsed: bigint;
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

function emptyResponse(value: JsonAny): boolean {
  return !isObject(value) || Object.keys(value).length === 0;
}

function responseTxId(response: JsonAny): JsonAny {
  return response.txid ?? response.txID ?? response.transaction?.txID;
}

function responseMessage(response: JsonAny): string {
  if (typeof response.message !== 'string') return '';
  if (/^(?:[0-9a-f]{2})+$/i.test(response.message)) {
    return Buffer.from(response.message, 'hex').toString('utf8');
  }
  return response.message;
}

function duplicateResponse(response: JsonAny): boolean {
  const code = typeof response.code === 'string' ? response.code : '';
  const message = responseMessage(response);
  return /DUP_TRANSACTION/i.test(code) || /duplicate transaction/i.test(message);
}

function explicitMissingSimulationCapability(value: JsonAny): boolean {
  const status = numericHttpStatus(value);
  return status === 404 || status === 405 || status === 501;
}

function singleNativeContract(transaction: JsonAny, label: string): JsonAny {
  const contracts = transaction?.raw_data?.contract;
  if (!Array.isArray(contracts) || contracts.length !== 1 || !isObject(contracts[0]?.parameter?.value)) {
    throw new Error(`Invalid ${label} contract payload`);
  }
  return contracts[0];
}

function assertSuccessfulContractRet(transaction: JsonAny, label: string): void {
  if (transaction.ret === undefined) return;
  if (
    !Array.isArray(transaction.ret) ||
    transaction.ret.some(
      (item: JsonAny) => !isObject(item) || (item.contractRet !== undefined && item.contractRet !== 'SUCCESS'),
    )
  ) {
    throw new Error(`${label} contract result is not SUCCESS`);
  }
}

function sameTronAddress(left: JsonAny, right: JsonAny, allowEmpty = false): boolean {
  if (allowEmpty && (left === undefined || left === '') && (right === undefined || right === '')) return true;
  try {
    return toTronHexAddress(left).toLowerCase() === toTronHexAddress(right).toLowerCase();
  } catch {
    return false;
  }
}

function payloadFromSignedJson(signed: string, transaction: JsonAny): SimulationPayload {
  let reproduced: string | undefined;
  try {
    reproduced = isObject(transaction) ? serializeSignedTransaction(transaction) : undefined;
  } catch (error) {
    throw new Error('Built transaction JSON does not reproduce the exact signed native bytes', { cause: error });
  }
  if (reproduced !== signed) {
    throw new Error('Built transaction JSON does not reproduce the exact signed native bytes');
  }
  assertSuccessfulContractRet(transaction, 'Built transaction');
  const contract = singleNativeContract(transaction, 'built transaction');
  const value = contract.parameter.value;
  if (contract.type === 'CreateSmartContract') {
    const created = value.new_contract;
    if (!isObject(created) || typeof created.bytecode !== 'string') {
      throw new Error('Invalid built CreateSmartContract payload');
    }
    if (created.origin_address !== undefined && !sameTronAddress(created.origin_address, value.owner_address)) {
      throw new Error('Built CreateSmartContract owner mismatch');
    }
    return {
      mode: 'constant-create',
      body: {
        owner_address: toTronHexAddress(value.owner_address),
        contract_address: '',
        data: stripHex(created.bytecode, 'creation payload', false),
        call_value: normalizeCallValue(created.call_value ?? 0),
        visible: false,
      },
    };
  }
  if (contract.type === 'TriggerSmartContract') {
    return {
      mode: 'constant-call',
      body: {
        owner_address: toTronHexAddress(value.owner_address),
        contract_address: toTronHexAddress(value.contract_address),
        data: stripHex(value.data ?? '', 'call payload'),
        call_value: normalizeCallValue(value.call_value ?? 0),
        visible: false,
      },
    };
  }
  throw new Error(`Unsupported native simulation contract type ${String(contract.type)}`);
}

function validateConstantEcho(
  response: JsonAny,
  payload: SimulationPayload,
): { transaction: JsonAny; simulationRootAddress: string } {
  if (!isObject(response.transaction)) throw new Error('Constant simulation did not echo a transaction payload');
  assertSuccessfulContractRet(response.transaction, 'Constant simulation');
  const contract = singleNativeContract(response.transaction, 'constant simulation echo');
  const value = contract.parameter.value;
  if (payload.mode === 'constant-create') {
    const created = value.new_contract;
    if (
      contract.type !== 'CreateSmartContract' ||
      !isObject(created) ||
      !sameTronAddress(value.owner_address, payload.body.owner_address) ||
      !sameTronAddress(created.origin_address, payload.body.owner_address) ||
      stripHex(created.bytecode ?? '', 'constant simulation echo creation data') !== payload.body.data ||
      normalizeCallValue(created.call_value ?? 0) !== payload.body.call_value
    ) {
      throw new Error('Constant simulation echo payload mismatch');
    }
    let root: string;
    try {
      root = toEvmAddress(response.transaction.contract_address);
    } catch (error) {
      throw new Error('Constant-create simulation did not echo a valid synthetic root address', { cause: error });
    }
    if (root !== nativeContractAddress(response.transaction.txID, payload.body.owner_address)) {
      throw new Error('Constant-create simulation synthetic root address mismatch');
    }
    return { transaction: response.transaction, simulationRootAddress: root };
  }
  if (
    contract.type !== 'TriggerSmartContract' ||
    !sameTronAddress(value.owner_address, payload.body.owner_address) ||
    !sameTronAddress(value.contract_address, payload.body.contract_address) ||
    stripHex(value.data ?? '', 'constant simulation echo data') !== payload.body.data ||
    normalizeCallValue(value.call_value ?? 0) !== payload.body.call_value
  ) {
    throw new Error('Constant simulation echo payload mismatch');
  }
  return { transaction: response.transaction, simulationRootAddress: toEvmAddress(payload.body.contract_address) };
}

function decodeInternalNote(value: JsonAny): string {
  if (typeof value !== 'string') throw new Error('Invalid constant simulation internal transaction note');
  if (/^(?:[0-9a-f]{2})+$/i.test(value)) return Buffer.from(value, 'hex').toString('utf8');
  return value;
}

// Preserve the child-CREATE opcode kind reported by the trace verbatim (upper-cased) so the
// create-reconciler can reject CREATE2 pre-broadcast. Absent kind is left undefined; a
// present-but-malformed kind fails closed.
function normalizeCreateKind(value: JsonAny): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0) throw new Error('Invalid child CREATE attempt kind');
  return value.toUpperCase();
}

function constantCreateAttempts(response: JsonAny, allowOmitted = false): ChildCreateAttemptResult[] {
  if (response.internal_transactions === undefined && allowOmitted) return [];
  if (!Array.isArray(response.internal_transactions)) {
    throw new Error('Constant simulation did not provide a complete internal transaction trace');
  }
  const creates = response.internal_transactions.filter((transaction: JsonAny) => {
    if (!isObject(transaction)) throw new Error('Invalid constant simulation internal transaction');
    return decodeInternalNote(transaction.note).toLowerCase() === 'create';
  });
  return creates.map((attempt: JsonAny, index: number) => {
    if (attempt.rejected !== undefined && typeof attempt.rejected !== 'boolean') {
      throw new Error(`Invalid constant simulation child CREATE rejection marker ${index}`);
    }
    try {
      return {
        index,
        callerAddress: toEvmAddress(attempt.caller_address),
        createdAddress: toEvmAddress(attempt.transferTo_address ?? attempt.transfer_to_address),
        success: attempt.rejected !== true,
      };
    } catch (error) {
      throw new Error(`Invalid constant simulation child CREATE trace attempt ${index}`, { cause: error });
    }
  });
}

function numericHttpStatus(error: JsonAny): number | undefined {
  const candidates = [error?.status, error?.statusCode, error?.response?.status, error?.code];
  for (const candidate of candidates) {
    if (Number.isInteger(candidate)) return candidate;
    if (typeof candidate === 'string' && /^[0-9]{3}$/.test(candidate)) return Number(candidate);
  }
  return undefined;
}

class RetryableNativeQueryError extends Error {
  constructor(path: string, cause: unknown) {
    super(`Transient TRON query failure at ${path}`, { cause });
    this.name = 'RetryableNativeQueryError';
  }
}

class TronClient {
  declare config: TronClientConfig;
  declare tronWeb: TronWeb;
  declare transport: TronTransport;
  declare now: () => number;
  declare sleep: (delay: number) => Promise<void>;
  declare pollIntervalMs: number;
  declare receiptTimeoutMs: number;
  declare maxBroadcastAttempts: number;
  declare simulationReadinessTimeoutMs: number;
  declare simulationCapability: 'exact-signed' | 'constant-create' | undefined;
  declare simulationProbePromise: Promise<'exact-signed' | 'constant-create'> | undefined;
  declare constantTraceCapability: boolean;

  constructor(options: JsonAny = {}) {
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
    this.config = config as TronClientConfig;
    this.tronWeb =
      options.tronWeb ?? new TronWeb({ fullHost: config.fullHost, privateKey: config.privateKey.toLowerCase() });
    this.transport =
      options.transport ??
      Object.freeze({
        request: (path: string, body: JsonAny) => this.tronWeb.fullNode.request(path, body, 'post'),
      });
    if (!isObject(this.transport) || typeof this.transport.request !== 'function') {
      throw new Error('Invalid TRON node transport');
    }
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((delay: number) => new Promise<void>(resolve => setTimeout(resolve, delay)));
    this.pollIntervalMs = positiveInteger(options.pollIntervalMs, 'receipt poll interval', DEFAULT_POLL_INTERVAL_MS);
    this.receiptTimeoutMs = positiveInteger(options.receiptTimeoutMs, 'receipt timeout', DEFAULT_RECEIPT_TIMEOUT_MS);
    this.maxBroadcastAttempts = positiveInteger(
      options.maxBroadcastAttempts,
      'broadcast attempt count',
      DEFAULT_BROADCAST_ATTEMPTS,
    );
    this.simulationReadinessTimeoutMs = positiveInteger(
      options.simulationReadinessTimeoutMs,
      'simulation readiness timeout',
      DEFAULT_SIMULATION_READINESS_TIMEOUT_MS,
    );
    this.simulationCapability = undefined;
    this.simulationProbePromise = undefined;
    this.constantTraceCapability = false;
  }

  ownerAddress(ownerAddress?: JsonAny): string {
    const address = ownerAddress ?? this.tronWeb.defaultAddress?.hex;
    return toTronHexAddress(address);
  }

  async signBuiltTransaction(transaction: unknown): Promise<BuiltTransaction> {
    return runtimeSignBuiltTransaction(this.tronWeb, transaction, this.config.privateKey);
  }

  async buildCreate(options: BuildCreateOptions = {} as BuildCreateOptions): Promise<BuiltTransaction> {
    return runtimeBuildCreate(this.tronWeb, options, this.config);
  }

  async buildCall(options: BuildCallOptions = {} as BuildCallOptions): Promise<BuiltTransaction> {
    return runtimeBuildCall(this.tronWeb, options, this.config);
  }

  async simulateSigned(
    signedNativeTransaction: JsonAny,
    expectedNativeTransactionId?: JsonAny,
    builtTransaction?: JsonAny,
    options: SimulateOptions = {},
  ): Promise<SimulationResult> {
    const signed = normalizeSignedBytes(signedNativeTransaction);
    const nativeTransactionId = nativeTxIdFromSignedBytes(signed);
    if (
      expectedNativeTransactionId !== undefined &&
      normalizeTxId(expectedNativeTransactionId) !== nativeTransactionId
    ) {
      throw new Error('Native transaction ID mismatch before simulation');
    }
    if (this.simulationCapability === 'constant-create') {
      return this.simulatePayload(signed, nativeTransactionId, builtTransaction, options.signal);
    }
    let response: JsonAny;
    try {
      response = await this.transport.request(
        'wallet/simulatesignedtransaction',
        { transaction: signed },
        { signal: options.signal },
      );
    } catch (error) {
      if (explicitMissingSimulationCapability(error)) {
        if (builtTransaction === undefined) {
          throw new Error('Exact signed-transaction simulation is unavailable', { cause: error });
        }
        return this.simulatePayload(signed, nativeTransactionId, builtTransaction, options.signal);
      }
      throw new Error('Exact signed-transaction simulation is unavailable', { cause: error });
    }
    if (!isObject(response) || response.result?.result !== true) {
      if (explicitMissingSimulationCapability(response)) {
        if (builtTransaction === undefined) throw new Error('Exact signed-transaction simulation is unavailable');
        return this.simulatePayload(signed, nativeTransactionId, builtTransaction, options.signal);
      }
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
    const childCreateAttempts: ChildCreateAttemptResult[] = response.child_create_attempts.map(
      (attempt: JsonAny, index: number) => {
        try {
          if (!isObject(attempt) || typeof attempt.success !== 'boolean') throw new Error('invalid attempt');
          const kind = normalizeCreateKind(attempt.kind);
          return {
            index,
            callerAddress: toEvmAddress(attempt.caller_address),
            createdAddress: toEvmAddress(attempt.created_address),
            success: attempt.success,
            ...(kind === undefined ? {} : { kind }),
          };
        } catch (error) {
          throw new Error(`Invalid child CREATE trace attempt ${index}`, { cause: error });
        }
      },
    );
    const energyUsed = response.energy_used;
    if (!Number.isSafeInteger(energyUsed) || energyUsed < 0) throw new Error('Invalid exact simulation energy usage');
    let simulationRootAddress: string;
    if (builtTransaction !== undefined) {
      const payload = payloadFromSignedJson(signed, builtTransaction);
      simulationRootAddress =
        payload.mode === 'constant-create'
          ? nativeContractAddress(nativeTransactionId, payload.body.owner_address)
          : toEvmAddress(payload.body.contract_address);
    } else {
      simulationRootAddress = childCreateAttempts[0]?.callerAddress ?? `0x${'00'.repeat(20)}`;
    }
    return {
      mode: 'exact-signed',
      nativeTransactionId,
      simulationRootAddress,
      energyUsed,
      traceComplete: true,
      childCreateAttempts,
    };
  }

  async simulatePayload(
    signed: string,
    nativeTransactionId: string,
    builtTransaction: JsonAny,
    signal?: AbortSignal,
  ): Promise<SimulationResult> {
    const payload = payloadFromSignedJson(signed, builtTransaction);
    const response = await this.transport.request('wallet/triggerconstantcontract', payload.body, { signal });
    if (!isObject(response) || response.result?.result !== true) {
      throw new Error(
        `Constant payload simulation failed${responseMessage(response ?? {}) ? `: ${responseMessage(response)}` : ''}`,
      );
    }
    const echoed = validateConstantEcho(response, payload);
    const childCreateAttempts = constantCreateAttempts(response, this.constantTraceCapability);
    const energyUsed = response.energy_used;
    if (!Number.isSafeInteger(energyUsed) || energyUsed < 0) {
      throw new Error('Invalid constant simulation energy usage');
    }
    return {
      mode: payload.mode,
      nativeTransactionId,
      simulationRootAddress: echoed.simulationRootAddress,
      energyUsed,
      traceComplete: true,
      childCreateAttempts,
    };
  }

  async assertSimulationReady(): Promise<'exact-signed' | 'constant-create'> {
    if (this.simulationCapability !== undefined) return this.simulationCapability;
    if (this.simulationProbePromise !== undefined) return this.simulationProbePromise;
    this.simulationProbePromise = (async (): Promise<'exact-signed' | 'constant-create'> => {
      const controller = new AbortController();
      let timer!: NodeJS.Timeout;
      const deadline: Promise<never> = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`TRON simulation readiness timed out after ${this.simulationReadinessTimeoutMs}ms`));
        }, this.simulationReadinessTimeoutMs);
      });
      const probe = (async (): Promise<'exact-signed' | 'constant-create'> => {
        const built = await this.buildCreate({
          abi: [],
          bytecode: SIMULATION_PROBE_INITCODE,
          constructorData: '',
          ownerAddress: this.ownerAddress(),
          name: 'OpenZeppelinSimulationProbe',
          callValue: 0,
        });
        const simulation = await this.simulateSigned(
          built.signedNativeTransaction,
          built.nativeTransactionId,
          built.transaction,
          { signal: controller.signal },
        );
        if (
          simulation.childCreateAttempts.length !== 2 ||
          simulation.childCreateAttempts[0].success !== true ||
          simulation.childCreateAttempts[1].success !== false ||
          simulation.childCreateAttempts.some(attempt => attempt.callerAddress !== simulation.simulationRootAddress)
        ) {
          throw new Error(
            'TRON simulation readiness probe did not expose ordered successful and rejected CREATE attempts',
          );
        }
        return simulation.mode === 'exact-signed' ? 'exact-signed' : 'constant-create';
      })();
      try {
        const capability = await Promise.race([probe, deadline]);
        if (capability === 'constant-create') this.constantTraceCapability = true;
        this.simulationCapability = capability;
        return capability;
      } finally {
        clearTimeout(timer);
      }
    })();
    try {
      return await this.simulationProbePromise;
    } catch (error) {
      this.simulationProbePromise = undefined;
      throw error;
    }
  }

  async broadcastSigned(
    signedNativeTransaction: JsonAny,
    expectedNativeTransactionId?: JsonAny,
  ): Promise<BroadcastResult> {
    const signed = normalizeSignedBytes(signedNativeTransaction);
    const nativeTransactionId = nativeTxIdFromSignedBytes(signed);
    if (
      expectedNativeTransactionId !== undefined &&
      normalizeTxId(expectedNativeTransactionId) !== nativeTransactionId
    ) {
      throw new Error('Native transaction ID mismatch before broadcast');
    }
    let lastError: JsonAny;
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
        if (/different native transaction ID/.test((error as Error).message)) throw error;
        lastError = error;
        if (attempt < this.maxBroadcastAttempts) await this.sleep(this.pollIntervalMs);
      }
    }
    throw lastError;
  }

  async getTransaction(nativeTransactionId: JsonAny): Promise<NativeTransactionSnapshot | null> {
    const txid = normalizeTxId(nativeTransactionId);
    const request = async (path: string, body: JsonAny): Promise<JsonAny> => {
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
    const matchingIndexes: number[] = [];
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

  async waitForReceipt(
    nativeTransactionId: JsonAny,
    context: TranslateReceiptContext = {},
  ): Promise<TranslatedReceipt> {
    const txid = normalizeTxId(nativeTransactionId);
    const deadline = this.now() + this.receiptTimeoutMs;
    let lastCause: JsonAny;
    for (;;) {
      let snapshot: NativeTransactionSnapshot | null | undefined;
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

export { TronClient, nativeTxIdFromSignedBytes, retryableTransportError, serializeSignedTransaction };
