const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createRpcServer } = require('../server.cjs');

function temporaryStatePath(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-tron-rpc-server-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  return path.join(directory, 'adapter-state.json');
}

function fakeHandlers(overrides = {}) {
  return {
    async handle(payload) {
      return { jsonrpc: '2.0', id: payload.id, result: payload.method };
    },
    async recoverStartup() {},
    ...overrides,
  };
}

function request(address, options = {}) {
  const body = options.body ?? '';
  const headers = { ...(options.headers ?? {}) };
  if (body !== '' && headers['content-length'] === undefined && headers['transfer-encoding'] === undefined) {
    headers['content-length'] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        agent: options.agent ?? false,
        host: address.host,
        port: address.port,
        path: options.path ?? '/',
        method: options.method ?? 'POST',
        headers,
      },
      response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            body: Buffer.concat(chunks).toString('utf8'),
            headers: response.headers,
            statusCode: response.statusCode,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function startStreamingRequest(address, options = {}) {
  const response = new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: address.host,
        port: address.port,
        path: options.path ?? '/',
        method: options.method ?? 'POST',
        headers: options.headers,
      },
      incoming => {
        const chunks = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('end', () =>
          resolve({
            body: Buffer.concat(chunks).toString('utf8'),
            headers: incoming.headers,
            statusCode: incoming.statusCode,
          }),
        );
      },
    );
    req.on('error', reject);
    options.onRequest?.(req);
  });
  return response;
}

function partialHeaders(address, bytes) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: address.host, port: address.port });
    const chunks = [];
    socket.on('connect', () => socket.write(bytes));
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
}

async function openPartialRequest(address, bytes) {
  const socket = net.createConnection({ host: address.host, port: address.port });
  const chunks = [];
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write(bytes);
  const response = new Promise((resolve, reject) => {
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
  return { response, socket };
}

async function startedServer(t, options = {}) {
  const server = createRpcServer({
    handlers: fakeHandlers(),
    port: 0,
    statePath: temporaryStatePath(t),
    ...options,
  });
  t.after(() => server.stop());
  await server.start();
  return server;
}

test('acquires the state lock and completes recovery before listening', async t => {
  const events = [];
  const lock = {
    async release() {
      events.push('release');
    },
  };
  let listeningAddress;
  const server = createRpcServer({
    acquireLock: async statePath => {
      events.push(`lock:${path.basename(statePath)}`);
      return lock;
    },
    handlers: fakeHandlers({
      async recoverStartup(receivedLock) {
        assert.equal(receivedLock, lock);
        events.push('recover');
        assert.equal(server.address(), undefined);
      },
    }),
    port: 0,
    statePath: temporaryStatePath(t),
  });
  t.after(() => server.stop());

  listeningAddress = await server.start();

  assert.deepEqual(events, ['lock:adapter-state.json', 'recover']);
  assert.deepEqual(listeningAddress, server.address());
  assert.equal(listeningAddress.host, '127.0.0.1');
  assert.ok(listeningAddress.port > 0);
});

test('serves single and batch JSON-RPC payloads and omits notification bodies', async t => {
  const seen = [];
  const server = await startedServer(t, {
    handlers: fakeHandlers({
      async handle(payload) {
        seen.push(payload);
        if (
          (Array.isArray(payload) && payload.every(item => item.id === undefined)) ||
          (!Array.isArray(payload) && payload.id === undefined)
        ) {
          return undefined;
        }
        return Array.isArray(payload)
          ? payload.map(item => ({ jsonrpc: '2.0', id: item.id, result: item.method }))
          : { jsonrpc: '2.0', id: payload.id, result: payload.method };
      },
    }),
  });
  const headers = { 'content-type': 'application/json' };

  const single = await request(server.address(), {
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }),
    headers,
  });
  const batchPayload = [
    { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber' },
    { jsonrpc: '2.0', method: 'eth_chainId' },
  ];
  const batch = await request(server.address(), { body: JSON.stringify(batchPayload), headers });
  const notification = await request(server.address(), {
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId' }),
    headers,
  });

  assert.equal(single.statusCode, 200);
  assert.deepEqual(JSON.parse(single.body), { jsonrpc: '2.0', id: 1, result: 'eth_chainId' });
  assert.equal(batch.statusCode, 200);
  assert.deepEqual(JSON.parse(batch.body), [
    { jsonrpc: '2.0', id: 2, result: 'eth_blockNumber' },
    { jsonrpc: '2.0', result: 'eth_chainId' },
  ]);
  assert.equal(notification.statusCode, 204);
  assert.equal(notification.body, '');
  assert.deepEqual(seen, [
    { jsonrpc: '2.0', id: 1, method: 'eth_chainId' },
    batchPayload,
    { jsonrpc: '2.0', method: 'eth_chainId' },
  ]);
});

test('returns a JSON-RPC parse error without invoking handlers', async t => {
  let calls = 0;
  const server = await startedServer(t, {
    handlers: fakeHandlers({
      async handle() {
        calls += 1;
      },
    }),
  });

  const response = await request(server.address(), {
    body: '{"broken":',
    headers: { 'content-type': 'application/json' },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32700, message: 'Parse error' },
  });
  assert.equal(calls, 0);
});

