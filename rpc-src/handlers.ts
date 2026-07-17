import path from 'node:path';

import { Interface, Transaction, concat, dataSlice, getAddress, getCreateAddress, keccak256, toUtf8Bytes } from 'ethers';

import { normalizeAddress, toEvmAddress } from './address-codec.js';
import { canonicalTronFullyQualifiedName, derivedTronProxyAdminIdentity } from './artifact-identities.js';
import type { ArtifactIdentity } from './artifact-identities.js';
import { findArtifactPaths, matchDeploymentArtifact, verifyArtifactProvenance } from './artifacts.js';
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
  'eth_getLogs',
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

// The runtime bytecode template can carry unresolved external-library link placeholders
// (__$...$__), a shape artifact provenance permits. The fully linked runtime bytes are not known
// before broadcast, and this hash is stored only — never consulted during resolution — so it is
// taken over the raw template string (placeholders included) rather than requiring pure hex. Pure
// hex is still hashed over its byte value so unlinked artifacts keep an identical snapshot to before.
function runtimeBytecodeTemplateHash(value: JsonAny, label: string): string {
  const template = bytecodeObject(value);
  if (typeof template !== 'string' || template.length === 0) {
    const error: JsonAny = new Error(`Deployment artifact ${label} is unavailable`);
    error.code = 'INVALID_ARTIFACT';
    throw error;
  }
  const normalized = template.toLowerCase();
  return /^0x(?:[0-9a-fA-F]{2})*$/.test(normalized) ? keccak256(normalized) : keccak256(toUtf8Bytes(normalized));
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
    if (disk !== undefined && disk.provenanceHash?.toLowerCase() === operation.provenanceHash) {
      return disk;
    }
    const snapshot = addressMap.resolveArtifactSnapshot(operation.provenanceHash);
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

  async function resumePrepared(record: JsonAny): Promise<JsonAny> {
    const snapshot = await nativeClient.getTransaction(record.nativeTransactionId);
    if (snapshot === null) {
      await nativeClient.broadcastSigned(record.signedNativeTransaction, record.nativeTransactionId);
    }
    let current = journal.get(record.sourceTransactionHash);
    if (current.state === 'native-built') current = journal.recordBroadcast(record.sourceTransactionHash);
    await waitAndReconcile(current);
    return record.sourceTransactionHash;
  }

  async function processClaimed(raw: JsonAny, sourceHash: JsonAny): Promise<JsonAny> {
    try {
      await nativeClient.assertSimulationReady();
      const decoded = decode(raw, { expectedSender: config.expectedSender, expectedChainId: config.chainId });
      let built;
      let operationContext;
      let artifactSnapshot;
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
        artifactSnapshot = {
          provenanceHash: operationContext.provenanceHash,
          artifactIdentity: identity,
          contractKind: operationContext.contractKind,
          abi: rewritten.abi ?? rewritten.artifact?.abi,
          creationBytecodeHash: bytecodeHash(match.creationBytecode, 'creation bytecode'),
          runtimeBytecodeHash: runtimeBytecodeTemplateHash(match.artifact?.deployedBytecode, 'runtime bytecode'),
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
      // Persist the deployment's immutable artifact envelope once its native transaction is durably
      // prepared. The snapshot is keyed by provenance hash and never overwritten, so a re-prepared or
      // recovered deployment reuses the identical envelope.
      if (artifactSnapshot !== undefined) addressMap.setArtifactSnapshot(artifactSnapshot);
      await nativeClient.broadcastSigned(prepared.signedNativeTransaction, prepared.nativeTransactionId);
      const broadcast = journal.recordBroadcast(sourceHash);
      await waitAndReconcile(broadcast);
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
      case 'eth_getCode':
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
