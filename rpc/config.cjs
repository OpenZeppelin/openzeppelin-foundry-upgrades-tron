const DEFAULT_TRE_ENDPOINT = 'http://127.0.0.1:9090';
const DEFAULT_TRE_PRIVATE_KEY = 'dd23ca549a97cb330b011aebb674730df8b14acaee42d211ab45692699ab8ba5';
const DEFAULT_FEE_LIMIT = 1_000_000_000;
const MAX_FEE_LIMIT = 1_000_000_000;

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

function parseConfig(environment = process.env) {
  if (environment === null || typeof environment !== 'object') {
    throw new Error('Configuration environment must be an object');
  }

  const network = environment.TRON_NETWORK ?? 'tre';
  if (typeof network !== 'string' || !SUPPORTED_NETWORKS.has(network)) {
    throw new Error('Invalid TRON_NETWORK; expected tre, mainnet, nile, or shasta');
  }

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
    network,
    publicNetwork,
    ...endpoint,
    privateKey,
    feeLimit,
  });
}

module.exports = {
  DEFAULT_FEE_LIMIT,
  DEFAULT_TRE_ENDPOINT,
  DEFAULT_TRE_PRIVATE_KEY,
  MAX_FEE_LIMIT,
  normalizeEndpoint,
  parseConfig,
};
