import path from 'node:path';

import { Interface, Transaction, concat, dataSlice, getAddress, getCreateAddress, keccak256, toUtf8Bytes } from 'ethers';

import { normalizeAddress, toEvmAddress } from './address-codec.js';
import { canonicalTronFullyQualifiedName, derivedTronProxyAdminIdentity } from './artifact-identities.js';
import type { ArtifactIdentity } from './artifact-identities.js';
import { findArtifactPaths, matchDeploymentArtifact, verifyArtifactProvenance } from './artifacts.js';
import {
  buildDescriptorsFromRanges,
  codeMatchesRuntimeTemplate,
  extractImmutableReferences,
  hasAddressWidthRange,
  immutableRanges,
  projectDescriptorImmutables,
  runtimeBytecodeTemplateHash,
} from './immutable-projection.js';
import type { ImmutableDescriptor, ImmutableRange, ImmutableSource } from './immutable-projection.js';
import { mapFilterParams, mapLogEntry } from './log-translation.js';
import { assertOpaqueBytesSafe, rewriteCall, rewriteDeployment } from './rewriter.js';
import { assertStateLockHeld } from './state-lock.js';
import { decodeLegacyTransaction } from './transactions.js';
import { NonceOrderedQueue } from './transaction-queue.js';
import { retryableTransportError } from './tron-client.js';
import { UpstreamRpcError } from './upstream.js';

// JSON-RPC requests, upstream responses, decoded transactions, journal records, and the injectable
// dependency surface this module handles are external, dynamically-shaped data with no canonical
// type in this codebase (the dependency layer — rewriter, artifacts, tron-client — is itself typed
// with the same `any` convention). `any` is used deliberately for that content, so this alias
// marks the deliberately untyped seam; values are validated at runtime before use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonAny = any;

const JSON_RPC_VERSION = '2.0';
// The deadline a signer's transaction waits for a strictly-lower missing nonce before it is failed
// deterministically, rather than racing ahead of (or hanging on) an absent predecessor.
const DEFAULT_NONCE_GAP_DEADLINE_MS = 30_000;
// The post-confirmation actual-runtime-code read that binds address-width immutable descriptors can
// briefly observe a not-yet-populated ('0x') or transiently unavailable body under read-your-writes /
// node lag; capture retries the read a bounded number of times before giving up with no descriptors.
const DESCRIPTOR_CAPTURE_ATTEMPTS = 3;
const DEFAULT_DESCRIPTOR_CAPTURE_RETRY_DELAY_MS = 50;
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
// The three TRC-1967 slots whose stored value is an address the gateway may reverse-map in an
// eth_getStorageAt response; every other slot is returned byte-for-byte.
const TRC1967_SLOTS = new Set([IMPLEMENTATION_SLOT, ADMIN_SLOT, BEACON_SLOT]);
const IMPLEMENTATION_SELECTOR = '0x5c60da1b';
// The three externally-deployed proxy upgrade calls recognized on the opaque path: a UUPS proxy's
// upgradeToAndCall, a ProxyAdmin's upgradeAndCall, and an UpgradeableBeacon's upgradeTo. Each names a
// single implementation-address argument that may embed a gateway predicted address; every other
// argument is left byte-for-byte unchanged.
const EXTERNAL_UPGRADE_INTERFACE = new Interface([
  'function upgradeToAndCall(address newImplementation, bytes data)',
  'function upgradeAndCall(address proxy, address implementation, bytes data)',
  'function upgradeTo(address newImplementation)',
]);
const EXTERNAL_UPGRADE_DESCRIPTORS = new Map<string, { kind: string; implementationIndex: number; proxyIndex?: number }>([
  ['upgradeToAndCall', { kind: 'uups', implementationIndex: 0 }],
  ['upgradeAndCall', { kind: 'proxy-admin', implementationIndex: 1, proxyIndex: 0 }],
  ['upgradeTo', { kind: 'beacon', implementationIndex: 0 }],
]);
const FORWARDED_METHODS = new Set([
  'eth_blockNumber',
  'eth_getBlockTransactionCountByHash',
  'eth_getBlockTransactionCountByNumber',
  'eth_getTransactionByBlockHashAndIndex',
  'eth_getTransactionByBlockNumberAndIndex',
  'web3_clientVersion',
]);
const CANONICAL_CONTRACT_KINDS = new Map([
  ['openzeppelin-tron-solidity/contracts/proxy/TRC1967/TRC1967Proxy.sol:TRC1967Proxy', 'uups-proxy'],
  [
    'openzeppelin-tron-solidity/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy',
    'transparent-proxy',
  ],
  ['openzeppelin-tron-solidity/contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin', 'proxy-admin'],
  ['openzeppelin-tron-solidity/contracts/proxy/beacon/UpgradeableBeacon.sol:UpgradeableBeacon', 'upgradeable-beacon'],
  ['openzeppelin-tron-solidity/contracts/proxy/beacon/BeaconProxy.sol:BeaconProxy', 'beacon-proxy'],
  ['node_modules/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy', 'uups-proxy'],
  [
    'node_modules/@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy',
    'transparent-proxy',
  ],
  ['node_modules/@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin', 'proxy-admin'],
  ['node_modules/@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol:UpgradeableBeacon', 'upgradeable-beacon'],
  ['node_modules/@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol:BeaconProxy', 'beacon-proxy'],
]);

class RpcError extends Error {
  declare code: number;
  declare data?: unknown;

  // The constructor accepts and intentionally ignores a trailing options argument, so call sites
  // may pass `{ cause }` without it being forwarded to `super`. The parameter carries a default
  // value so it is excluded from `Function.length`, keeping `RpcError.length === 3` for callers
  // that reflect on the constructor's arity.
  constructor(code: number, message: string, data?: unknown, _options: ErrorOptions | undefined = undefined) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

function isObject(value: unknown): value is Record<string, JsonAny> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function quantity(value: string | number | bigint): string {
  const numeric = BigInt(value);
  if (numeric < 0n) throw new Error('Quantity cannot be negative');
  return `0x${numeric.toString(16)}`;
}

function normalizeHash(value: JsonAny, label = 'transaction hash'): string {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) {
    throw new RpcError(-32602, `Invalid ${label}`);
  }
  return value.toLowerCase();
}

function normalizeEvmAddress(value: JsonAny, label = 'address'): string {
  try {
    return toEvmAddress(value);
  } catch (error) {
    throw new RpcError(-32602, `Invalid ${label}`, undefined, { cause: error });
  }
}

function nativeContractAddress(nativeTransactionId: JsonAny, ownerAddress: JsonAny): string {
  const txid = typeof nativeTransactionId === 'string' ? nativeTransactionId.replace(/^0x/i, '') : '';
  if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error('Invalid native transaction ID');
  const owner = normalizeEvmAddress(ownerAddress, 'native owner').slice(2);
  return dataSlice(keccak256(concat([`0x${txid}`, `0x41${owner}`])), 12).toLowerCase();
}

function artifactIdentity(match: JsonAny): ArtifactIdentity {
  const identity = {
    sourceName: match?.sourceName,
    contractName: match?.contractName,
    fullyQualifiedName: match?.fullyQualifiedName,
  };
  if (
    typeof identity.sourceName !== 'string' ||
    typeof identity.contractName !== 'string' ||
    identity.fullyQualifiedName !== `${identity.sourceName}:${identity.contractName}`
  ) {
    throw new Error('Verified artifact is missing a canonical identity');
  }
  return identity;
}

function bytecodeObject(value: JsonAny): JsonAny {
  return typeof value === 'string' ? value : value?.object;
}

function bytecodeHash(value: JsonAny, label: string): string {
  const hex = bytecodeObject(value);
  if (typeof hex !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(hex)) {
    const error: JsonAny = new Error(`Deployment artifact ${label} is unavailable`);
    error.code = 'INVALID_ARTIFACT';
    throw error;
  }
  return keccak256(hex.toLowerCase());
}

function contractKindForArtifact(identity: JsonAny): string {
  if (
    !isObject(identity) ||
    typeof identity.sourceName !== 'string' ||
    typeof identity.contractName !== 'string' ||
    identity.fullyQualifiedName !== `${identity.sourceName}:${identity.contractName}`
  ) {
    return 'contract';
  }
  const canonicalTron = canonicalTronFullyQualifiedName(identity.fullyQualifiedName);
  return CANONICAL_CONTRACT_KINDS.get(canonicalTron ?? identity.fullyQualifiedName) ?? 'contract';
}

