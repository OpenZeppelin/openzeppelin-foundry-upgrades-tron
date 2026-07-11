const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { computeAddress } = require('ethers');

const {
  DEFAULT_FEE_LIMIT,
  DEFAULT_TRE_ENDPOINT,
  DEFAULT_TRE_PRIVATE_KEY,
  MAX_FEE_LIMIT,
  normalizeEndpoint,
  parseConfig,
  parseStateConfig,
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
  assert.equal(config.chainId, 3360022319n);
  assert.equal(config.chainIdentity, 'tre:3360022319');
  assert.equal(config.expectedSender, computeAddress(`0x${DEFAULT_TRE_PRIVATE_KEY}`).toLowerCase());
  assert.equal(config.foundryOut, path.resolve('out'));
  assert.equal(config.stateFile, path.resolve('.openzeppelin-upgrades/tron-rpc-state.json'));
});

test('validates absolute state and Foundry output paths plus explicit chain identity', () => {
  const foundryOut = path.resolve('/tmp', 'foundry-out');
  const stateFile = path.resolve('/tmp', 'tron-rpc-state.json');
  const config = parseConfig({
    FOUNDRY_OUT: foundryOut,
    TRON_STATE_FILE: stateFile,
    TRON_CHAIN_ID: '12345',
  });

  assert.equal(config.foundryOut, foundryOut);
  assert.equal(config.stateFile, stateFile);
  assert.equal(config.chainId, 12345n);
  assert.equal(config.chainIdentity, 'tre:12345');

  assert.throws(() => parseConfig({ FOUNDRY_OUT: 'out' }), /FOUNDRY_OUT.*absolute/i);
  assert.throws(() => parseConfig({ TRON_STATE_FILE: 'state.json' }), /TRON_STATE_FILE.*absolute/i);
  for (const chainId of ['', '0', '-1', '1.5', '0x2a', '01']) {
    assert.throws(() => parseConfig({ TRON_CHAIN_ID: chainId }), /TRON_CHAIN_ID/i);
  }
});

test('requires an explicit chain ID, endpoint, and private key for every public network', () => {
  for (const network of ['mainnet', 'nile', 'shasta']) {
    assert.throws(() => parseConfig({ TRON_NETWORK: network }), /explicit TRON_CHAIN_ID/i);
    assert.throws(
      () =>
        parseConfig({
          TRON_NETWORK: network,
          TRON_CHAIN_ID: '3448148188',
          TRON_RPC_URL: 'https://api.example.test',
        }),
      /explicit TRON_PRIVATE_KEY/i,
    );

    const config = parseConfig({
      TRON_NETWORK: network,
      TRON_CHAIN_ID: '3448148188',
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
        TRON_CHAIN_ID: '3448148188',
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

test('parses read-only state configuration without network credentials', () => {
  const stateFile = path.resolve('/tmp', 'read-only-tron-state.json');
  const config = parseStateConfig({
    TRON_NETWORK: 'nile',
    TRON_CHAIN_ID: '3448148188',
    TRON_STATE_FILE: stateFile,
  });

  assert.deepEqual(config, {
    network: 'nile',
    chainId: 3448148188n,
    chainIdentity: 'nile:3448148188',
    stateFile,
  });
  assert.throws(() => parseStateConfig({ TRON_NETWORK: 'unknown' }), /TRON_NETWORK/);
  assert.throws(() => parseStateConfig({ TRON_CHAIN_ID: '0' }), /TRON_CHAIN_ID/);
  assert.throws(() => parseStateConfig({ TRON_STATE_FILE: 'relative.json' }), /TRON_STATE_FILE.*absolute/i);
});
