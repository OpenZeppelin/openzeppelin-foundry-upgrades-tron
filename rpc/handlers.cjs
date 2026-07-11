'use strict';

const path = require('node:path');

const { Transaction, concat, dataSlice, getAddress, getCreateAddress, keccak256, toBeHex } = require('ethers');

const { normalizeAddress, toEvmAddress } = require('./address-codec.cjs');
const { findArtifactPaths, matchDeploymentArtifact, verifyArtifactProvenance } = require('./artifacts.cjs');
const { assertOpaqueBytesSafe, rewriteCall, rewriteDeployment } = require('./rewriter.cjs');
const { assertStateLockHeld } = require('./state-lock.cjs');
const { decodeLegacyTransaction } = require('./transactions.cjs');

const JSON_RPC_VERSION = '2.0';
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const IMPLEMENTATION_SELECTOR = '0x5c60da1b';
const FORWARDED_METHODS = new Set([
  'eth_blockNumber',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getBlockTransactionCountByHash',
  'eth_getBlockTransactionCountByNumber',
  'eth_getLogs',
  'eth_getTransactionByBlockHashAndIndex',
  'eth_getTransactionByBlockNumberAndIndex',
  'net_version',
  'web3_clientVersion',
]);

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function quantity(value) {
  return toBeHex(BigInt(value));
}

function normalizeHash(value, label = 'transaction hash') {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) {
    throw new RpcError(-32602, `Invalid ${label}`);
  }
  return value.toLowerCase();
}

function normalizeEvmAddress(value, label = 'address') {
  try {
    return toEvmAddress(value);
  } catch (error) {
    throw new RpcError(-32602, `Invalid ${label}`, undefined, { cause: error });
  }
}

function nativeContractAddress(nativeTransactionId, ownerAddress) {
  const txid = typeof nativeTransactionId === 'string' ? nativeTransactionId.replace(/^0x/i, '') : '';
  if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error('Invalid native transaction ID');
  const owner = normalizeEvmAddress(ownerAddress, 'native owner').slice(2);
  return dataSlice(keccak256(concat([`0x${txid}`, `0x41${owner}`])), 12).toLowerCase();
}

