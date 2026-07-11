const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_FEE_LIMIT,
  DEFAULT_TRE_ENDPOINT,
  DEFAULT_TRE_PRIVATE_KEY,
  MAX_FEE_LIMIT,
  normalizeEndpoint,
  parseConfig,
} = require('../config.cjs');

const PRIVATE_KEY = '11'.repeat(32);

test('uses safe TRE-only defaults', () => {
  const config = parseConfig({});

  assert.equal(config.network, 'tre');
  assert.equal(config.publicNetwork, false);
  assert.equal(config.fullHost, DEFAULT_TRE_ENDPOINT);
  assert.equal(config.jsonRpcEndpoint, `${DEFAULT_TRE_ENDPOINT}/jsonrpc`);
  assert.equal(config.privateKey, DEFAULT_TRE_PRIVATE_KEY);
  assert.equal(config.feeLimit, DEFAULT_FEE_LIMIT);
});

test('requires an explicit endpoint and private key for every public network', () => {
  for (const network of ['mainnet', 'nile', 'shasta']) {
    assert.throws(() => parseConfig({ TRON_NETWORK: network }), /explicit TRON_RPC_URL/i);
    assert.throws(
      () => parseConfig({ TRON_NETWORK: network, TRON_RPC_URL: 'https://api.example.test' }),
      /explicit TRON_PRIVATE_KEY/i,
    );

    const config = parseConfig({
      TRON_NETWORK: network,
      TRON_RPC_URL: 'https://api.example.test/jsonrpc',
      TRON_PRIVATE_KEY: `0x${PRIVATE_KEY}`,
    });
    assert.equal(config.publicNetwork, true);
    assert.equal(config.privateKey, PRIVATE_KEY);
  }
});

test('does not use the TRE development key on public networks', () => {
  assert.throws(
    () =>
      parseConfig({
        TRON_NETWORK: 'nile',
        TRON_RPC_URL: 'https://nile.example.test',
        TRON_PRIVATE_KEY: DEFAULT_TRE_PRIVATE_KEY,
      }),
    /development key/i,
  );
});

test('normalizes base and jsonrpc endpoints without changing path prefixes', () => {
  assert.deepEqual(normalizeEndpoint('http://127.0.0.1:9090/jsonrpc/'), {
    fullHost: 'http://127.0.0.1:9090',
    jsonRpcEndpoint: 'http://127.0.0.1:9090/jsonrpc',
  });
  assert.deepEqual(normalizeEndpoint('https://node.example.test/tron/'), {
    fullHost: 'https://node.example.test/tron',
    jsonRpcEndpoint: 'https://node.example.test/tron/jsonrpc',
  });
});

test('rejects unsafe or malformed endpoints', () => {
  for (const endpoint of [
    '',
    'node.example.test',
    'ftp://node.example.test',
    'https://user:secret@node.example.test',
    'https://node.example.test/path?apiKey=secret',
    'https://node.example.test/path#fragment',
  ]) {
    assert.throws(() => normalizeEndpoint(endpoint), /invalid TRON_RPC_URL/i, endpoint);
  }
});

test('accepts integer fee limits at the supported boundaries', () => {
  assert.equal(parseConfig({ TRON_FEE_LIMIT: '1' }).feeLimit, 1);
  assert.equal(parseConfig({ TRON_FEE_LIMIT: String(MAX_FEE_LIMIT) }).feeLimit, MAX_FEE_LIMIT);
});

test('rejects invalid fee limits', () => {
  for (const feeLimit of ['', '0', '-1', '1.5', '1e6', String(MAX_FEE_LIMIT + 1), '9007199254740992']) {
    assert.throws(() => parseConfig({ TRON_FEE_LIMIT: feeLimit }), /TRON_FEE_LIMIT/i, feeLimit);
  }
});

test('validates private keys without exposing their value in errors', () => {
  const invalidKey = `not-a-private-key-${'secret'.repeat(8)}`;

  assert.throws(
    () => parseConfig({ TRON_PRIVATE_KEY: invalidKey }),
    error => error instanceof Error && /TRON_PRIVATE_KEY/.test(error.message) && !error.message.includes(invalidKey),
  );
  assert.throws(() => parseConfig({ TRON_PRIVATE_KEY: '00'.repeat(32) }), /TRON_PRIVATE_KEY/);
});

test('rejects unknown network names instead of guessing their safety', () => {
  assert.throws(() => parseConfig({ TRON_NETWORK: 'production' }), /TRON_NETWORK/);
});
