'use strict';

const { TronWeb } = require('tronweb');

const { DEFAULT_TRE_PRIVATE_KEY } = require('../dist/rpc/config.js');

function positiveInteger(value, label, fallback) {
  const actual = value ?? fallback;
  if (!Number.isSafeInteger(actual) || actual <= 0) throw new Error(`Invalid ${label}`);
  return actual;
}

function normalizedEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid TRE endpoint');
  }
  if (url.protocol !== 'http:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('Invalid TRE endpoint');
  }
  return url.href.replace(/\/$/, '');
}

async function post(endpoint, path, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${endpoint}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function ready(endpoint, privateKey, requestTimeoutMs) {
  const version = await post(
    endpoint,
    'tre',
    { jsonrpc: '2.0', id: 1, method: 'tre_version', params: [] },
    requestTimeoutMs,
  );
  if (version?.error !== undefined || version?.result === undefined) throw new Error('tre_version unavailable');
  const mined = await post(
    endpoint,
    'tre',
    { jsonrpc: '2.0', id: 2, method: 'tre_mine', params: [] },
    requestTimeoutMs,
  );
  if (mined?.error !== undefined) throw new Error('tre_mine unavailable');
  const owner = TronWeb.address.toHex(TronWeb.address.fromPrivateKey(privateKey));
  const account = await post(endpoint, 'wallet/getaccount', { address: owner, visible: false }, requestTimeoutMs);
  if (typeof account?.balance !== 'number' || !Number.isFinite(account.balance) || account.balance <= 0) {
    throw new Error('TRE dev account is not funded');
  }
  return { account: owner.toLowerCase(), balance: String(account.balance), version: version.result };
}

async function waitForTre(options = {}) {
  const endpoint = normalizedEndpoint(options.endpoint);
  const timeoutMs = positiveInteger(options.timeoutMs, 'TRE readiness timeout', 75_000);
  const pollIntervalMs = positiveInteger(options.pollIntervalMs, 'TRE readiness poll interval', 250);
  const requestTimeoutMs = positiveInteger(options.requestTimeoutMs, 'TRE request timeout', 2_000);
  const privateKey = options.privateKey ?? DEFAULT_TRE_PRIVATE_KEY;
  if (typeof privateKey !== 'string' || !/^[0-9a-f]{64}$/i.test(privateKey)) throw new Error('Invalid TRE private key');
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await ready(endpoint, privateKey, Math.min(requestTimeoutMs, Math.max(1, deadline - Date.now())));
    } catch (error) {
      lastError = error;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
  }
  throw new Error(`TRE was not ready within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`);
}

if (require.main === module) {
  waitForTre({
    endpoint: process.argv[2] ?? process.env.TRON_RPC_URL ?? 'http://127.0.0.1:9090',
    privateKey: process.env.TRON_PRIVATE_KEY ?? DEFAULT_TRE_PRIVATE_KEY,
  })
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => {
      process.stderr.write(`Error: ${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { waitForTre };
