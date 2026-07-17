const path = require('node:path');

const { computeAddress } = require('ethers');

const DEFAULT_TRE_ENDPOINT = 'http://127.0.0.1:9090';
const DEFAULT_TRE_PRIVATE_KEY = 'dd23ca549a97cb330b011aebb674730df8b14acaee42d211ab45692699ab8ba5';
const TRE_DEVELOPMENT_PRIVATE_KEYS = new Set([
  DEFAULT_TRE_PRIVATE_KEY,
  'f1aa5a7966c3863ccde3047f6a1e266cdc0c76b399e256b8fede92b1c69e4f4e',
  '43f149de89d64bf9a9099be19e1b1f7a4db784af8fa07caf6f08dc86ba65636b',
  'b0ff29f0f33edc39aaf8789ea9637c360f9e479b8755f4565652b2594f8835df',
  '6789ede33b84cbd4e735e12924d07e48b15df0ded10de3c206eeac585852ab22',
  'efba7c0fc77822d0e13b0c36249b129628abff7be84c6b86d8d3444f14618361',
  'cbd4d57ea225a831c496b5305d542579222ebdef58a02ea61d55ec1ebecdeb3a',
  'b08786f38934aac966d10f0bc79a72f15067896d3b3beba721b5c235ffc5cc5f',
  '4a354f72d8069e05fa0a19218ef561dde1db5f78c3d46f2005f9706706171d94',
  '16dd30d52297ff9973cbbd5f35c0fef37309fbbfd5b540615b255fbeb8c1283d',
]);
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
  if (publicNetwork && TRE_DEVELOPMENT_PRIVATE_KEYS.has(privateKey)) {
    throw new Error('TRE development keys cannot be used on a public network');
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