test('releases the lock when recovery fails and combines a release failure', async t => {
  const recoveryError = new Error('recovery failed');
  const releaseError = new Error('release failed');
  let releases = 0;
  const server = createRpcServer({
    acquireLock: async () => ({
      async release() {
        releases += 1;
        throw releaseError;
      },
    }),
    handlers: fakeHandlers({
      async recoverStartup() {
        throw recoveryError;
      },
    }),
    port: 0,
    statePath: temporaryStatePath(t),
  });

  await assert.rejects(server.start(), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [recoveryError, releaseError]);
    return true;
  });
  assert.equal(releases, 1);
  assert.equal(server.address(), undefined);
  await assert.rejects(server.stop(), releaseError);
  assert.equal(releases, 1);
});

test('propagates acquisition failure without attempting recovery or release', async t => {
  const acquisitionError = new Error('lock unavailable');
  let recoveries = 0;
  const server = createRpcServer({
    acquireLock: async () => {
      throw acquisitionError;
    },
    handlers: fakeHandlers({
      async recoverStartup() {
        recoveries += 1;
      },
    }),
    port: 0,
    statePath: temporaryStatePath(t),
  });

  await assert.rejects(server.start(), acquisitionError);
  assert.equal(recoveries, 0);
  assert.equal(server.address(), undefined);
  await server.stop();
});

test('refuses two live servers that share a canonical state path', async t => {
  const statePath = temporaryStatePath(t);
  const first = createRpcServer({ handlers: fakeHandlers(), port: 0, statePath });
  const second = createRpcServer({ handlers: fakeHandlers(), port: 0, statePath });
  t.after(() => Promise.allSettled([first.stop(), second.stop()]));

  await first.start();
  await assert.rejects(second.start(), /state is already locked/i);
});

test('rejects unsupported paths, methods, media types, charsets, and content encodings', async t => {
  const server = await startedServer(t);
  const validBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' });
  const cases = [
    [{ method: 'GET', path: '/' }, 405],
    [{ method: 'POST', path: '/jsonrpc', headers: { 'content-type': 'application/json' }, body: validBody }, 404],
    [{ method: 'POST', body: validBody }, 415],
    [{ method: 'POST', headers: { 'content-type': 'text/plain' }, body: validBody }, 415],
    [{ method: 'POST', headers: { 'content-type': 'application/json; charset=latin1' }, body: validBody }, 415],
    [
      {
        method: 'POST',
        headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' },
        body: validBody,
      },
      415,
    ],
  ];

  for (const [options, expectedStatus] of cases) {
    const response = await request(server.address(), options);
    assert.equal(response.statusCode, expectedStatus, JSON.stringify(options));
    assert.equal(response.body.includes('eth_chainId'), false);
  }

  const accepted = await request(server.address(), {
    body: validBody,
    headers: { 'content-encoding': 'identity', 'content-type': 'application/json; charset=UTF-8' },
  });
  assert.equal(accepted.statusCode, 200);
});

