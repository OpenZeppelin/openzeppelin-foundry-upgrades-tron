const path = require('node:path');

const { computeAddress } = require('ethers');

const DEFAULT_TRE_ENDPOINT = 'http://127.0.0.1:9090';
const DEFAULT_TRE_PRIVATE_KEY = 'dd23ca549a97cb330b011aebb674730df8b14acaee42d211ab45692699ab8ba5';
const DEFAULT_FEE_LIMIT = 1_000_000_000;
const MAX_FEE_LIMIT = 1_000_000_000;
const DEFAULT_CHAIN_ID = 3360022319n;
const DEFAULT_STATE_FILE = '.openzeppelin-upgrades/tron-rpc-state.json';

const PUBLIC_NETWORKS = new Set(['mainnet', 'nile', 'shasta']);
const SUPPORTED_NETWORKS = new Set(['tre', ...PUBLIC_NETWORKS]);
const SECP256K1_ORDER = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

function hasNonemptyString(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key) && typeof object[key] === 'string' && object[key].length > 0;
}

function normalizeEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.trim() !== endpoint) {
    throw new Error('Invalid TRON_RPC_URL');
  }

  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('Invalid TRON_RPC_URL');
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('Invalid TRON_RPC_URL');
  }

  let pathname = url.pathname.replace(/\/+$/, '');
  pathname = pathname.replace(/\/jsonrpc$/i, '');
  const fullHost = `${url.origin}${pathname}`;

  return Object.freeze({
    fullHost,
    jsonRpcEndpoint: `${fullHost}/jsonrpc`,
  });
}

function parsePrivateKey(value) {
  if (typeof value !== 'string') {
    throw new Error('Invalid TRON_PRIVATE_KEY');
  }

  const privateKey = value.replace(/^0x/i, '');
  if (!/^[0-9a-f]{64}$/i.test(privateKey)) {
    throw new Error('Invalid TRON_PRIVATE_KEY');
  }

  const scalar = BigInt(`0x${privateKey}`);
  if (scalar === 0n || scalar >= SECP256K1_ORDER) {
    throw new Error('Invalid TRON_PRIVATE_KEY');
  }

  return privateKey.toLowerCase();
}

function parseFeeLimit(value) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new Error(`TRON_FEE_LIMIT must be an integer from 1 to ${MAX_FEE_LIMIT}`);
  }

  const feeLimit = Number(value);
  if (!Number.isSafeInteger(feeLimit) || feeLimit < 1 || feeLimit > MAX_FEE_LIMIT) {
    throw new Error(`TRON_FEE_LIMIT must be an integer from 1 to ${MAX_FEE_LIMIT}`);
  }
  return feeLimit;
}

function parseChainId(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error('TRON_CHAIN_ID must be a positive canonical decimal integer');
  }
  const chainId = BigInt(value);
  if (chainId > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('TRON_CHAIN_ID exceeds the supported safe integer range');
  }
  return chainId;
}

function explicitAbsolutePath(environment, key, fallback) {
  const value = environment[key];
  if (value === undefined) return path.resolve(fallback);
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
    throw new Error(`${key} must be an absolute path`);
  }
  return path.normalize(value);
}

function parseStateConfig(environment = process.env) {
  if (environment === null || typeof environment !== 'object') {
    throw new Error('Configuration environment must be an object');
  }

  const network = environment.TRON_NETWORK ?? 'tre';
  if (typeof network !== 'string' || !SUPPORTED_NETWORKS.has(network)) {
    throw new Error('Invalid TRON_NETWORK; expected tre, mainnet, nile, or shasta');
  }

  if (PUBLIC_NETWORKS.has(network) && !hasNonemptyString(environment, 'TRON_CHAIN_ID')) {
    throw new Error(`The ${network} network requires an explicit TRON_CHAIN_ID`);
  }
  const chainId = parseChainId(environment.TRON_CHAIN_ID ?? DEFAULT_CHAIN_ID.toString());
  return Object.freeze({
    network,
    chainId,
    chainIdentity: `${network}:${chainId}`,
    stateFile: explicitAbsolutePath(environment, 'TRON_STATE_FILE', DEFAULT_STATE_FILE),
  });
}

function parseConfig(environment = process.env) {
  const state = parseStateConfig(environment);
  const { network } = state;

  const publicNetwork = PUBLIC_NETWORKS.has(network);
  if (publicNetwork && !hasNonemptyString(environment, 'TRON_RPC_URL')) {
    throw new Error(`The ${network} network requires an explicit TRON_RPC_URL`);
  }
  if (publicNetwork && !hasNonemptyString(environment, 'TRON_PRIVATE_KEY')) {
    throw new Error(`The ${network} network requires an explicit TRON_PRIVATE_KEY`);
  }

  const endpoint = normalizeEndpoint(environment.TRON_RPC_URL ?? DEFAULT_TRE_ENDPOINT);
  const privateKey = parsePrivateKey(environment.TRON_PRIVATE_KEY ?? DEFAULT_TRE_PRIVATE_KEY);
  if (publicNetwork && privateKey === DEFAULT_TRE_PRIVATE_KEY) {
    throw new Error('The TRE development key cannot be used on a public network');
  }

  const feeLimit = Object.prototype.hasOwnProperty.call(environment, 'TRON_FEE_LIMIT')
    ? parseFeeLimit(environment.TRON_FEE_LIMIT)
    : DEFAULT_FEE_LIMIT;

  return Object.freeze({
    ...state,
    publicNetwork,
    ...endpoint,
    privateKey,
    feeLimit,
    expectedSender: computeAddress(`0x${privateKey}`).toLowerCase(),
    foundryOut: explicitAbsolutePath(environment, 'FOUNDRY_OUT', 'out'),
  });
}

module.exports = {
  DEFAULT_CHAIN_ID,
  DEFAULT_FEE_LIMIT,
  DEFAULT_STATE_FILE,
  DEFAULT_TRE_ENDPOINT,
  DEFAULT_TRE_PRIVATE_KEY,
  MAX_FEE_LIMIT,
  normalizeEndpoint,
  parseConfig,
  parseStateConfig,
};
