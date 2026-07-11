'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { UpstreamRpcError, createUpstreamClient } = require('../upstream.cjs');

test('posts strict JSON-RPC requests through built-in fetch transport', async () => {
  const calls = [];
  const client = createUpstreamClient('http://127.0.0.1:9090/jsonrpc', {
    async fetch(endpoint, options) {
      calls.push({ endpoint, options });
      const request = JSON.parse(options.body);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x2a' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(await client.request('eth_blockNumber', []), '0x2a');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, 'http://127.0.0.1:9090/jsonrpc');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_blockNumber',
    params: [],
  });
});

test('rejects malformed transport responses without exposing endpoint details', async () => {
  const endpoint = 'https://secret-node.example.test/jsonrpc';
  for (const response of [
    new Response('not-json', { status: 200 }),
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 99, result: 'wrong id' }), { status: 200 }),
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 1, error: { code: -1, message: 'both' } }), {
      status: 200,
    }),
    new Response('', { status: 503 }),
  ]) {
    const client = createUpstreamClient(endpoint, { fetch: async () => response });
    await assert.rejects(
      () => client.request('eth_chainId', []),
      error => error instanceof Error && !error.message.includes(endpoint) && !error.message.includes('secret-node'),
    );
  }
});

test('preserves validated upstream JSON-RPC errors for handler translation', async () => {
  const client = createUpstreamClient('http://127.0.0.1:9090/jsonrpc', {
    fetch: async (_endpoint, options) => {
      const { id } = JSON.parse(options.body);
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32042, message: 'upstream rejected', data: 'reason' } }),
        { status: 200 },
      );
    },
  });

  await assert.rejects(
    () => client.request('eth_call', []),
    error =>
      error instanceof UpstreamRpcError &&
      error.code === -32042 &&
      error.message === 'upstream rejected' &&
      error.data === 'reason',
  );
});

test('validates methods, params, endpoint, and fetch dependency before transport', async () => {
  assert.throws(() => createUpstreamClient('not-a-url'), /endpoint/i);
  assert.throws(() => createUpstreamClient('ftp://example.test'), /endpoint/i);
  assert.throws(() => createUpstreamClient('https://example.test', { fetch: null }), /fetch/i);
  const client = createUpstreamClient('https://example.test/jsonrpc', { fetch: async () => new Response('{}') });
  await assert.rejects(() => client.request('', []), /method/i);
  await assert.rejects(() => client.request('eth_call', null), /params/i);
});