function artifactIdentity(match) {
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

function contractKindForArtifact(identity) {
  const name = identity.contractName;
  if (name === 'TRC1967Proxy' || name === 'ERC1967Proxy') return 'uups-proxy';
  if (name === 'TransparentUpgradeableProxy') return 'transparent-proxy';
  if (name === 'ProxyAdmin') return 'proxy-admin';
  if (name === 'UpgradeableBeacon') return 'upgradeable-beacon';
  if (name === 'BeaconProxy') return 'beacon-proxy';
  return 'contract';
}

function validateDependencies(options) {
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
      ['toActual', 'toPredicted', 'resolvePredicted', 'resolveActual', 'resolveContractMetadata', 'list'],
    ],
    ['reconciler', options.reconciler, ['recordPreparedNative', 'reconcile']],
    [
      'native client',
      options.nativeClient,
      ['buildCreate', 'buildCall', 'simulateSigned', 'broadcastSigned', 'getTransaction', 'waitForReceipt'],
    ],
    ['upstream JSON-RPC client', options.upstream, ['request']],
  ]) {
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

function failureCode(error) {
  return typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'TRANSLATION_FAILED';
}

function publicError(error) {
  if (error instanceof RpcError) return error;
  if (Number.isInteger(error?.code))
    return new RpcError(error.code, error.message || 'Upstream JSON-RPC error', error.data);
  return new RpcError(-32000, error?.message || 'TRON RPC operation failed', { code: failureCode(error) });
}

function responseError(id, error) {
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

function validRequest(request) {
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

function requirePositional(params, minimum, maximum = minimum) {
  if (!Array.isArray(params) || params.length < minimum || params.length > maximum) {
    throw new RpcError(-32602, 'Invalid params');
  }
  return params;
}

function receiptContext(addressMap, record) {
  const operation = record.operationContext;
  return {
    ...operation,
    sourceTransactionHash: record.sourceTransactionHash,
    ...(operation.kind === 'deployment' ? { predictedContractAddress: operation.predictedContractAddress } : {}),
    resolveAddress(address) {
      const actual = normalizeEvmAddress(address);
      if (operation.kind === 'deployment' && actual === operation.actualTarget) {
        return operation.predictedContractAddress;
      }
      return addressMap.toPredicted(actual) ?? actual;
    },
  };
}

function ethereumTransaction(record) {
  const transaction = Transaction.from(record.signedEthereumTransaction);
  const receipt = record.receipt;
  return {
    blockHash: receipt?.blockHash ?? null,
    blockNumber: receipt?.blockNumber ?? null,
    from: transaction.from,
    gas: quantity(transaction.gasLimit),
    gasPrice: quantity(transaction.gasPrice),
    hash: record.sourceTransactionHash,
    input: transaction.data,
    nonce: quantity(transaction.nonce),
    to: transaction.to,
    transactionIndex: receipt?.transactionIndex ?? null,
    value: quantity(transaction.value),
    type: '0x0',
    chainId: quantity(transaction.chainId),
    v: quantity(transaction.signature.networkV ?? transaction.signature.v),
    r: transaction.signature.r,
    s: transaction.signature.s,
  };
}

function createRpcHandlers(rawOptions) {
  const options = validateDependencies(rawOptions);
  const { config, journal, addressMap, reconciler, nativeClient, upstream } = options;
  const decode = options.decodeLegacyTransaction ?? decodeLegacyTransaction;
  const matchArtifact = options.matchDeploymentArtifact ?? matchDeploymentArtifact;
  const findArtifacts = options.findArtifactPaths ?? findArtifactPaths;
  const verifyArtifact = options.verifyArtifactProvenance ?? verifyArtifactProvenance;
  const rewriteDeploy = options.rewriteDeployment ?? rewriteDeployment;
  const rewriteContractCall = options.rewriteCall ?? rewriteCall;
  const opaqueSafety = options.assertOpaqueBytesSafe ?? assertOpaqueBytesSafe;
  const inFlight = new Map();

  function mappedAddress(address) {
    const normalized = normalizeEvmAddress(address);
    if (normalized === ZERO_ADDRESS) return normalized;
    return addressMap.toActual(normalized) ?? normalized;
  }

  function metadataFor(address) {
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

  function verifiedArtifactForIdentity(identity) {
    const matches = findArtifacts(config.foundryOut, identity.fullyQualifiedName);
    if (matches.length !== 1) {
      const error = new Error(`Expected one artifact for ${identity.fullyQualifiedName}, found ${matches.length}`);
      error.code = matches.length === 0 ? 'ARTIFACT_NOT_FOUND' : 'AMBIGUOUS_ARTIFACT';
      throw error;
    }
    return verifyArtifact({ outputDirectory: config.foundryOut, artifactPath: matches[0] });
  }

  async function resolveArtifact(address) {
    const metadata = metadataFor(address);
    return metadata === undefined ? undefined : verifiedArtifactForIdentity(metadata.artifactIdentity);
  }

  async function readStorageAddress(target, slot) {
    const value = await upstream.request('eth_getStorageAt', [mappedAddress(target), slot, 'latest']);
    if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) {
      throw new Error('Upstream returned invalid address storage');
    }
    return normalizeEvmAddress(`0x${value.slice(-40)}`, 'stored contract address');
  }

  async function resolveBeaconImplementation(beacon) {
    const result = await upstream.request('eth_call', [
      { to: mappedAddress(beacon), data: IMPLEMENTATION_SELECTOR },
      'latest',
    ]);
    if (typeof result !== 'string' || !/^0x[0-9a-f]{64}$/i.test(result)) {
      throw new Error('Beacon implementation query returned invalid data');
    }
    return normalizeEvmAddress(`0x${result.slice(-40)}`, 'beacon implementation');
  }

  async function defaultResolveCallContext(target) {
    const metadata = metadataFor(target);
    if (metadata === undefined) return undefined;
    let artifactAddress = target;
    if (metadata.contractKind === 'uups-proxy' || metadata.contractKind === 'transparent-proxy') {
      artifactAddress = await readStorageAddress(target, IMPLEMENTATION_SLOT);
    } else if (metadata.contractKind === 'beacon-proxy') {
      const beacon = await readStorageAddress(target, BEACON_SLOT);
      artifactAddress = await resolveBeaconImplementation(beacon);
    }
    const artifact =
      artifactAddress === target
        ? verifiedArtifactForIdentity(metadata.artifactIdentity)
        : await resolveArtifact(artifactAddress);
    if (artifact === undefined) {
      const error = new Error('Target implementation artifact metadata is unavailable');
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

  async function rewriteReadTransaction(transaction, deploymentEstimate = false) {
    if (!isObject(transaction)) throw new RpcError(-32602, 'Invalid transaction call object');
    if (own(transaction, 'data') && own(transaction, 'input') && transaction.data !== transaction.input) {
      throw new RpcError(-32602, 'Transaction data and input conflict');
    }
    const dataKey = own(transaction, 'input') && !own(transaction, 'data') ? 'input' : 'data';
    const data = transaction[dataKey] ?? '0x';
    if (transaction.to === undefined || transaction.to === null) {
      if (!deploymentEstimate) return { ...transaction };
      const match = matchArtifact({ outputDirectory: config.foundryOut, initcode: data });
      const deployment = await rewriteDeploy(match, rewriteDependencies);
      return {
        ...transaction,
        ...(transaction.from === undefined ? {} : { from: mappedAddress(transaction.from) }),
        [dataKey]: deployment.initcode,
      };
    }
    const target = normalizeEvmAddress(transaction.to, 'transaction target');
    const context = await resolveCallContext(target);
    let rewritten;
    if (context === undefined) {
      await opaqueSafety(data, rewriteDependencies);
      rewritten = { ...transaction, to: mappedAddress(target), [dataKey]: data };
    } else {
      const call = await rewriteContractCall({ ...transaction, to: target, data }, context, rewriteDependencies);
      rewritten = { ...transaction, ...call, [dataKey]: call.data };
      if (dataKey === 'input') delete rewritten.data;
    }
    if (transaction.from !== undefined) rewritten.from = mappedAddress(transaction.from);
    return rewritten;
  }

  async function waitAndReconcile(record) {
    const receipt = await nativeClient.waitForReceipt(record.nativeTransactionId, receiptContext(addressMap, record));
    return reconciler.reconcile(record.sourceTransactionHash, receipt).receipt;
  }

  async function resumePrepared(record) {
    const snapshot = await nativeClient.getTransaction(record.nativeTransactionId);
    if (snapshot === null) {
      await nativeClient.broadcastSigned(record.signedNativeTransaction, record.nativeTransactionId);
    }
    let current = journal.get(record.sourceTransactionHash);
    if (current.state === 'native-built') current = journal.recordBroadcast(record.sourceTransactionHash);
    await waitAndReconcile(current);
    return record.sourceTransactionHash;
  }

  async function processClaimed(raw, sourceHash) {
    try {
      const decoded = decode(raw, { expectedSender: config.expectedSender, expectedChainId: config.chainId });
      let built;
      let operationContext;
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
      } else {
        const context = await resolveCallContext(decoded.to);
        let rewritten;
        if (context === undefined) {
          await opaqueSafety(decoded.data, rewriteDependencies);
          rewritten = { ...decoded, to: mappedAddress(decoded.to) };
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
      const simulation = await nativeClient.simulateSigned(native.signedNativeTransaction, native.nativeTransactionId);
      const prepared = reconciler.recordPreparedNative(sourceHash, native, simulation, operationContext);
      await nativeClient.broadcastSigned(prepared.signedNativeTransaction, prepared.nativeTransactionId);
      const broadcast = journal.recordBroadcast(sourceHash);
      await waitAndReconcile(broadcast);
      return sourceHash;
    } catch (error) {
      const current = journal.get(sourceHash);
      if (current?.state === 'received') {
        journal.recordFailed(sourceHash, { code: failureCode(error), message: error?.message || 'Translation failed' });
      }
      throw error;
    }
  }

  function runTracked(sourceHash, callback) {
    const active = inFlight.get(sourceHash);
    if (active !== undefined) return active;
    const promise = Promise.resolve()
      .then(callback)
      .finally(() => inFlight.delete(sourceHash));
    inFlight.set(sourceHash, promise);
    return promise;
  }

  async function sendRawTransaction(raw) {
    if (typeof raw !== 'string') throw new RpcError(-32602, 'Invalid signed transaction bytes');
    const received = journal.receive(raw);
    const hash = received.record.sourceTransactionHash;
    if (received.shouldBuild)
      return runTracked(hash, () => processClaimed(received.record.signedEthereumTransaction, hash));
    const active = inFlight.get(hash);
    if (active !== undefined) return active;
    const record = journal.get(hash);
    if (record.state === 'confirmed') return hash;
    if (record.state === 'failed')
      throw Object.assign(new Error(record.failure.message), { code: record.failure.code });
    if (record.state === 'received') {
      const error = new Error('Source transaction native build is owned by another live handler');
      error.code = 'TRANSACTION_IN_PROGRESS';
      throw error;
    }
    return runTracked(hash, () => resumePrepared(record));
  }

  async function resolveAddress(value) {
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

  async function dispatch(method, params) {
    switch (method) {
      case 'eth_chainId':
        requirePositional(params, 0);
        return quantity(config.chainId);
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
        return upstream.request(method, [mappedAddress(address), ...(block === undefined ? [] : [block])]);
      }
      case 'eth_getStorageAt': {
        const [address, slot, block] = requirePositional(params, 2, 3);
        return upstream.request(method, [mappedAddress(address), slot, ...(block === undefined ? [] : [block])]);
      }
      case 'eth_getTransactionCount': {
        const [address, block] = requirePositional(params, 1, 2);
        return upstream.request(method, [mappedAddress(address), ...(block === undefined ? [] : [block])]);
      }
      case 'eth_call':
      case 'eth_estimateGas': {
        const [transaction, block] = requirePositional(params, 1, 2);
        const rewritten = await rewriteReadTransaction(transaction, method === 'eth_estimateGas');
        return upstream.request(method, [rewritten, ...(block === undefined ? [] : [block])]);
      }
      case 'eth_gasPrice':
        requirePositional(params, 0);
        return upstream.request(method, []);
      case 'tron_resolveAddress': {
        const [address] = requirePositional(params, 1);
        return resolveAddress(address);
      }
      default:
        if (FORWARDED_METHODS.has(method)) return upstream.request(method, params);
        throw new RpcError(-32601, 'Method not found');
    }
  }

  async function handleOne(request) {
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

  async function handle(payload) {
    if (!Array.isArray(payload)) return handleOne(payload);
    if (payload.length === 0) return responseError(null, new RpcError(-32600, 'Invalid Request'));
    const responses = (await Promise.all(payload.map(handleOne))).filter(response => response !== undefined);
    return responses.length === 0 ? undefined : responses;
  }

  async function recoverStartup(capability) {
    assertStateLockHeld(capability, config.stateFile);
    const recovered = [];
    for (const persisted of journal.list()) {
      if (persisted.state === 'confirmed' || persisted.state === 'failed') continue;
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

module.exports = {
  RpcError,
  contractKindForArtifact,
  createRpcHandlers,
  nativeContractAddress,
};