function validateDependencies(options: JsonAny): JsonAny {
  if (!isObject(options) || !isObject(options.config)) throw new Error('RPC handler configuration is required');
  const config = options.config;
  let chainId;
  try {
    chainId = BigInt(config.chainId);
  } catch (error) {
    throw new Error('RPC handler chain ID must be a positive integer', { cause: error });
  }
  if (
    chainId <= 0n ||
    typeof config.chainIdentity !== 'string' ||
    typeof config.expectedSender !== 'string' ||
    typeof config.foundryOut !== 'string' ||
    !path.isAbsolute(config.foundryOut) ||
    typeof config.stateFile !== 'string' ||
    !path.isAbsolute(config.stateFile)
  ) {
    throw new Error('Invalid RPC handler configuration');
  }
  try {
    getAddress(config.expectedSender);
  } catch (error) {
    throw new Error('Invalid expected RPC transaction sender', { cause: error });
  }
  for (const [name, dependency, methods] of [
    ['journal', options.journal, ['receive', 'get', 'list', 'recordBroadcast', 'recordFailed', 'recoverReceived']],
    [
      'address map',
      options.addressMap,
      [
        'toActual',
        'toPredicted',
        'resolvePredicted',
        'resolveActual',
        'resolveContractMetadata',
        'resolveArtifactSnapshot',
        'setArtifactSnapshot',
        'list',
      ],
    ],
    ['reconciler', options.reconciler, ['recordPreparedNative', 'reconcile']],
    [
      'native client',
      options.nativeClient,
      [
        'assertSimulationReady',
        'buildCreate',
        'buildCall',
        'simulateSigned',
        'broadcastSigned',
        'getTransaction',
        'waitForReceipt',
      ],
    ],
    ['upstream JSON-RPC client', options.upstream, ['request']],
  ] as [string, JsonAny, string[]][]) {
    if (!isObject(dependency) || methods.some(method => typeof dependency[method] !== 'function')) {
      throw new Error(`Invalid ${name} dependency`);
    }
  }
  if (options.journal.chainIdentity !== undefined && options.journal.chainIdentity !== config.chainIdentity) {
    throw new Error('Journal chain identity does not match handler configuration');
  }
  if (options.addressMap.chainIdentity !== undefined && options.addressMap.chainIdentity !== config.chainIdentity) {
    throw new Error('Address-map chain identity does not match handler configuration');
  }
  if (
    options.journal.store?.filePath !== undefined &&
    path.resolve(options.journal.store.filePath) !== path.resolve(config.stateFile)
  ) {
    throw new Error('Journal state file does not match handler configuration');
  }
  if (
    options.journal.store !== undefined &&
    options.addressMap.store !== undefined &&
    options.journal.store !== options.addressMap.store
  ) {
    throw new Error('Journal and address map must share one durable store');
  }
  return { ...options, config: { ...config, chainId } };
}

function failureCode(error: JsonAny): string {
  return typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'TRANSLATION_FAILED';
}

function publicError(error: JsonAny): RpcError {
  if (error instanceof RpcError) return error;
  if (error instanceof UpstreamRpcError) return new RpcError(error.code, error.message, error.data);
  return new RpcError(-32000, 'TRON RPC operation failed', { code: failureCode(error) });
}

function responseError(id: JsonAny, error: JsonAny): JsonAny {
  const rpc = publicError(error);
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    error: {
      code: rpc.code,
      message: rpc.message,
      ...(rpc.data === undefined ? {} : { data: rpc.data }),
    },
  };
}

function validRequest(request: JsonAny): boolean {
  if (!isObject(request)) return false;
  const keys = Object.keys(request);
  if (keys.some(key => !['jsonrpc', 'id', 'method', 'params'].includes(key))) return false;
  if (request.jsonrpc !== JSON_RPC_VERSION || typeof request.method !== 'string' || request.method.length === 0) {
    return false;
  }
  if (own(request, 'id') && request.id !== null && typeof request.id !== 'string' && typeof request.id !== 'number') {
    return false;
  }
  return !own(request, 'params') || Array.isArray(request.params) || isObject(request.params);
}

function requirePositional(params: JsonAny, minimum: number, maximum = minimum): JsonAny[] {
  if (!Array.isArray(params) || params.length < minimum || params.length > maximum) {
    throw new RpcError(-32602, 'Invalid params');
  }
  return params;
}

function receiptContext(addressMap: JsonAny, record: JsonAny): JsonAny {
  const operation = record.operationContext;
  return {
    ...operation,
    sourceTransactionHash: record.sourceTransactionHash,
    ...(operation.kind === 'deployment' ? { predictedContractAddress: operation.predictedContractAddress } : {}),
    resolveAddress(address: JsonAny) {
      const actual = normalizeEvmAddress(address);
      if (operation.kind === 'deployment' && actual === operation.actualTarget) {
        return operation.predictedContractAddress;
      }
      if (operation.kind === 'call' && actual === operation.actualTarget) {
        return normalizeEvmAddress(operation.to, 'source call target');
      }
      return addressMap.toPredicted(actual) ?? actual;
    },
    resolveInternalAddress(address: JsonAny) {
      return normalizeEvmAddress(address, 'native internal transaction address');
    },
  };
}

function ethereumTransaction(record: JsonAny): JsonAny {
  const transaction = Transaction.from(record.signedEthereumTransaction);
  const receipt = record.receipt;
  return {
    blockHash: receipt?.blockHash ?? null,
    blockNumber: receipt?.blockNumber ?? null,
    from: transaction.from,
    gas: quantity(transaction.gasLimit),
    gasPrice: quantity(transaction.gasPrice!),
    hash: record.sourceTransactionHash,
    input: transaction.data,
    nonce: quantity(transaction.nonce),
    to: transaction.to,
    transactionIndex: receipt?.transactionIndex ?? null,
    value: quantity(transaction.value),
    type: '0x0',
    chainId: quantity(transaction.chainId),
    v: quantity(transaction.signature!.networkV ?? transaction.signature!.v),
    r: transaction.signature!.r,
    s: transaction.signature!.s,
  };
}

function virtualTransactionCount(
  journal: JsonAny,
  expectedSender: JsonAny,
  address: JsonAny,
  blockTag: JsonAny = 'latest',
  decode: JsonAny = decodeLegacyTransaction,
  chainId?: JsonAny,
  baseline: bigint = 0n,
): string {
  const sender = normalizeEvmAddress(address, 'transaction-count address');
  const expected = normalizeEvmAddress(expectedSender, 'configured sender');
  let historicalBlock;
  if (!['earliest', 'latest', 'pending'].includes(blockTag)) {
    if (typeof blockTag !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(blockTag)) {
      throw new RpcError(
        -32602,
        'Transaction count block must be earliest, latest, pending, or a canonical block quantity',
      );
    }
    historicalBlock = BigInt(blockTag);
  }
  if (blockTag === 'earliest' || sender !== expected) return '0x0';

  let next = 0n;
  for (const record of journal.list()) {
    let nonce;
    let from;
    if (record.operationContext !== undefined) {
      nonce = BigInt(record.operationContext.nonce);
      from = record.operationContext.from;
    } else if (blockTag === 'pending' && record.state === 'received') {
      try {
        const source = decode(record.signedEthereumTransaction, {
          expectedSender: expected,
          expectedChainId: chainId,
        });
        nonce = BigInt(source.nonce);
        from = normalizeEvmAddress(source.from, 'pending source sender');
      } catch {
        continue;
      }
    } else {
      continue;
    }
    const finalized = record.state === 'confirmed' || (record.state === 'failed' && record.receipt !== undefined);
    let included = blockTag === 'pending' || finalized;
    if (included && historicalBlock !== undefined) {
      const receiptBlock = record.receipt?.blockNumber;
      if (typeof receiptBlock !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(receiptBlock)) {
        throw new Error('Confirmed journal receipt has an invalid block number');
      }
      included = BigInt(receiptBlock) <= historicalBlock;
    }
    if (included && from === expected && nonce >= next) next = nonce + 1n;
  }
  // A deployment adopted after state loss records how many nonces the signer already consumed
  // on-chain, so the virtual count never rewinds below that declared baseline for its own sender.
  return quantity(next < baseline ? baseline : next);
}

function normalizeUpstreamBlock(block: JsonAny): JsonAny {
  if (block === null) return null;
  if (!isObject(block)) throw new Error('Invalid upstream block response');
  const normalized = structuredClone(block);
  if (normalized.stateRoot === '0x') normalized.stateRoot = `0x${'00'.repeat(32)}`;
  if (typeof normalized.stateRoot !== 'string' || !/^0x[0-9a-f]{64}$/i.test(normalized.stateRoot)) {
    throw new Error('Invalid upstream block stateRoot');
  }
  return normalized;
}

async function requestStockCompatibleRead(
  upstream: JsonAny,
  method: JsonAny,
  params: JsonAny,
  blockTag: JsonAny,
): Promise<JsonAny> {
  try {
    return await upstream.request(method, params);
  } catch (error) {
    const stockQuantityError =
      error instanceof UpstreamRpcError &&
      error.code === -32602 &&
      error?.message === 'QUANTITY not supported, just support TAG as latest' &&
      typeof blockTag === 'string' &&
      /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(blockTag);
    if (!stockQuantityError) throw error;
    return upstream.request(method, [...params.slice(0, -1), 'latest']);
  }
}