test('rejects oversized declared and chunked bodies by raw byte count', async t => {
  let calls = 0;
  const server = await startedServer(t, {
    handlers: fakeHandlers({
      async handle() {
        calls += 1;
      },
    }),
    maxRequestBytes: 16,
  });

  const declared = await request(server.address(), {
    headers: { 'content-length': '17', 'content-type': 'application/json' },
  });
  const chunked = await startStreamingRequest(server.address(), {
    headers: { 'content-type': 'application/json' },
    onRequest(req) {
      req.write('123456789');
      req.end('123456789');
    },
  });

  assert.equal(declared.statusCode, 413);
  assert.equal(chunked.statusCode, 413);
  assert.equal(calls, 0);
});

test('times out an incomplete request body without invoking handlers', async t => {
  let calls = 0;
  const server = await startedServer(t, {
    handlers: fakeHandlers({
      async handle() {
        calls += 1;
      },
    }),
    requestTimeoutMs: 40,
  });

  const response = await startStreamingRequest(server.address(), {
    headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
    onRequest(req) {
      req.write('{');
    },
  });

  assert.equal(response.statusCode, 408);
  assert.equal(calls, 0);
});

test('times out incomplete HTTP headers before dispatch', async t => {
  let calls = 0;
  const server = await startedServer(t, {
    handlers: fakeHandlers({
      async handle() {
        calls += 1;
      },
    }),
    headersTimeoutMs: 30,
    requestTimeoutMs: 100,
  });

  const response = await partialHeaders(server.address(), 'POST / HTTP/1.1\r\nHost: localhost\r\n');

  assert.match(response, /^HTTP\/1\.1 408 Request Timeout\r\n/);
  assert.equal(calls, 0);
});

test('reports ready and draining health without dispatching new RPC work', async t => {
  const entered = deferred();
  const finish = deferred();
  let calls = 0;
  const server = await startedServer(t, {
    handlers: fakeHandlers({
      async handle(payload) {
        calls += 1;
        entered.resolve();
        await finish.promise;
        return { jsonrpc: '2.0', id: payload.id, result: true };
      },
    }),
    shutdownGraceMs: 80,
  });
  const ready = await request(server.address(), { method: 'GET', path: '/healthz' });
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(JSON.parse(ready.body), { status: 'ready' });
  const address = server.address();
  const drainingProbe = await openPartialRequest(address, 'GET /healthz HTTP/1.1\r\nHost: localhost\r\n');

  const rpcResponse = request(address, {
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'slow' }),
    headers: { 'content-type': 'application/json' },
  });
  await entered.promise;
  const stopping = server.stop();
  drainingProbe.socket.end('\r\n');
  const draining = await drainingProbe.response;

  assert.match(draining, /^HTTP\/1\.1 503 Service Unavailable\r\n/);
  assert.match(draining, /\r\n\r\n{"status":"draining"}$/);
  await assert.rejects(request(address, { agent: false, method: 'GET', path: '/healthz' }), /ECONNREFUSED|socket/i);
  assert.equal(calls, 1);
  finish.resolve();
  assert.equal((await rpcResponse).statusCode, 200);
  await stopping;
});

test('waits for in-flight handlers, releases last, and makes shutdown idempotent', async t => {
  const entered = deferred();
  const finish = deferred();
  const events = [];
  const server = createRpcServer({
    acquireLock: async () => ({
      async release() {
        events.push('release');
      },
    }),
    handlers: fakeHandlers({
      async handle(payload) {
        events.push('handle');
        entered.resolve();
        await finish.promise;
        events.push('handled');
        return { jsonrpc: '2.0', id: payload.id, result: true };
      },
    }),
    port: 0,
    shutdownGraceMs: 40,
    statePath: temporaryStatePath(t),
  });
  await server.start();
  const response = request(server.address(), {
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'slow' }),
    headers: { 'content-type': 'application/json' },
  });
  const responseOutcome = response.then(
    value => ({ value }),
    error => ({ error }),
  );
  await entered.promise;

  const firstStop = server.stop();
  const secondStop = server.stop();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(events, ['handle']);
  finish.resolve();
  await Promise.all([firstStop, secondStop]);

  assert.deepEqual(events, ['handle', 'handled', 'release']);
  assert.equal(server.address(), undefined);
  assert.match((await responseOutcome).error.message, /socket hang up|reset/i);
  await server.stop();
  assert.equal(events.filter(event => event === 'release').length, 1);
});

test('grace-closes a request body that has not reached the handler', async t => {
  let calls = 0;
  const server = await startedServer(t, {
    handlers: fakeHandlers({
      async handle() {
        calls += 1;
      },
    }),
    requestTimeoutMs: 1_000,
    shutdownGraceMs: 40,
  });
  const partial = await openPartialRequest(
    server.address(),
    'POST / HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{',
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  const started = Date.now();

  await server.stop();

  assert.ok(Date.now() - started < 300);
  assert.equal(await partial.response, '');
  assert.equal(calls, 0);
});

test('sanitizes handler and serialization failures', async t => {
  const secret = 'private-key-material';
  const server = await startedServer(t, {
    handlers: fakeHandlers({
      async handle(payload) {
        if (payload.method === 'throw') {
          throw new Error(secret);
        }
        const circular = { jsonrpc: '2.0', id: payload.id };
        circular.result = circular;
        return circular;
      },
    }),
  });
  const headers = { 'content-type': 'application/json' };

  for (const method of ['throw', 'circular']) {
    const response = await request(server.address(), {
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method }),
      headers,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), {
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32_603, message: 'Internal error' },
    });
    assert.equal(response.body.includes(secret), false);
  }
});

test('surfaces a release failure once after a normal shutdown', async t => {
  const releaseError = new Error('release failed');
  let releases = 0;
  const server = createRpcServer({
    acquireLock: async () => ({
      async release() {
        releases += 1;
        throw releaseError;
      },
    }),
    handlers: fakeHandlers(),
    port: 0,
    statePath: temporaryStatePath(t),
  });
  await server.start();

  await assert.rejects(server.stop(), releaseError);
  await assert.rejects(server.stop(), releaseError);
  assert.equal(releases, 1);
  assert.equal(server.address(), undefined);
});

test('releases the lock when the HTTP listener cannot bind', async t => {
  const occupied = net.createServer();
  await new Promise((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  let releases = 0;
  const server = createRpcServer({
    acquireLock: async () => ({
      async release() {
        releases += 1;
      },
    }),
    handlers: fakeHandlers(),
    port: occupied.address().port,
    statePath: temporaryStatePath(t),
  });

  await assert.rejects(server.start(), error => error.code === 'EADDRINUSE');
  assert.equal(releases, 1);
  assert.equal(server.address(), undefined);
});

test('validates server dependencies and bounded numeric settings before acquisition', () => {
  const handlers = fakeHandlers();
  const statePath = '/tmp/adapter-state.json';
  const invalid = [
    undefined,
    { handlers, statePath: '' },
    { handlers: {}, statePath },
    { handlers, maxRequestBytes: 0, statePath },
    { handlers, port: 65_536, statePath },
    { handlers, requestTimeoutMs: -1, statePath },
    { handlers, shutdownGraceMs: 1.5, statePath },
  ];

  for (const options of invalid) {
    assert.throws(() => createRpcServer(options));
  }
});