function createRpcHandlers(rawOptions: JsonAny): JsonAny {
  const options = validateDependencies(rawOptions);
  const { config, journal, addressMap, reconciler, nativeClient, upstream } = options;
  const decode = options.decodeLegacyTransaction ?? decodeLegacyTransaction;
  const matchArtifact = options.matchDeploymentArtifact ?? matchDeploymentArtifact;
  const findArtifacts = options.findArtifactPaths ?? findArtifactPaths;
  const verifyArtifact = options.verifyArtifactProvenance ?? verifyArtifactProvenance;
  const rewriteDeploy = options.rewriteDeployment ?? rewriteDeployment;
  const rewriteContractCall = options.rewriteCall ?? rewriteCall;
  const opaqueSafety = options.assertOpaqueBytesSafe ?? assertOpaqueBytesSafe;
  const inFlight = new Map<string, Promise<JsonAny>>();
  const gapDeadlineMs = options.nonceGapDeadlineMs ?? DEFAULT_NONCE_GAP_DEADLINE_MS;
  const captureRetryDelayMs = options.descriptorCaptureRetryDelayMs ?? DEFAULT_DESCRIPTOR_CAPTURE_RETRY_DELAY_MS;
  // Injectable so tests drive the bounded descriptor-capture retry deterministically without real
  // backoff; production waits on an unref'd timer so a pending retry never keeps the process alive.
  const delay: (ms: number) => Promise<void> =
    options.delay ??
    ((ms: number) =>
      new Promise<void>(resolve => {
        const handle = setTimeout(resolve, ms);
        if (typeof (handle as JsonAny)?.unref === 'function') (handle as JsonAny).unref();
      }));

  function nonceBaselineFor(signer: JsonAny): bigint {
    if (typeof addressMap.resolveNonceBaseline !== 'function') return 0n;
    return addressMap.resolveNonceBaseline(signer) ?? 0n;
  }

  const queue = new NonceOrderedQueue({
    // The signer's next expected nonce is the durable virtual latest count: the number of its
    // confirmed (or reverted-with-receipt) source transactions, which advances only when a
    // transaction reaches a solid receipt and its address mappings are published.
    expectedNonce: (signer: JsonAny) =>
      BigInt(
        virtualTransactionCount(
          journal,
          config.expectedSender,
          signer,
          'latest',
          decode,
          config.chainId,
          nonceBaselineFor(signer),
        ),
      ),
    gapDeadlineMs,
    ...(options.scheduleTimeout === undefined ? {} : { scheduleTimeout: options.scheduleTimeout }),
    ...(options.cancelTimeout === undefined ? {} : { cancelTimeout: options.cancelTimeout }),
  });

  function mappedAddress(address: JsonAny): string {
    const normalized = normalizeEvmAddress(address);
    if (normalized === ZERO_ADDRESS) return normalized;
    return addressMap.toActual(normalized) ?? normalized;
  }

  function metadataFor(address: JsonAny): JsonAny {
    if (normalizeEvmAddress(address) === ZERO_ADDRESS) return undefined;
    const direct = addressMap.resolveContractMetadata(address);
    if (direct !== undefined) return direct;
    const mapping = addressMap.resolvePredicted(address) ?? addressMap.resolveActual(address);
    if (mapping === undefined) return undefined;
    const source = journal.get(mapping.sourceTransaction);
    const operation = source?.operationContext;
    if (
      operation?.artifactIdentity !== null &&
      operation?.artifactIdentity !== undefined &&
      (operation.predictedContractAddress === mapping.predicted || operation.to === mapping.predicted)
    ) {
      return {
        predicted: mapping.predicted,
        contractKind: operation.contractKind,
        artifactIdentity: operation.artifactIdentity,
        sourceTransaction: mapping.sourceTransaction,
      };
    }
    return undefined;
  }

  function verifiedArtifactForIdentity(identity: JsonAny): JsonAny {
    const matches = findArtifacts(config.foundryOut, identity.fullyQualifiedName);
    if (matches.length !== 1) {
      const error: JsonAny = new Error(
        `Expected one artifact for ${identity.fullyQualifiedName}, found ${matches.length}`,
      );
      error.code = matches.length === 0 ? 'ARTIFACT_NOT_FOUND' : 'AMBIGUOUS_ARTIFACT';
      throw error;
    }
    return verifyArtifact({ outputDirectory: config.foundryOut, artifactPath: matches[0] });
  }

  function sameArtifactIdentity(left: JsonAny, right: JsonAny): boolean {
    return left?.fullyQualifiedName === right?.fullyQualifiedName;
  }

  function provenanceFailure(message: JsonAny, code = 'ARTIFACT_PROVENANCE_CHANGED'): JsonAny {
    const error: JsonAny = new Error(message);
    error.code = code;
    return error;
  }

  // Resolve the confirmed deployment's own verified artifact, bound to the provenance hash recorded
  // at deployment. The fast path re-resolves and re-verifies the current on-disk artifact and keeps
  // it only when its fresh provenance still matches. When the disk artifact is missing or its
  // provenance no longer matches, the immutable snapshot captured at deployment is used instead, so
  // a replaced-in-place disk artifact is never adopted as the deployed one. With neither a
  // disk-provenance match nor a snapshot (legacy pre-snapshot deployments), the original resolution
  // error is preserved unchanged.
  function deploymentArtifactForProvenance(operation: JsonAny): JsonAny {
    let disk;
    let diskError;
    try {
      disk = verifiedArtifactForIdentity(operation.artifactIdentity);
    } catch (error) {
      diskError = error;
    }
    // Role-immutable descriptors no longer travel with the artifact envelope: they are deployment-
    // scoped and resolved from the separate deployment-descriptor index (keyed by predicted address),
    // so the artifact resolution here carries only ABI/identity/provenance.
    const snapshot = addressMap.resolveArtifactSnapshot(operation.provenanceHash);
    if (disk !== undefined && disk.provenanceHash?.toLowerCase() === operation.provenanceHash) {
      return disk;
    }
    if (snapshot !== undefined) {
      return {
        abi: snapshot.abi,
        provenanceHash: snapshot.provenanceHash,
        fullyQualifiedName: snapshot.artifactIdentity.fullyQualifiedName,
        artifactIdentity: snapshot.artifactIdentity,
        fromSnapshot: true,
      };
    }
    if (diskError !== undefined) throw diskError;
    throw provenanceFailure('Deployment artifact provenance changed after the contract was mapped');
  }

  function verifiedArtifactForMetadata(metadata: JsonAny): JsonAny {
    // Metadata re-registered through adoption binds its ABI directly to a captured artifact snapshot
    // by provenance hash, because an adopted deployment has no confirmed transaction journal record.
    if (metadata.provenanceHash !== undefined && metadata.provenanceHash !== null) {
      const snapshot = addressMap.resolveArtifactSnapshot(metadata.provenanceHash);
      if (
        snapshot === undefined ||
        snapshot.artifactIdentity.fullyQualifiedName !== metadata.artifactIdentity.fullyQualifiedName
      ) {
        throw provenanceFailure('Adopted contract artifact snapshot is unavailable', 'UNBOUND_ARTIFACT_METADATA');
      }
      return {
        abi: snapshot.abi,
        provenanceHash: snapshot.provenanceHash,
        fullyQualifiedName: snapshot.artifactIdentity.fullyQualifiedName,
        artifactIdentity: snapshot.artifactIdentity,
        fromSnapshot: true,
      };
    }
    const source = journal.get(metadata.sourceTransaction);
    const operation = source?.operationContext;
    if (
      source?.state !== 'confirmed' ||
      operation?.kind !== 'deployment' ||
      operation.artifactIdentity === null ||
      operation.provenanceHash === null
    ) {
      throw provenanceFailure(
        'Contract artifact metadata has no confirmed deployment provenance',
        'UNBOUND_ARTIFACT_METADATA',
      );
    }
    // The parent deployment's provenance is validated (against live disk or its immutable snapshot)
    // before any metadata is honored, including the derived-ProxyAdmin branch below.
    const deploymentArtifact = deploymentArtifactForProvenance(operation);
    if (sameArtifactIdentity(metadata.artifactIdentity, operation.artifactIdentity)) return deploymentArtifact;

    const derivedProxyAdmin = derivedTronProxyAdminIdentity(operation.artifactIdentity);
    if (
      metadata.contractKind === 'proxy-admin' &&
      derivedProxyAdmin !== undefined &&
      sameArtifactIdentity(metadata.artifactIdentity, derivedProxyAdmin)
    ) {
      return verifiedArtifactForIdentity(metadata.artifactIdentity);
    }
    throw provenanceFailure('Contract artifact metadata is not bound to its deployment', 'UNBOUND_ARTIFACT_METADATA');
  }

  async function resolveArtifact(address: JsonAny): Promise<JsonAny> {
    const metadata = metadataFor(address);
    return metadata === undefined ? undefined : verifiedArtifactForMetadata(metadata);
  }

  // A canonical proxy whose runtime immutable cannot be projected must fail rather than serve code that
  // contradicts its reverse-mapped storage: returning an unprojected proxy _admin/_beacon is the exact
  // upgrade-reverting bug this projection closes.
  function unprojectableProxyCode(kind: JsonAny, predicted: JsonAny, cause?: JsonAny): RpcError {
    return new RpcError(
      -32000,
      `Cannot project ${kind} runtime immutables at ${predicted} into the predicted world`,
      { code: 'UNPROJECTABLE_PROXY_CODE' },
      cause === undefined ? undefined : { cause },
    );
  }

  // The artifact-scoped immutable source for a deployment, used only to rebuild role descriptors
  // during eth_getCode enrichment (never a durable write). Returns an AUTHORITATIVE source — empty
  // ranges mean the artifact genuinely declares no such immutable, and the paired runtime-template
  // hash lets the zero-immutable pass-through verify the served code — or undefined when no
  // trustworthy source resolves, letting the caller fail a proxy closed. The durable snapshot's
  // `immutableReferences` are preferred because they survive an on-disk artifact that is gone or
  // replaced; the on-disk artifact's deployedBytecode is the fallback for a legacy snapshot captured
  // before the offsets field existed, honored only when its provenance still equals the provenance
  // recorded for THIS deployment — a replaced-in-place artifact's offsets describe different runtime
  // code and must never be bound. An internally-created ProxyAdmin's metadata points at the parent
  // proxy's deployment (and its provenance), whose offsets do not describe ProxyAdmin code: the
  // derived child resolves its own artifact's reference list instead.
  function immutableReferencesForMetadata(metadata: JsonAny): ImmutableSource | undefined {
    function diskSource(verified: JsonAny): ImmutableSource {
      return {
        ranges: immutableRanges(extractImmutableReferences(verified.artifact?.deployedBytecode)),
        runtimeTemplateHash: runtimeBytecodeTemplateHash(verified.artifact?.deployedBytecode, 'runtime bytecode'),
      };
    }
    let recordedProvenance;
    if (metadata.provenanceHash !== undefined && metadata.provenanceHash !== null) {
      recordedProvenance = metadata.provenanceHash;
    } else {
      const operation = journal.get(metadata.sourceTransaction)?.operationContext;
      recordedProvenance = operation?.provenanceHash ?? undefined;
      const derived = operation === undefined ? undefined : derivedTronProxyAdminIdentity(operation.artifactIdentity);
      if (
        metadata.contractKind === 'proxy-admin' &&
        derived !== undefined &&
        sameArtifactIdentity(metadata.artifactIdentity, derived)
      ) {
        try {
          return diskSource(verifiedArtifactForIdentity(metadata.artifactIdentity));
        } catch {
          return undefined;
        }
      }
    }
    if (recordedProvenance === undefined || recordedProvenance === null) return undefined;
    const snapshot = addressMap.resolveArtifactSnapshot(recordedProvenance);
    if (snapshot?.immutableReferences !== undefined) {
      return { ranges: snapshot.immutableReferences, runtimeTemplateHash: snapshot.runtimeBytecodeHash };
    }
    try {
      const disk = verifiedArtifactForIdentity(metadata.artifactIdentity);
      if (disk.provenanceHash?.toLowerCase() !== String(recordedProvenance).toLowerCase()) return undefined;
      return diskSource(disk);
    } catch {
      return undefined;
    }
  }

  function toPredictedForProjection(actual: string): string | undefined {
    try {
      return addressMap.toPredicted(normalizeEvmAddress(actual));
    } catch {
      return undefined;
    }
  }

  // Rebuild a deployment's role descriptors from the runtime code being served, without any durable
  // write. This is the "retry attempt first" for a deployment whose capture is pending or absent
  // (legacy): the served code IS the actual runtime code at the requested block (the handler read it
  // from the mapped actual address), so its embedded role addresses are read directly and bound against
  // the artifact-scoped offsets. Returns undefined when no offsets are known (references unavailable) or
  // the code cannot be interpreted, letting the caller apply the proxy-vs-contract fail-closed policy.
  function enrichDescriptorsFromCode(
    predicted: JsonAny,
    metadata: JsonAny,
    code: JsonAny,
    source: ImmutableSource,
  ): ImmutableDescriptor[] | undefined {
    const ownActual = addressMap.toActual(predicted);
    if (ownActual === undefined) return undefined;
    try {
      return buildDescriptorsFromRanges(metadata.contractKind, ownActual, code, source.ranges);
    } catch {
      return undefined;
    }
  }

  // Rewrite a predicted contract's runtime code so its role immutables (a UUPS impl's __self, a
  // transparent proxy's _admin, a beacon proxy's _beacon) present their predicted addresses, matching
  // the reverse-mapped TRC-1967 storage slots eth_getStorageAt already serves. The role words come from
  // the deployment-scoped descriptor index (keyed by predicted address); only those words are ever
  // touched, so a non-role address immutable that coincidentally holds a mapped address is left
  // byte-for-byte. A COMPLETE record is an authoritative commitment: a transparent/beacon proxy fails
  // closed when it carries no role descriptor — unless the artifact authoritatively declares no
  // address-width immutable at all (its admin/beacon lives only in the ERC-1967 storage slots, as in
  // the OpenZeppelin v4 proxies), where the raw code embeds no address and passes through — and any
  // descriptor whose committed value drifted from the on-chain code or does not resolve to its mapped
  // predicted address fails closed for a proxy and
  // a contract alike. A pending or absent (legacy) record is enriched ephemerally from the served code;
  // if that cannot yield the required projection a proxy fails closed (signaling a retry / repair) while
  // a plain contract passes through untouched — a non-proxy never fails closed.
  function projectCodeImmutables(predicted: JsonAny, code: JsonAny): JsonAny {
    const metadata = metadataFor(predicted);
    if (metadata === undefined) return code;
    // Empty upstream code (no deployed bytecode — e.g. a historical or pre-deployment block) carries no
    // immutable to project and cannot contradict the reverse-mapped storage slots, so pass it through
    // rather than tripping the proxy fail-closed path below on a legitimately code-less read.
    if (code === '0x' || code === '0x0') return code;
    const proxyKind = metadata.contractKind === 'transparent-proxy' || metadata.contractKind === 'beacon-proxy';
    const requiredRole = metadata.contractKind === 'transparent-proxy' ? 'admin' : 'beacon';
    const record = addressMap.resolveDeploymentDescriptor(predicted);

    if (record !== undefined && record.status === 'complete') {
      const descriptors = record.descriptors;
      if (proxyKind && !descriptors.some((descriptor: JsonAny) => descriptor.role === requiredRole)) {
        // A complete-but-empty record is legitimate for a proxy artifact that declares no address-width
        // immutable (an admin/beacon held only in its ERC-1967 storage slots, as in the OpenZeppelin v4
        // proxies): raw code embeds no address and cannot contradict the reverse-mapped slots. That
        // safety is re-derived on every read, never assumed from the record shape: the authoritative
        // offsets must be empty AND the served code must equal the artifact's runtime template
        // byte-for-byte — provenance does not bind the reference map, so a proxy whose references were
        // stripped still resolves empty ranges, but its live role address makes the served code differ
        // from the template. Anything less fails closed.
        const known = descriptors.length === 0 ? immutableReferencesForMetadata(metadata) : undefined;
        if (known === undefined || hasAddressWidthRange(known.ranges) || !codeMatchesRuntimeTemplate(code, known)) {
          throw unprojectableProxyCode(metadata.contractKind, predicted);
        }
        return code;
      }
      if (descriptors.length === 0) return code;
      try {
        return projectDescriptorImmutables(code, descriptors, predicted, toPredictedForProjection);
      } catch (error) {
        // A completed descriptor is an authoritative commitment: a drifted or unresolvable role
        // immutable fails closed for a proxy and a contract alike rather than serving contradicting code.
        throw unprojectableProxyCode(metadata.contractKind, predicted, error);
      }
    }

    // Pending or absent (legacy): enrich ephemerally from the served code. No durable write here; the
    // durable pending->complete transition happens only in a write context (recovery / repair).
    const source = immutableReferencesForMetadata(metadata);
    const descriptors = source === undefined ? undefined : enrichDescriptorsFromCode(predicted, metadata, code, source);
    if (descriptors === undefined || source === undefined) {
      if (proxyKind) throw unprojectableProxyCode(metadata.contractKind, predicted);
      return code;
    }
    // An empty enrichment is authoritative here: the ranges resolved (else `undefined` above) and held
    // no address-width entry, so the code embeds no address and passes through. A proxy kind must also
    // match the artifact's runtime template byte-for-byte (see the complete-record branch above).
    if (descriptors.length === 0) {
      if (proxyKind && !codeMatchesRuntimeTemplate(code, source)) {
        throw unprojectableProxyCode(metadata.contractKind, predicted);
      }
      return code;
    }
    if (proxyKind && !descriptors.some(descriptor => descriptor.role === requiredRole)) {
      throw unprojectableProxyCode(metadata.contractKind, predicted);
    }
    try {
      return projectDescriptorImmutables(code, descriptors, predicted, toPredictedForProjection);
    } catch (error) {
      // Ephemeral projection could not resolve: a proxy must not serve an unprojected role word, but a
      // plain contract passes through untouched (a non-proxy never fails closed on the read path).
      if (proxyKind) throw unprojectableProxyCode(metadata.contractKind, predicted, error);
      return code;
    }
  }

  async function readStorageAddress(target: JsonAny, slot: JsonAny): Promise<string> {
    const value = await upstream.request('eth_getStorageAt', [mappedAddress(target), slot, 'latest']);
    if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) {
      throw new Error('Upstream returned invalid address storage');
    }
    return normalizeEvmAddress(`0x${value.slice(-40)}`, 'stored contract address');
  }

  async function resolveBeaconImplementation(beacon: JsonAny): Promise<string> {
    const result = await upstream.request('eth_call', [
      { to: mappedAddress(beacon), data: IMPLEMENTATION_SELECTOR },
      'latest',
    ]);
    if (typeof result !== 'string' || !/^0x[0-9a-f]{64}$/i.test(result)) {
      throw new Error('Beacon implementation query returned invalid data');
    }
    return normalizeEvmAddress(`0x${result.slice(-40)}`, 'beacon implementation');
  }

  async function defaultResolveCallContext(target: JsonAny): Promise<JsonAny> {
    const metadata = metadataFor(target);
    if (metadata === undefined) return undefined;
    const targetArtifact = verifiedArtifactForMetadata(metadata);
    let artifactAddress = target;
    if (metadata.contractKind === 'uups-proxy' || metadata.contractKind === 'transparent-proxy') {
      artifactAddress = await readStorageAddress(target, IMPLEMENTATION_SLOT);
    } else if (metadata.contractKind === 'beacon-proxy') {
      const beacon = await readStorageAddress(target, BEACON_SLOT);
      artifactAddress = await resolveBeaconImplementation(beacon);
    }
    const artifact = artifactAddress === target ? targetArtifact : await resolveArtifact(artifactAddress);
    if (artifact === undefined) {
      const error: JsonAny = new Error('Target implementation artifact metadata is unavailable');
      error.code = 'MISSING_ARTIFACT_METADATA';
      throw error;
    }
    return {
      targetKind: metadata.contractKind,
      abi: artifact.abi ?? artifact.artifact?.abi,
      artifactIdentity: metadata.artifactIdentity,
      provenanceHash: artifact.provenanceHash ?? null,
    };
  }

  const resolveCallContext = options.resolveCallContext ?? defaultResolveCallContext;
  const rewriteDependencies = { addressMap, resolveArtifact, resolveBeaconImplementation };

  // Verify, against live on-chain state, that an externally-deployed target actually has the topology
  // the recognized upgrade selector implies. Any mismatch or read failure returns false, so the caller
  // declines the rewrite and falls back to the existing fail-closed opaque rejection.
  async function verifyExternalUpgradeTopology(descriptor: JsonAny, target: JsonAny, values: JsonAny[]): Promise<boolean> {
    if (descriptor.kind === 'uups') {
      return (await readStorageAddress(target, IMPLEMENTATION_SLOT)) !== ZERO_ADDRESS;
    }
    if (descriptor.kind === 'beacon') {
      return (await resolveBeaconImplementation(target)) !== ZERO_ADDRESS;
    }
    // proxy-admin: the target must be the TRC-1967 admin recorded in the proxy argument's admin slot.
    const admin = await readStorageAddress(values[descriptor.proxyIndex], ADMIN_SLOT);
    return admin === normalizeEvmAddress(mappedAddress(target));
  }

  // Recognize an upgrade call to an externally-deployed proxy, ProxyAdmin, or beacon (a target with no
  // gateway metadata) that embeds a gateway predicted implementation address. On a verified match this
  // returns the calldata with only the implementation argument rewritten predicted -> actual; every
  // other byte is preserved. It returns undefined for any non-matching shape, unknown implementation,
  // intact-provenance failure, or topology mismatch, so the caller's opaque safety check produces the
  // existing fail-closed rejection unchanged.
  async function recognizeExternalUpgrade(target: JsonAny, data: JsonAny): Promise<string | undefined> {
    if (typeof data !== 'string' || data.length < 10) return undefined;
    let fragment;
    let values: JsonAny[];
    try {
      fragment = EXTERNAL_UPGRADE_INTERFACE.getFunction(data.slice(0, 10));
      if (fragment === null) return undefined;
      const decoded = EXTERNAL_UPGRADE_INTERFACE.decodeFunctionData(fragment, data);
      if (EXTERNAL_UPGRADE_INTERFACE.encodeFunctionData(fragment, decoded).toLowerCase() !== data.toLowerCase()) {
        return undefined;
      }
      values = decoded.toArray();
    } catch {
      return undefined;
    }
    const descriptor = EXTERNAL_UPGRADE_DESCRIPTORS.get(fragment.name);
    if (descriptor === undefined) return undefined;
    // Only a gateway predicted implementation with a confirmed actual mapping is a rewrite candidate;
    // anything else defers to opaque handling without probing the target.
    const actualImplementation = addressMap.toActual(normalizeEvmAddress(values[descriptor.implementationIndex]));
    if (actualImplementation === undefined) return undefined;
    try {
      // The implementation's provenance must be intact, resolved through the same verified-artifact
      // machinery used for metadata-bearing targets, and the target's live topology must match.
      if ((await resolveArtifact(actualImplementation)) === undefined) return undefined;
      if (!(await verifyExternalUpgradeTopology(descriptor, target, values))) return undefined;
    } catch {
      return undefined;
    }
    values[descriptor.implementationIndex] = actualImplementation;
    return EXTERNAL_UPGRADE_INTERFACE.encodeFunctionData(fragment, values);
  }

  // The opaque-path calldata gate: recognize an external upgrade and rewrite only its implementation
  // argument, otherwise leave the bytes untouched. The final safety scan runs on the resulting bytes,
  // so a rewritten implementation passes while any other embedded predicted address still fails closed.
  async function opaqueCallData(target: JsonAny, data: JsonAny): Promise<JsonAny> {
    const upgraded = await recognizeExternalUpgrade(target, data);
    const finalData = upgraded ?? data;
    await opaqueSafety(finalData, rewriteDependencies);
    return finalData;
  }

  // Reverse-map a single decoded value against its ABI type: an exact-width `address` whose value is a
  // mapped actual address becomes its predicted address; arrays and tuples are walked structurally.
  // Every other ABI type (including a uint256 that happens to look like an address) is left untouched,
  // so translation is strictly type-driven and never a raw byte heuristic.
  function reverseMapValue(param: JsonAny, value: JsonAny): { value: JsonAny; changed: boolean } {
    if (param.baseType === 'address') {
      let normalized;
      try {
        normalized = normalizeEvmAddress(value);
      } catch {
        return { value, changed: false };
      }
      const predicted = addressMap.toPredicted(normalized);
      return predicted === undefined ? { value, changed: false } : { value: getAddress(predicted), changed: true };
    }
    const children =
      param.baseType === 'array'
        ? (value?.toArray?.() ?? (Array.isArray(value) ? value : undefined))
        : undefined;
    if (param.baseType === 'array' && children !== undefined) {
      let changed = false;
      const mapped = children.map((item: JsonAny) => {
        const result = reverseMapValue(param.arrayChildren, item);
        if (result.changed) changed = true;
        return result.value;
      });
      return { value: mapped, changed };
    }
    if (param.baseType === 'tuple') {
      const tuple = value?.toArray?.() ?? (Array.isArray(value) ? value : undefined);
      if (tuple === undefined) return { value, changed: false };
      let changed = false;
      const mapped = (param.components as JsonAny[]).map((component, index) => {
        const result = reverseMapValue(component, tuple[index]);
        if (result.changed) changed = true;
        return result.value;
      });
      return { value: mapped, changed };
    }
    return { value, changed: false };
  }

  // Reverse-map any mapped actual address in an eth_call return, decoding it through the resolved
  // target ABI and re-encoding only if an address actually changed. On any decode/encode failure, or a
  // target without metadata, the raw upstream bytes are returned unchanged.
  function translateCallResult(context: JsonAny, callData: JsonAny, result: JsonAny): JsonAny {
    if (context === undefined || !Array.isArray(context.abi)) return result;
    if (typeof result !== 'string' || result === '0x' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(result)) return result;
    if (typeof callData !== 'string' || callData.length < 10) return result;
    try {
      const iface = new Interface(context.abi);
      const fragment = iface.getFunction(callData.slice(0, 10));
      if (fragment === null) return result;
      const values = iface.decodeFunctionResult(fragment, result).toArray();
      let changed = false;
      const mapped = (fragment.outputs as JsonAny[]).map((param, index) => {
        const outcome = reverseMapValue(param, values[index]);
        if (outcome.changed) changed = true;
        return outcome.value;
      });
      return changed ? iface.encodeFunctionResult(fragment, mapped) : result;
    } catch {
      return result;
    }
  }

  // Reverse-map a stored TRC-1967 slot value: a canonical address word (high 12 bytes zero) whose low
  // 20 bytes are a mapped actual address is rewritten to its predicted address. Non-TRC-1967 slots and
  // non-address words are returned byte-for-byte.
  function translateStorageValue(slot: JsonAny, value: JsonAny): JsonAny {
    if (typeof slot !== 'string' || !TRC1967_SLOTS.has(slot.toLowerCase())) return value;
    if (typeof value !== 'string' || !/^0x0{24}[0-9a-fA-F]{40}$/.test(value)) return value;
    let predicted;
    try {
      predicted = addressMap.toPredicted(normalizeEvmAddress(`0x${value.slice(-40)}`));
    } catch {
      return value;
    }
    return predicted === undefined ? value : `0x${'0'.repeat(24)}${normalizeEvmAddress(predicted).slice(2)}`;
  }

  // Rewrite a read transaction's addresses and calldata for the upstream node, returning the rewritten
  // transaction alongside the resolved target context so an eth_call response can be translated through
  // the same ABI without re-resolving (and re-reading) the target.
  async function rewriteReadTransaction(
    transaction: JsonAny,
    deploymentEstimate = false,
  ): Promise<{ transaction: JsonAny; context: JsonAny }> {
    if (!isObject(transaction)) throw new RpcError(-32602, 'Invalid transaction call object');
    if (own(transaction, 'data') && own(transaction, 'input') && transaction.data !== transaction.input) {
      throw new RpcError(-32602, 'Transaction data and input conflict');
    }
    const dataKey = own(transaction, 'input') && !own(transaction, 'data') ? 'input' : 'data';
    const data = transaction[dataKey] ?? '0x';
    if (transaction.to === undefined || transaction.to === null) {
      if (!deploymentEstimate) return { transaction: { ...transaction }, context: undefined };
      const match = matchArtifact({ outputDirectory: config.foundryOut, initcode: data });
      const deployment = await rewriteDeploy(match, rewriteDependencies);
      return {
        transaction: {
          ...transaction,
          ...(transaction.from === undefined ? {} : { from: mappedAddress(transaction.from) }),
          [dataKey]: deployment.initcode,
        },
        context: undefined,
      };
    }
    const target = normalizeEvmAddress(transaction.to, 'transaction target');
    const context = await resolveCallContext(target);
    let rewritten;
    if (context === undefined) {
      const finalData = await opaqueCallData(target, data);
      rewritten = { ...transaction, to: mappedAddress(target), [dataKey]: finalData };
    } else {
      const call = await rewriteContractCall({ ...transaction, to: target, data }, context, rewriteDependencies);
      rewritten = { ...transaction, ...call, [dataKey]: call.data };
      if (dataKey === 'input') delete rewritten.data;
    }
    if (transaction.from !== undefined) rewritten.from = mappedAddress(transaction.from);
    return { transaction: rewritten, context };
  }

  async function waitAndReconcile(record: JsonAny): Promise<JsonAny> {
    const receipt = await nativeClient.waitForReceipt(record.nativeTransactionId, receiptContext(addressMap, record));
    return reconciler.reconcile(record.sourceTransactionHash, receipt).receipt;
  }

  // Read the raw actual runtime code at an on-chain address directly from upstream (no predicted->actual
  // mapping and no projection), so descriptor capture can bind role immutables to the actual values the
  // live code carries. The artifact's deployedBytecode cannot supply them (its immutable words are
  // zeroed).
  async function readActualRuntimeCode(actual: JsonAny): Promise<string> {
    const code = await upstream.request('eth_getCode', [actual, 'latest']);
    if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(code)) {
      throw new Error('Upstream returned invalid runtime code for descriptor capture');
    }
    return code;
  }

  // The artifact-scoped immutable byte ranges to persist on a deployment's snapshot, flattened from the
  // solc deployedBytecode.immutableReferences map. Returns undefined on a malformed map so the snapshot
  // is written in its original (offset-less) shape rather than failing an already-confirmed deployment.
  function snapshotImmutableReferences(deployedBytecode: JsonAny): ImmutableRange[] | undefined {
    try {
      return immutableRanges(extractImmutableReferences(deployedBytecode));
    } catch {
      return undefined;
    }
  }

  // Capture the deployment's semantic role-immutable descriptors from its ACTUAL on-chain runtime code,
  // returning both the capture status and the descriptors. The upstream code is read only when the
  // artifact declares an address-width immutable, so the common no-immutable contract does no upstream
  // read and completes with an empty list. The read is retried a bounded number of times to absorb a
  // transient failure or a not-yet-populated ('0x') body under read-your-writes / node lag. On
  // persistent read failure the status is `pending` (a later verified read completes it); a malformed
  // reference map is likewise pending — it is an unresolvable source, not proof of no immutables.
  // Nothing is thrown: a CONFIRMED deployment must never fail on capture. Must be called once the
  // deployment's actual code is on chain (post-confirmation).
  async function captureDescriptorsBestEffort(
    actualTarget: JsonAny,
    kind: JsonAny,
    ownActual: JsonAny,
    deployedBytecode: JsonAny,
  ): Promise<{ status: 'pending' | 'complete'; descriptors: ImmutableDescriptor[] }> {
    let ranges;
    try {
      ranges = immutableRanges(extractImmutableReferences(deployedBytecode));
    } catch {
      // A malformed reference map is an UNRESOLVABLE source, not proof of "no immutables": completing
      // empty would durably assert nothing-to-project for a deployment whose immutables are unknown
      // (and repair skips complete records). Pending keeps it repairable from a valid artifact.
      return { status: 'pending', descriptors: [] };
    }
    if (!ranges.some(range => range.length >= 20)) return { status: 'complete', descriptors: [] };
    for (let attempt = 1; attempt <= DESCRIPTOR_CAPTURE_ATTEMPTS; attempt += 1) {
      try {
        const code = await readActualRuntimeCode(actualTarget);
        return { status: 'complete', descriptors: buildDescriptorsFromRanges(kind, ownActual, code, ranges) };
      } catch {
        if (attempt < DESCRIPTOR_CAPTURE_ATTEMPTS) await delay(captureRetryDelayMs);
      }
    }
    return { status: 'pending', descriptors: [] };
  }

  // Persist a deployment's captured descriptors keyed by predicted address, guarded and best-effort:
  // the predicted->actual mapping must already exist (it is written by the reconciler at confirm), and a
  // confirmed deployment must never fail on descriptor persistence, so a missing mapping is skipped and
  // any transition refusal (e.g. a re-sent deploy whose recapture would regress a completed record to
  // pending) is swallowed. The snapshot and descriptor are separate store transactions; both idempotent.
  function persistDeploymentDescriptor(
    predicted: JsonAny,
    capture: { status: 'pending' | 'complete'; descriptors: ImmutableDescriptor[] },
  ): void {
    if (predicted === undefined || predicted === null) return;
    try {
      if (addressMap.resolvePredicted(predicted) === undefined) return;
      addressMap.setDeploymentDescriptor({ predicted, status: capture.status, descriptors: capture.descriptors });
    } catch {
      // Best-effort: never fail an already-confirmed deployment on descriptor persistence.
    }
  }

  // The prepared-native journal record, its artifact snapshot, and its deployment descriptor are
  // persisted in separate store transactions, so a crash between them can leave a prepared deployment
  // with no snapshot and/or no completed descriptor. Rebuild whatever is missing from the on-disk
  // artifact once the resumed transaction has confirmed (so its actual runtime code is readable for
  // descriptor binding), but only when the freshly re-resolved artifact's provenance still matches the
  // journaled one. A changed or unresolvable artifact leaves the no-snapshot behavior, which refuses a
  // later resolution rather than binding a mismatched artifact to this deployment. This is the recovery
  // durable-transition site: a pending descriptor whose read now succeeds is completed here.
  async function reconstructMissingSnapshot(record: JsonAny): Promise<void> {
    const operation = record?.operationContext;
    if (
      operation === undefined ||
      operation.kind !== 'deployment' ||
      operation.artifactIdentity === null ||
      operation.artifactIdentity === undefined ||
      operation.provenanceHash === null ||
      operation.provenanceHash === undefined
    ) {
      return;
    }
    const existingSnapshot = addressMap.resolveArtifactSnapshot(operation.provenanceHash);
    const snapshotHasOffsets = existingSnapshot?.immutableReferences !== undefined;
    const descriptorRecord =
      operation.predictedContractAddress === undefined || operation.predictedContractAddress === null
        ? undefined
        : addressMap.resolveDeploymentDescriptor(operation.predictedContractAddress);
    // Fully durable already: the snapshot carries offsets AND the descriptor is complete. A snapshot
    // that exists but is offset-less (a legacy pre-offsets capture) is NOT durable for a completed
    // descriptor — a later read would fall back to the on-disk artifact and fail closed once it is
    // gone — so recovery proceeds to enrich it below rather than skipping on snapshot existence alone.
    if (snapshotHasOffsets && descriptorRecord?.status === 'complete') return;
    let verified;
    try {
      verified = verifiedArtifactForIdentity(operation.artifactIdentity);
    } catch {
      return;
    }
    if (verified.provenanceHash?.toLowerCase() !== operation.provenanceHash) return;
    // Capture never throws; the base envelope is always persisted exactly once (with the artifact-scoped
    // immutable offsets), so a confirmed deployment never loses its ABI-orphan protection to a transient
    // post-confirmation read failure. The per-deployment descriptor is written separately, keyed by
    // predicted address.
    const capture = await captureDescriptorsBestEffort(
      operation.actualTarget,
      operation.contractKind,
      operation.actualTarget,
      verified.artifact?.deployedBytecode,
    );
    const references = snapshotImmutableReferences(verified.artifact?.deployedBytecode);
    if (existingSnapshot === undefined) {
      addressMap.setArtifactSnapshot({
        provenanceHash: operation.provenanceHash,
        artifactIdentity: operation.artifactIdentity,
        contractKind: operation.contractKind,
        abi: verified.artifact?.abi,
        creationBytecodeHash: bytecodeHash(verified.artifact?.bytecode, 'creation bytecode'),
        runtimeBytecodeHash: runtimeBytecodeTemplateHash(verified.artifact?.deployedBytecode, 'runtime bytecode'),
        ...(references === undefined ? {} : { immutableReferences: references }),
      });
    } else if (!snapshotHasOffsets && references !== undefined) {
      // Enrich a legacy offset-less snapshot in place (an offsets-only difference the snapshot store
      // reconciles) so a descriptor completed by this recovery resolves durable offsets on later reads.
      addressMap.setArtifactSnapshot({ ...existingSnapshot, immutableReferences: references });
    }
    persistDeploymentDescriptor(operation.predictedContractAddress, capture);
  }

  async function resumePrepared(record: JsonAny): Promise<JsonAny> {
    const snapshot = await nativeClient.getTransaction(record.nativeTransactionId);
    if (snapshot === null) {
      await nativeClient.broadcastSigned(record.signedNativeTransaction, record.nativeTransactionId);
    }
    let current = journal.get(record.sourceTransactionHash);
    if (current.state === 'native-built') current = journal.recordBroadcast(record.sourceTransactionHash);
    await waitAndReconcile(current);
    // Reconstruct the crash-lost snapshot only after confirmation, when the deployment's actual runtime
    // code is on chain and its role immutables can be bound.
    await reconstructMissingSnapshot(record);
    return record.sourceTransactionHash;
  }

  async function processClaimed(raw: JsonAny, sourceHash: JsonAny): Promise<JsonAny> {
    try {
      await nativeClient.assertSimulationReady();
      const decoded = decode(raw, { expectedSender: config.expectedSender, expectedChainId: config.chainId });
      let built;
      let operationContext;
      let deploymentCapture;
      if (decoded.kind === 'deployment') {
        const match = matchArtifact({ outputDirectory: config.foundryOut, initcode: decoded.data });
        const rewritten = await rewriteDeploy(match, rewriteDependencies);
        built = await nativeClient.buildCreate({
          abi: rewritten.abi ?? rewritten.artifact?.abi,
          bytecode: rewritten.creationBytecode,
          constructorData: rewritten.constructorData,
          ownerAddress: decoded.from,
          name: rewritten.contractName,
          callValue: decoded.callValue,
        });
        const identity = artifactIdentity(rewritten);
        operationContext = {
          kind: 'deployment',
          from: decoded.from,
          to: null,
          nonce: String(decoded.nonce),
          predictedContractAddress: getCreateAddress({ from: decoded.from, nonce: decoded.nonce }).toLowerCase(),
          actualTarget: nativeContractAddress(built.nativeTransactionId, decoded.from),
          contractKind: contractKindForArtifact(identity),
          artifactIdentity: identity,
          provenanceHash: rewritten.provenanceHash,
        };
        // Capture the verified artifact envelope from this just-verified deployment match, so a later
        // in-place replacement of the same-named on-disk artifact cannot orphan this deployment's ABI.
        // The role-immutable descriptors are bound after confirmation (see below), when the deployment's
        // actual runtime code is on chain to read the embedded values from.
        deploymentCapture = {
          base: {
            provenanceHash: operationContext.provenanceHash,
            artifactIdentity: identity,
            contractKind: operationContext.contractKind,
            abi: rewritten.abi ?? rewritten.artifact?.abi,
            creationBytecodeHash: bytecodeHash(match.creationBytecode, 'creation bytecode'),
            runtimeBytecodeHash: runtimeBytecodeTemplateHash(match.artifact?.deployedBytecode, 'runtime bytecode'),
          },
          deployedBytecode: match.artifact?.deployedBytecode,
        };
      } else {
        const context = await resolveCallContext(decoded.to);
        let rewritten;
        if (context === undefined) {
          const finalData = await opaqueCallData(decoded.to, decoded.data);
          rewritten = { ...decoded, to: mappedAddress(decoded.to), data: finalData };
        } else {
          rewritten = await rewriteContractCall(decoded, context, rewriteDependencies);
        }
        built = await nativeClient.buildCall({
          contractAddress: rewritten.to,
          data: rewritten.data,
          ownerAddress: decoded.from,
          callValue: decoded.callValue,
        });
        operationContext = {
          kind: 'call',
          from: decoded.from,
          to: decoded.to,
          nonce: String(decoded.nonce),
          predictedContractAddress: null,
          actualTarget: rewritten.to,
          contractKind: context?.targetKind ?? null,
          artifactIdentity: context?.artifactIdentity ?? null,
          provenanceHash: context?.provenanceHash ?? null,
        };
      }

      const native = {
        signedNativeTransaction: built.signedNativeTransaction,
        nativeTransactionId: built.nativeTransactionId,
      };
      const simulation = await nativeClient.simulateSigned(
        native.signedNativeTransaction,
        native.nativeTransactionId,
        built.transaction,
      );
      const prepared = reconciler.recordPreparedNative(sourceHash, native, simulation, operationContext);
      await nativeClient.broadcastSigned(prepared.signedNativeTransaction, prepared.nativeTransactionId);
      const broadcast = journal.recordBroadcast(sourceHash);
      await waitAndReconcile(broadcast);
      // Persist the deployment's immutable artifact envelope once the transaction has confirmed, so the
      // deployment's actual runtime code is on chain to bind its role-immutable descriptors from. The
      // snapshot is keyed by provenance hash and never overwritten, so a re-prepared or recovered
      // deployment reuses the identical envelope. Descriptor capture is best-effort and never throws:
      // the base envelope is always persisted exactly once with whatever descriptors were captured ([]
      // on a persistent capture failure), rather than failing the already-confirmed transaction or
      // dropping the base snapshot; a later read then fails closed for a proxy (signaling re-adopt) as
      // an absent snapshot does.
      if (deploymentCapture !== undefined) {
        const capture = await captureDescriptorsBestEffort(
          operationContext.actualTarget,
          operationContext.contractKind,
          operationContext.actualTarget,
          deploymentCapture.deployedBytecode,
        );
        const references = snapshotImmutableReferences(deploymentCapture.deployedBytecode);
        addressMap.setArtifactSnapshot({
          ...deploymentCapture.base,
          ...(references === undefined ? {} : { immutableReferences: references }),
        });
        persistDeploymentDescriptor(operationContext.predictedContractAddress, capture);
      }
      return sourceHash;
    } catch (error) {
      const current = journal.get(sourceHash);
      if (current?.state === 'received' && !retryableTransportError(error)) {
        journal.recordFailed(sourceHash, {
          code: failureCode(error),
          message: (error as JsonAny)?.message || 'Translation failed',
        });
      }
      throw error;
    }
  }

  function runTracked(sourceHash: JsonAny, callback: JsonAny): Promise<JsonAny> {
    const active = inFlight.get(sourceHash);
    if (active !== undefined) return active;
    const promise = Promise.resolve()
      .then(callback)
      .finally(() => inFlight.delete(sourceHash));
    inFlight.set(sourceHash, promise);
    return promise;
  }

  // Admit a fresh or retried source build through the per-signer nonce-ordered queue, which releases
  // it only when it is the signer's next expected nonce. A transaction that cannot be decoded has no
  // orderable nonce, so it bypasses the queue and processes immediately, recording the same
  // deterministic decode failure it would have before.
  function enqueueBuild(rawTransaction: JsonAny, hash: JsonAny): Promise<JsonAny> {
    let routing;
    try {
      routing = decode(rawTransaction, { expectedSender: config.expectedSender, expectedChainId: config.chainId });
    } catch {
      return runTracked(hash, () => processClaimed(rawTransaction, hash));
    }
    return queue.enqueue(routing.from, BigInt(routing.nonce), hash, () =>
      runTracked(hash, () => processClaimed(rawTransaction, hash)),
    );
  }

  async function sendRawTransaction(raw: JsonAny): Promise<JsonAny> {
    if (typeof raw !== 'string') throw new RpcError(-32602, 'Invalid signed transaction bytes');
    const received = journal.receive(raw);
    const hash = received.record.sourceTransactionHash;
    if (received.shouldBuild) return enqueueBuild(received.record.signedEthereumTransaction, hash);
    const active = queue.get(hash) ?? inFlight.get(hash);
    if (active !== undefined) return active;
    const record = journal.get(hash);
    if (record.state === 'confirmed') return hash;
    if (record.state === 'failed')
      throw Object.assign(new Error(record.failure.message), { code: record.failure.code });
    if (record.state === 'received') {
      if (record.buildClaimOwner === journal.ownerId) {
        return enqueueBuild(record.signedEthereumTransaction, hash);
      }
      const error: JsonAny = new Error('Source transaction native build is owned by another live handler');
      error.code = 'TRANSACTION_IN_PROGRESS';
      throw error;
    }
    return runTracked(hash, () => resumePrepared(record));
  }

  async function resolveAddress(value: JsonAny): Promise<JsonAny> {
    const normalized = normalizeEvmAddress(value);
    if (normalized === ZERO_ADDRESS) {
      const encoded = normalizeAddress(normalized);
      return {
        predicted: normalized,
        actual: normalized,
        tronHex: encoded.tronHex,
        base58: encoded.base58,
        mapping: null,
        metadata: null,
      };
    }
    const byPredicted = addressMap.resolvePredicted(normalized);
    const byActual = byPredicted === undefined ? addressMap.resolveActual(normalized) : undefined;
    const mapping = byPredicted ?? byActual;
    const predicted = mapping?.predicted ?? normalized;
    const actual = mapping?.actual ?? normalized;
    const encoded = normalizeAddress(actual);
    return {
      predicted,
      actual,
      tronHex: encoded.tronHex,
      base58: encoded.base58,
      mapping: mapping ?? null,
      metadata: metadataFor(predicted) ?? null,
    };
  }

  async function dispatch(method: JsonAny, params: JsonAny): Promise<JsonAny> {
    switch (method) {
      case 'eth_chainId':
        requirePositional(params, 0);
        return quantity(config.chainId);
      case 'net_version':
        requirePositional(params, 0);
        return config.chainId.toString(10);
      case 'eth_accounts':
        requirePositional(params, 0);
        return [getAddress(config.expectedSender)];
      case 'eth_sendRawTransaction': {
        const [raw] = requirePositional(params, 1);
        return sendRawTransaction(raw);
      }
      case 'eth_getTransactionReceipt': {
        const [hashValue] = requirePositional(params, 1);
        const hash = normalizeHash(hashValue);
        const record = journal.get(hash);
        return record === undefined
          ? upstream.request(method, params)
          : record.state === 'confirmed'
            ? record.receipt
            : null;
      }
      case 'eth_getTransactionByHash': {
        const [hashValue] = requirePositional(params, 1);
        const hash = normalizeHash(hashValue);
        const record = journal.get(hash);
        return record === undefined
          ? upstream.request(method, params)
          : record.state === 'failed' && record.nativeTransactionId === undefined
            ? null
            : ethereumTransaction(record);
      }
      case 'eth_getCode': {
        const [address, block] = requirePositional(params, 1, 2);
        const normalized = normalizeEvmAddress(address);
        const rewritten = [mappedAddress(normalized), ...(block === undefined ? [] : [block])];
        const code = await requestStockCompatibleRead(upstream, method, rewritten, block);
        // Only a predicted, gateway-mapped address reads the projected (predicted-world) code; an
        // actual, unmapped, or zero address reads the raw upstream code byte-for-byte.
        if (normalized === ZERO_ADDRESS || addressMap.resolvePredicted(normalized) === undefined) return code;
        return projectCodeImmutables(normalized, code);
      }
      case 'eth_getBalance': {
        const [address, block] = requirePositional(params, 1, 2);
        const rewritten = [mappedAddress(address), ...(block === undefined ? [] : [block])];
        return requestStockCompatibleRead(upstream, method, rewritten, block);
      }
      case 'eth_getStorageAt': {
        const [address, slot, block] = requirePositional(params, 2, 3);
        const rewritten = [mappedAddress(address), slot, ...(block === undefined ? [] : [block])];
        const value = await requestStockCompatibleRead(upstream, method, rewritten, block);
        return translateStorageValue(slot, value);
      }
      case 'eth_getTransactionCount': {
        const [address, block] = requirePositional(params, 1, 2);
        return virtualTransactionCount(
          journal,
          config.expectedSender,
          address,
          block,
          decode,
          config.chainId,
          nonceBaselineFor(config.expectedSender),
        );
      }
      case 'eth_call':
      case 'eth_estimateGas': {
        const [transaction, block] = requirePositional(params, 1, 2);
        const { transaction: rewritten, context } = await rewriteReadTransaction(
          transaction,
          method === 'eth_estimateGas',
        );
        const rewrittenParams = [rewritten, ...(block === undefined ? [] : [block])];
        if (method === 'eth_estimateGas') return upstream.request(method, rewrittenParams);
        const result = await requestStockCompatibleRead(upstream, method, rewrittenParams, block);
        return translateCallResult(context, rewritten.data ?? rewritten.input, result);
      }
      case 'eth_gasPrice':
        requirePositional(params, 0);
        return upstream.request(method, []);
      case 'eth_getBlockByHash':
      case 'eth_getBlockByNumber': {
        requirePositional(params, 2);
        return normalizeUpstreamBlock(await upstream.request(method, params));
      }
      case 'eth_getLogs': {
        // A log query crosses the address boundary in both directions. Inbound, the caller's filter
        // is expressed in predicted addresses the node has never heard of, so map its address/topics
        // to the actual world before forwarding (otherwise it matches nothing). Outbound, each
        // returned log carries actual addresses in its emitter, topics, and data; reverse-map them so
        // the caller only ever sees the predicted world. Addresses outside the gateway map, and
        // non-address words, pass through untouched.
        const forwarded = await upstream.request(method, mapFilterParams(params, actual => mappedAddress(actual)));
        if (!Array.isArray(forwarded)) return forwarded;
        return forwarded.map((log: JsonAny) => mapLogEntry(log, actual => addressMap.toPredicted(actual) ?? actual));
      }
      case 'tron_resolveAddress': {
        const [address] = requirePositional(params, 1);
        return resolveAddress(address);
      }
      default:
        if (FORWARDED_METHODS.has(method)) return upstream.request(method, params);
        throw new RpcError(-32601, 'Method not found');
    }
  }

  async function handleOne(request: JsonAny): Promise<JsonAny> {
    if (!validRequest(request)) return responseError(null, new RpcError(-32600, 'Invalid Request'));
    const notification = !own(request, 'id');
    const id = notification ? undefined : request.id;
    try {
      const result = await dispatch(request.method, request.params ?? []);
      return notification ? undefined : { jsonrpc: JSON_RPC_VERSION, id, result };
    } catch (error) {
      return notification ? undefined : responseError(id, error);
    }
  }

  async function handle(payload: JsonAny): Promise<JsonAny> {
    if (!Array.isArray(payload)) return handleOne(payload);
    if (payload.length === 0) return responseError(null, new RpcError(-32600, 'Invalid Request'));
    const responses = (await Promise.all(payload.map(handleOne))).filter(response => response !== undefined);
    return responses.length === 0 ? undefined : responses;
  }

  // The ascending recovery-ordering key for a persisted record: its native operation nonce when a
  // preparation is present, else the decoded source nonce, else a sentinel that sorts undecodable
  // records last.
  function recoveryNonce(record: JsonAny): bigint {
    if (record.operationContext !== undefined) return BigInt(record.operationContext.nonce);
    try {
      return BigInt(
        decode(record.signedEthereumTransaction, {
          expectedSender: config.expectedSender,
          expectedChainId: config.chainId,
        }).nonce,
      );
    } catch {
      return BigInt(Number.MAX_SAFE_INTEGER);
    }
  }

  async function recoverStartup(capability: JsonAny): Promise<string[]> {
    assertStateLockHeld(capability, config.stateFile);
    // From here on, every durable state mutation re-asserts that this exclusive lock is still
    // held before it writes, so no write can land after the lock is lost or taken over.
    if (typeof journal.store?.bindLockAssertion === 'function') {
      journal.store.bindLockAssertion(() => assertStateLockHeld(capability, config.stateFile));
    }
    const recovered = [];
    // Replay interrupted work in ascending source-nonce order so a dependent transaction is never
    // reprocessed before the predecessor whose address mapping it relies on, mirroring the live
    // per-signer nonce ordering. Records whose nonce cannot be recovered sort last, where they fail
    // deterministically on reprocessing as they would in the live path.
    const pending = journal
      .list()
      .filter((record: JsonAny) => record.state !== 'confirmed' && record.state !== 'failed')
      .map((record: JsonAny) => ({ record, nonce: recoveryNonce(record) }))
      .sort((left: JsonAny, right: JsonAny) => (left.nonce < right.nonce ? -1 : left.nonce > right.nonce ? 1 : 0));
    for (const { record: persisted } of pending) {
      const hash = persisted.sourceTransactionHash;
      if (persisted.state === 'received') {
        const claimed = journal.recoverReceived(hash, persisted.buildClaimOwner);
        await runTracked(hash, () => processClaimed(claimed.record.signedEthereumTransaction, hash));
      } else {
        await runTracked(hash, () => resumePrepared(persisted));
      }
      recovered.push(hash);
    }
    return recovered;
  }

  return Object.freeze({ dispatch, handle, recoverStartup });
}

export { RpcError, contractKindForArtifact, createRpcHandlers, nativeContractAddress };
