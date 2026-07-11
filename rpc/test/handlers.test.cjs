'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { Transaction, Wallet, getCreateAddress, keccak256, toBeHex } = require('ethers');

const { AddressMap } = require('../address-map.cjs');
const { contractKindForArtifact, createRpcHandlers, nativeContractAddress } = require('../handlers.cjs');
const { TransactionJournal, recordRetainedFailureInChain } = require('../journal.cjs');
const { acquireStateLock } = require('../state-lock.cjs');
const { JsonStore } = require('../store.cjs');

const PRIVATE_KEY = '11'.repeat(32);
const WALLET = new Wallet(PRIVATE_KEY);
const CHAIN_ID = 728126428n;
const CHAIN = `tre:${CHAIN_ID}`;
const NATIVE_BYTES = `0a02${'42'.repeat(80)}`;
const NATIVE_TXID = 'cd'.repeat(32);
const ACTUAL_TARGET = nativeContractAddress(NATIVE_TXID, WALLET.address);
const TARGET = `0x${'22'.repeat(20)}`;
const TARGET_ACTUAL = `0x${'a2'.repeat(20)}`;
const SOURCE_TX = `0x${'ab'.repeat(32)}`;
const ARTIFACT_IDENTITY = {
  sourceName: 'contracts/Box.sol',
  contractName: 'Box',
  fullyQualifiedName: 'contracts/Box.sol:Box',
};

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => (resolve = resolvePromise));
  return { promise, resolve };
}

async function signedTransaction(overrides = {}) {
  return WALLET.signTransaction({
    type: 0,
    chainId: CHAIN_ID,
    nonce: 3,
    gasLimit: 1_000_000,
    gasPrice: 100,
    value: 0,
    data: '0x6000',
    ...overrides,
  });
}

function translatedReceipt(sourceHash, context, overrides = {}) {
  return {
    transactionHash: sourceHash,
    transactionIndex: '0x0',
    blockHash: `0x${'44'.repeat(32)}`,
    blockNumber: '0x2a',
    from: context.from,
    to: context.to,
    cumulativeGasUsed: '0x5208',
    gasUsed: '0x5208',
    contractAddress: context.predictedContractAddress,
    logs: [],
    logsBloom: `0x${'00'.repeat(256)}`,
    status: '0x1',
    type: '0x0',
    effectiveGasPrice: '0x1',
    tron: {
      nativeTransactionId: NATIVE_TXID,
      actualContractAddress: context.kind === 'deployment' ? context.actualTarget : null,
      internalTransactions: [],
    },
    ...overrides,
  };
}

function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-tron-handlers-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const generatedStatePath = path.join(directory, 'state.json');
  const out = path.join(directory, 'out');
  fs.mkdirSync(out);
  const store = overrides.journal?.store ?? new JsonStore(generatedStatePath);
  const statePath = store.filePath;
  const journal =
    overrides.journal ??
    new TransactionJournal(store, CHAIN, {
      ownerId: overrides.ownerId ?? 'boot-current',
      allowRecovery: overrides.allowRecovery ?? false,
    });
  const addressMap = overrides.addressMap ?? new AddressMap(store, CHAIN);
  const calls = [];
  const upstream = overrides.upstream ?? {
    async request(method, params) {
      calls.push({ type: 'upstream', method, params });
      return `${method}:result`;
    },
  };
  const nativeClient = overrides.nativeClient ?? {
    async assertSimulationReady() {
      calls.push({ type: 'simulationReady' });
      return 'exact-signed';
    },
    async buildCreate(value) {
      calls.push({ type: 'buildCreate', value });
      return { signedNativeTransaction: NATIVE_BYTES, nativeTransactionId: NATIVE_TXID, transaction: { built: true } };
    },
    async buildCall(value) {
      calls.push({ type: 'buildCall', value });
      return { signedNativeTransaction: NATIVE_BYTES, nativeTransactionId: NATIVE_TXID, transaction: { built: true } };
    },
    async simulateSigned(bytes, txid, transaction) {
      calls.push({ type: 'simulate', bytes, txid, transaction });
      return {
        mode: 'exact-signed',
        nativeTransactionId: txid,
        simulationRootAddress: ACTUAL_TARGET,
        energyUsed: 123,
        traceComplete: true,
        childCreateAttempts: [],
      };
    },
    async broadcastSigned(bytes, txid) {
      calls.push({
        type: 'broadcast',
        bytes,
        txid,
        state: journal.get(overrides.sourceHash ?? `0x${'00'.repeat(32)}`)?.state,
      });
      return { nativeTransactionId: txid, duplicate: false };
    },
    async getTransaction(txid) {
      calls.push({ type: 'getTransaction', txid });
      return null;
    },
    async waitForReceipt(txid, context) {
      calls.push({ type: 'wait', txid, context });
      return translatedReceipt(context.sourceTransactionHash, context);
    },
  };
  const reconciler = overrides.reconciler ?? {
    recordPreparedNative(sourceHash, native, simulation, operationContext) {
      calls.push({ type: 'prepared', sourceHash, native, simulation, operationContext });
      return journal.recordNativeBuilt(sourceHash, native, {
        operationContext,
        childCreatePlan: {
          version: 1,
          mode: simulation.mode,
          sender: operationContext.from,
          simulationRootAddress: simulation.simulationRootAddress,
          attempts: [],
          counterBases: {},
          counterFinals: {},
        },
      });
    },
    reconcile(sourceHash, receipt) {
      calls.push({ type: 'reconcile', sourceHash, receipt });
      return journal.recordConfirmed(sourceHash, receipt);
    },
  };

  const handlerOptions = {
    config: {
      chainId: CHAIN_ID,
      chainIdentity: CHAIN,
      expectedSender: WALLET.address,
      foundryOut: out,
      stateFile: statePath,
      feeLimit: 1_000_000_000,
    },
    journal,
    addressMap,
    reconciler,
    nativeClient,
    upstream,
    matchDeploymentArtifact:
      overrides.matchDeploymentArtifact ??
      (() => ({
        abi: [{ type: 'constructor', inputs: [] }],
        artifact: { abi: [{ type: 'constructor', inputs: [] }] },
        creationBytecode: '0x6000',
        constructorData: '0x',
        contractName: 'Box',
        ...ARTIFACT_IDENTITY,
        provenanceHash: `0x${'55'.repeat(32)}`,
        requiresLinking: false,
      })),
    rewriteDeployment: overrides.rewriteDeployment ?? (async match => ({ ...match, initcode: '0x6000' })),
    rewriteCall: overrides.rewriteCall ?? (async decoded => ({ ...decoded, to: TARGET_ACTUAL })),
    ...(overrides.findArtifactPaths === undefined ? {} : { findArtifactPaths: overrides.findArtifactPaths }),
    ...(overrides.verifyArtifactProvenance === undefined
      ? {}
      : { verifyArtifactProvenance: overrides.verifyArtifactProvenance }),
    ...(overrides.useDefaultResolveCallContext
      ? {}
      : {
          resolveCallContext:
            overrides.resolveCallContext ??
            (async () => ({ targetKind: 'contract', abi: ['function ping()'], artifactIdentity: ARTIFACT_IDENTITY })),
        }),
  };
  const handlers = createRpcHandlers(handlerOptions);
  return { addressMap, calls, directory, handlers, journal, nativeClient, out, statePath, store, upstream };
}

async function send(handlers, raw, id = 1) {
  return handlers.handle({ jsonrpc: '2.0', id, method: 'eth_sendRawTransaction', params: [raw] });
}

test('reports chain ID and serves a virtual source nonce while forwarding gas queries', async t => {
  const { handlers, calls } = fixture(t);
  assert.deepEqual(await handlers.handle({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), {
    jsonrpc: '2.0',
    id: 1,
    result: `0x${CHAIN_ID.toString(16)}`,
  });
  assert.deepEqual(await handlers.handle({ jsonrpc: '2.0', id: 6, method: 'net_version', params: [] }), {
    jsonrpc: '2.0',
    id: 6,
    result: CHAIN_ID.toString(10),
  });
  assert.deepEqual(
    await handlers.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'eth_getTransactionCount',
      params: [WALLET.address, 'latest'],
    }),
    { jsonrpc: '2.0', id: 2, result: '0x0' },
  );
  await handlers.handle({ jsonrpc: '2.0', id: 3, method: 'eth_gasPrice', params: [] });
  await handlers.handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'eth_estimateGas',
    params: [{ to: TARGET, data: '0x1234' }],
  });
  assert.deepEqual(
    calls.filter(call => call.type === 'upstream').map(call => [call.method, call.params]),
    [
      ['eth_gasPrice', []],
      ['eth_estimateGas', [{ to: TARGET_ACTUAL, data: '0x1234' }]],
    ],
  );
});

test('derives latest and pending source nonces from durable journal state without upstream support', async t => {
  const raw = await signedTransaction({ nonce: 3 });
  const result = fixture(t, { sourceHash: keccak256(raw) });
  result.journal.receive(raw);
  const wrongChain = await signedTransaction({ chainId: 1, nonce: 99 });
  result.journal.receive(wrongChain);

  const count = block =>
    result.handlers.handle({
      jsonrpc: '2.0',
      id: block === 'pending' ? 1 : 2,
      method: 'eth_getTransactionCount',
      params: [WALLET.address, block],
    });
  assert.equal((await count('latest')).result, '0x0');
  assert.equal((await count('pending')).result, '0x4');
  assert.equal(
    (
      await result.handlers.handle({
        jsonrpc: '2.0',
        id: 3,
        method: 'eth_getTransactionCount',
        params: [TARGET, 'pending'],
      })
    ).result,
    '0x0',
  );
  assert.equal(
    (
      await result.handlers.handle({
        jsonrpc: '2.0',
        id: 4,
        method: 'eth_getTransactionCount',
        params: [WALLET.address, 'earliest'],
      })
    ).result,
    '0x0',
  );
  assert.equal(
    result.calls.some(call => call.type === 'upstream'),
    false,
  );

  await result.handlers.dispatch('eth_sendRawTransaction', [raw]);
  assert.equal((await count('latest')).result, '0x4');
  assert.equal((await count('pending')).result, '0x4');
  assert.equal(
    result.calls.some(call => call.type === 'upstream'),
    false,
  );

  const unsupported = await result.handlers.handle({
    jsonrpc: '2.0',
    id: 5,
    method: 'eth_getTransactionCount',
    params: [WALLET.address, '0x01'],
  });
  assert.equal(unsupported.error.code, -32602);
});

test('derives historical source nonces from confirmed journal receipts at canonical block quantities', async t => {
  const raw = await signedTransaction({ nonce: 3 });
  const result = fixture(t, { sourceHash: keccak256(raw) });
  await result.handlers.dispatch('eth_sendRawTransaction', [raw]);

  const count = async (block, address = WALLET.address) =>
    (
      await result.handlers.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionCount',
        params: [address, block],
      })
    ).result;

  assert.equal(await count('0x0'), '0x0');
  assert.equal(await count('0x29'), '0x0');
  assert.equal(await count('0x2a'), '0x4');
  assert.equal(await count('0x2b'), '0x4');
  assert.equal(await count('0x2a', TARGET), '0x0');
  assert.equal(
    result.calls.some(call => call.type === 'upstream'),
    false,
  );

  for (const block of ['0x', '0x00', '0x01', '0x2A', 'safe', 'finalized']) {
    const response = await result.handlers.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'eth_getTransactionCount',
      params: [WALLET.address, block],
    });
    assert.equal(response.error.code, -32602, block);
  }
});

test('normalizes the stock TRE empty state root before Forge deserializes a block', async t => {
  const hash = `0x${'12'.repeat(32)}`;
  const block = {
    hash,
    mixHash: `0x${'00'.repeat(32)}`,
    parentHash: `0x${'34'.repeat(32)}`,
    receiptsRoot: `0x${'00'.repeat(32)}`,
    sha3Uncles: `0x${'00'.repeat(32)}`,
    stateRoot: '0x',
    transactionsRoot: `0x${'56'.repeat(32)}`,
    logsBloom: `0x${'00'.repeat(256)}`,
    number: '0xa',
    transactions: [],
  };
  const result = fixture(t, {
    upstream: {
      async request(method, params) {
        result.calls.push({ type: 'upstream', method, params });
        return structuredClone(block);
      },
    },
  });

  const response = await result.handlers.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getBlockByNumber',
    params: ['latest', false],
  });
  assert.equal(response.result.stateRoot, `0x${'00'.repeat(32)}`);
  assert.equal(response.result.hash, hash);
  assert.equal(block.stateRoot, '0x');
  assert.deepEqual(result.calls, [{ type: 'upstream', method: 'eth_getBlockByNumber', params: ['latest', false] }]);

  block.stateRoot = '0x1234';
  const malformed = await result.handlers.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'eth_getBlockByHash',
    params: [hash, false],
  });
  assert.equal(malformed.error.code, -32000);

  block.stateRoot = `0x${'78'.repeat(32)}`;
  const valid = await result.handlers.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'eth_getBlockByHash',
    params: [hash, true],
  });
  assert.equal(valid.result.stateRoot, block.stateRoot);

  const missing = fixture(t, {
    upstream: {
      async request() {
        return null;
      },
    },
  });
  const nullResponse = await missing.handlers.handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'eth_getBlockByNumber',
    params: ['0xffff', false],
  });
  assert.equal(nullResponse.result, null);
});

test('provenance-matches and address-rewrites deployment gas estimates without building or journaling', async t => {
  const senderActual = `0x${'a1'.repeat(20)}`;
  for (const [dataKey, target] of [
    ['data', undefined],
    ['input', null],
  ]) {
    await t.test(`${dataKey}/${target === null ? 'null target' : 'absent target'}`, async t => {
      let matched;
      let rewritten;
      const result = fixture(t, {
        matchDeploymentArtifact(value) {
          matched = value;
          return {
            provenanceHash: `0x${'55'.repeat(32)}`,
            constructorData: `0x${'00'.repeat(32)}`,
            creationBytecode: '0x6000',
          };
        },
        async rewriteDeployment(match, dependencies) {
          rewritten = { match, mappedConstructorAddress: dependencies.addressMap.toActual(TARGET) };
          return { ...match, initcode: '0x60aabb' };
        },
      });
      result.addressMap.set({
        predicted: WALLET.address,
        actual: senderActual,
        creator: WALLET.address,
        sender: WALLET.address,
        sourceTransaction: SOURCE_TX,
      });
      result.addressMap.set({
        predicted: TARGET,
        actual: TARGET_ACTUAL,
        creator: WALLET.address,
        sender: WALLET.address,
        sourceTransaction: SOURCE_TX,
      });
      const transaction = { from: WALLET.address, [dataKey]: '0x6000', value: '0x0' };
      if (target === null) transaction.to = null;

      const response = await result.handlers.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_estimateGas',
        params: [transaction],
      });
      assert.equal(response.result, 'eth_estimateGas:result');
      assert.deepEqual(matched, { outputDirectory: result.out, initcode: '0x6000' });
      assert.equal(rewritten.match.provenanceHash, `0x${'55'.repeat(32)}`);
      assert.equal(rewritten.mappedConstructorAddress, TARGET_ACTUAL);
      assert.deepEqual(result.calls.at(-1), {
        type: 'upstream',
        method: 'eth_estimateGas',
        params: [
          {
            from: senderActual,
            [dataKey]: '0x60aabb',
            value: '0x0',
            ...(target === null ? { to: null } : {}),
          },
        ],
      });
      assert.equal(
        result.calls.some(call => call.type === 'buildCreate' || call.type === 'buildCall'),
        false,
      );
      assert.deepEqual(result.journal.list(), []);
    });
  }
});

test('rejects malformed or provenance-mismatched deployment estimates before upstream or native work', async t => {
  for (const [name, transaction] of [
    ['conflicting data/input', { data: '0x6000', input: '0x6001' }],
    ['artifact mismatch', { data: '0xdeadbeef' }],
  ]) {
    await t.test(name, async t => {
      const result = fixture(t, {
        matchDeploymentArtifact() {
          const error = new Error('No provenance-verified deployment artifact matches');
          error.code = 'ARTIFACT_NOT_FOUND';
          throw error;
        },
      });
      const response = await result.handlers.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_estimateGas',
        params: [transaction],
      });
      assert.equal(response.error.code, transaction.input === undefined ? -32000 : -32602);
      assert.equal(result.calls.length, 0);
      assert.deepEqual(result.journal.list(), []);
    });
  }
});

test('composes deployment decode, provenance, rewrite, exact simulation, durable prepare, broadcast, wait, and reconcile', async t => {
  const raw = await signedTransaction();
  const sourceHash = keccak256(raw);
  const result = fixture(t, { sourceHash });
  const response = await send(result.handlers, raw);

  assert.deepEqual(response, { jsonrpc: '2.0', id: 1, result: sourceHash });
  assert.deepEqual(
    result.calls.map(call => call.type),
    ['simulationReady', 'buildCreate', 'simulate', 'prepared', 'broadcast', 'wait', 'reconcile'],
  );
  assert.equal(result.calls.find(call => call.type === 'broadcast').state, 'native-built');
  const operation = result.calls.find(call => call.type === 'prepared').operationContext;
  assert.equal(operation.predictedContractAddress, getCreateAddress({ from: WALLET.address, nonce: 3 }).toLowerCase());
  assert.equal(operation.actualTarget, ACTUAL_TARGET);
  assert.equal(operation.contractKind, 'contract');
  assert.deepEqual(operation.artifactIdentity, ARTIFACT_IDENTITY);
  const receiptResolvers = result.calls.find(call => call.type === 'wait').context;
  assert.equal(receiptResolvers.resolveAddress(ACTUAL_TARGET), operation.predictedContractAddress);
  assert.equal(receiptResolvers.resolveInternalAddress(ACTUAL_TARGET), ACTUAL_TARGET);
  assert.equal(result.journal.get(sourceHash).state, 'confirmed');
});

test('joins concurrent source retries and never invokes a second native builder', async t => {
  const raw = await signedTransaction();
  let release;
  const gate = new Promise(resolve => (release = resolve));
  const result = fixture(t);
  const wait = result.nativeClient.waitForReceipt;
  result.nativeClient.waitForReceipt = async (...args) => {
    await gate;
    return wait(...args);
  };

  const first = send(result.handlers, raw, 1);
  const second = send(result.handlers, raw, 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.calls.filter(call => call.type === 'buildCreate').length, 1);
  release();
  assert.equal((await first).result, keccak256(raw));
  assert.equal((await second).result, keccak256(raw));
  assert.equal(result.calls.filter(call => call.type === 'broadcast').length, 1);
});

test('same-owner retries resume a transient builder failure without concurrent duplicate work', async t => {
  const raw = await signedTransaction({ nonce: 30 });
  const sourceHash = keccak256(raw);
  const result = fixture(t, { sourceHash });
  const originalBuild = result.nativeClient.buildCreate.bind(result.nativeClient);
  const firstBuild = deferred();
  let buildAttempts = 0;
  result.nativeClient.buildCreate = async value => {
    buildAttempts += 1;
    if (buildAttempts === 1) {
      await firstBuild.promise;
      throw new Error('TRON builder temporarily unavailable', {
        cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
      });
    }
    return originalBuild(value);
  };

  const first = send(result.handlers, raw, 1);
  const joined = send(result.handlers, raw, 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(buildAttempts, 1);
  firstBuild.resolve();
  assert.equal((await first).error.code, -32000);
  assert.equal((await joined).error.code, -32000);
  assert.equal(result.journal.get(sourceHash).state, 'received');
  assert.equal(result.journal.get(sourceHash).buildClaimOwner, result.journal.ownerId);
  assert.equal(result.calls.filter(call => call.type === 'broadcast').length, 0);

  assert.equal((await send(result.handlers, raw, 3)).result, sourceHash);
  assert.equal(buildAttempts, 2);
  assert.equal(result.calls.filter(call => call.type === 'broadcast').length, 1);
  assert.equal(result.journal.get(sourceHash).state, 'confirmed');
});

test('same-owner retries rebuild after a transient exact-simulation transport failure', async t => {
  const raw = await signedTransaction({ nonce: 31 });
  const sourceHash = keccak256(raw);
  const result = fixture(t, { sourceHash });
  const originalSimulation = result.nativeClient.simulateSigned.bind(result.nativeClient);
  let simulationAttempts = 0;
  result.nativeClient.simulateSigned = async (...args) => {
    simulationAttempts += 1;
    if (simulationAttempts === 1) {
      throw new Error('Exact signed-transaction simulation is unavailable', {
        cause: Object.assign(new Error('service unavailable'), { response: { status: 503 } }),
      });
    }
    return originalSimulation(...args);
  };

  assert.equal((await send(result.handlers, raw, 1)).error.code, -32000);
  assert.equal(result.journal.get(sourceHash).state, 'received');
  assert.equal(result.calls.filter(call => call.type === 'broadcast').length, 0);

  assert.equal((await send(result.handlers, raw, 2)).result, sourceHash);
  assert.equal(simulationAttempts, 2);
  assert.equal(result.calls.filter(call => call.type === 'buildCreate').length, 2);
  assert.equal(result.calls.filter(call => call.type === 'broadcast').length, 1);
});

test('ordinary send retries cannot take over a received claim owned by another boot', async t => {
  const raw = await signedTransaction({ nonce: 32 });
  const sourceHash = keccak256(raw);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-tron-foreign-claim-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new JsonStore(path.join(directory, 'state.json'));
  new TransactionJournal(store, CHAIN, { ownerId: 'boot-old' }).receive(raw);
  const journal = new TransactionJournal(store, CHAIN, { ownerId: 'boot-new' });
  const result = fixture(t, { journal, addressMap: new AddressMap(store, CHAIN) });

  const response = await send(result.handlers, raw);
  assert.equal(response.error.data.code, 'TRANSACTION_IN_PROGRESS');
  assert.equal(result.journal.get(sourceHash).state, 'received');
  assert.equal(result.journal.get(sourceHash).buildClaimOwner, 'boot-old');
  assert.equal(
    result.calls.some(call => call.type === 'buildCreate' || call.type === 'broadcast'),
    false,
  );
});

test('rewrites and builds a native call once with durable target metadata', async t => {
  const raw = await signedTransaction({ to: TARGET, nonce: 7, data: '0x1234' });
  const sourceHash = keccak256(raw);
  const result = fixture(t, { sourceHash });

  const response = await send(result.handlers, raw);
  assert.equal(response.result, sourceHash);
  assert.equal(result.calls.filter(call => call.type === 'buildCreate').length, 0);
  assert.equal(result.calls.filter(call => call.type === 'buildCall').length, 1);
  assert.equal(result.calls.find(call => call.type === 'buildCall').value.contractAddress, TARGET_ACTUAL);
  const operation = result.calls.find(call => call.type === 'prepared').operationContext;
  assert.equal(operation.kind, 'call');
  assert.equal(operation.to, TARGET.toLowerCase());
  assert.equal(operation.actualTarget, TARGET_ACTUAL);
  assert.deepEqual(operation.artifactIdentity, ARTIFACT_IDENTITY);
});

test('presents a confirmed call target in the same predicted or actual domain signed by Forge', async t => {
  for (const [index, sourceTarget] of [TARGET, TARGET_ACTUAL].entries()) {
    await t.test(index === 0 ? 'predicted source target' : 'actual source target', async t => {
      const raw = await signedTransaction({ to: sourceTarget, nonce: 40 + index, data: '0x1234' });
      const sourceHash = keccak256(raw);
      const result = fixture(t, { sourceHash });
      result.addressMap.set({
        predicted: TARGET,
        actual: TARGET_ACTUAL,
        creator: WALLET.address,
        sender: WALLET.address,
        sourceTransaction: SOURCE_TX,
      });

      assert.equal((await send(result.handlers, raw)).result, sourceHash);
      const operation = result.calls.find(call => call.type === 'prepared').operationContext;
      const receiptResolvers = result.calls.find(call => call.type === 'wait').context;
      assert.equal(operation.to.toLowerCase(), sourceTarget.toLowerCase());
      assert.equal(operation.actualTarget, TARGET_ACTUAL);
      assert.equal(receiptResolvers.resolveAddress(TARGET_ACTUAL), sourceTarget.toLowerCase());
    });
  }
});

test('recovers native-built and broadcast records without ever calling a builder', async t => {
  for (const [initialState, present, expectedBroadcasts] of [
    ['native-built', true, 0],
    ['native-built', false, 1],
    ['broadcast', true, 0],
    ['broadcast', false, 1],
  ]) {
    await t.test(`${initialState}/${present ? 'present' : 'absent'}`, async t => {
      const raw = await signedTransaction({ nonce: initialState === 'native-built' ? 4 : 5 });
      const sourceHash = keccak256(raw);
      const result = fixture(t, {
        sourceHash,
        nativeClient: undefined,
      });
      result.journal.receive(raw);
      const context = {
        kind: 'deployment',
        from: WALLET.address,
        to: null,
        nonce: initialState === 'native-built' ? '4' : '5',
        predictedContractAddress: getCreateAddress({
          from: WALLET.address,
          nonce: initialState === 'native-built' ? 4 : 5,
        }),
        actualTarget: ACTUAL_TARGET,
        contractKind: 'contract',
        artifactIdentity: ARTIFACT_IDENTITY,
        provenanceHash: `0x${'55'.repeat(32)}`,
      };
      result.reconciler?.recordPreparedNative;
      result.journal.recordNativeBuilt(
        sourceHash,
        { signedNativeTransaction: NATIVE_BYTES, nativeTransactionId: NATIVE_TXID },
        {
          operationContext: context,
          childCreatePlan: {
            version: 1,
            mode: 'exact-signed',
            sender: WALLET.address,
            simulationRootAddress: ACTUAL_TARGET,
            attempts: [],
            counterBases: {},
            counterFinals: {},
          },
        },
      );
      if (initialState === 'broadcast') result.journal.recordBroadcast(sourceHash);
      result.nativeClient.getTransaction = async txid => {
        result.calls.push({ type: 'getTransaction', txid });
        return present ? { confirmed: false, transaction: {} } : null;
      };

      const response = await send(result.handlers, raw);
      assert.equal(response.result, sourceHash);
      assert.equal(result.calls.filter(call => call.type === 'buildCreate' || call.type === 'buildCall').length, 0);
      assert.equal(result.calls.filter(call => call.type === 'broadcast').length, expectedBroadcasts);
      if (expectedBroadcasts === 1) {
        assert.equal(result.calls.find(call => call.type === 'broadcast').bytes, NATIVE_BYTES);
      }
      assert.equal(result.journal.get(sourceHash).state, 'confirmed');
    });
  }
});

test('startup recovery requires an authentic held state lock and explicitly CAS-recovers received claims', async t => {
  const raw = await signedTransaction({ nonce: 9 });
  const result = fixture(t, { ownerId: 'boot-new', allowRecovery: true });
  const oldJournal = new TransactionJournal(result.store, CHAIN, { ownerId: 'boot-old' });
  oldJournal.receive(raw);

  await assert.rejects(result.handlers.recoverStartup({ assertHeld() {} }), /authentic state lock/i);
  assert.equal(result.journal.get(keccak256(raw)).buildClaimOwner, 'boot-old');

  const wrongCapability = await acquireStateLock(path.join(result.directory, 'other-state.json'));
  await assert.rejects(result.handlers.recoverStartup(wrongCapability), /different state path/i);
  await wrongCapability.release();
  assert.equal(result.journal.get(keccak256(raw)).buildClaimOwner, 'boot-old');

  const capability = await acquireStateLock(result.statePath);
  t.after(() => capability.release());
  const recovered = await result.handlers.recoverStartup(capability);
  assert.deepEqual(recovered, [keccak256(raw)]);
  assert.equal(result.calls.filter(call => call.type === 'buildCreate').length, 1);
  assert.equal(result.journal.get(keccak256(raw)).state, 'confirmed');
});

test('replays durable receipts and Ethereum transactions after restart', async t => {
  const raw = await signedTransaction();
  const sourceHash = keccak256(raw);
  const first = fixture(t, { sourceHash });
  await send(first.handlers, raw);

  const restartedJournal = new TransactionJournal(new JsonStore(first.statePath), CHAIN, { ownerId: 'boot-restart' });
  const restarted = fixture(t, {
    journal: restartedJournal,
    addressMap: new AddressMap(restartedJournal.store, CHAIN),
  });
  const receipt = await restarted.handlers.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getTransactionReceipt',
    params: [sourceHash],
  });
  const transaction = await restarted.handlers.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'eth_getTransactionByHash',
    params: [sourceHash],
  });
  assert.equal(receipt.result.transactionHash, sourceHash);
  assert.equal(transaction.result.hash, sourceHash);
  assert.equal(transaction.result.blockNumber, '0x2a');
  assert.equal(transaction.result.from, WALLET.address);
  assert.equal(transaction.result.to, null);
  assert.equal(transaction.result.v, toBeHex(Transaction.from(raw).signature.networkV));
  for (const block of ['latest', 'pending']) {
    const count = await restarted.handlers.handle({
      jsonrpc: '2.0',
      id: block === 'latest' ? 3 : 4,
      method: 'eth_getTransactionCount',
      params: [WALLET.address, block],
    });
    assert.equal(count.result, '0x4');
  }
});

test('replays receipts only from confirmed journal records and hides retained success-shaped failure receipts', async t => {
  for (const state of ['received', 'native-built', 'broadcast', 'failed-retained']) {
    await t.test(state, async t => {
      const raw = await signedTransaction({
        nonce: 20 + ['received', 'native-built', 'broadcast', 'failed-retained'].indexOf(state),
      });
      const sourceHash = keccak256(raw);
      const result = fixture(t);
      result.journal.receive(raw);
      if (state !== 'received') {
        const operationContext = {
          kind: 'deployment',
          from: WALLET.address,
          to: null,
          nonce: String(20 + ['received', 'native-built', 'broadcast', 'failed-retained'].indexOf(state)),
          predictedContractAddress: getCreateAddress({
            from: WALLET.address,
            nonce: 20 + ['received', 'native-built', 'broadcast', 'failed-retained'].indexOf(state),
          }),
          actualTarget: ACTUAL_TARGET,
          contractKind: 'contract',
          artifactIdentity: ARTIFACT_IDENTITY,
          provenanceHash: `0x${'55'.repeat(32)}`,
        };
        result.journal.recordNativeBuilt(
          sourceHash,
          { signedNativeTransaction: NATIVE_BYTES, nativeTransactionId: NATIVE_TXID },
          {
            operationContext,
            childCreatePlan: {
              version: 1,
              mode: 'exact-signed',
              sender: WALLET.address,
              simulationRootAddress: ACTUAL_TARGET,
              attempts: [],
              counterBases: {},
              counterFinals: {},
            },
          },
        );
        if (state === 'broadcast' || state === 'failed-retained') result.journal.recordBroadcast(sourceHash);
        if (state === 'failed-retained') {
          const retained = translatedReceipt(sourceHash, operationContext, { status: '0x1' });
          result.store.transaction(CHAIN, chain =>
            recordRetainedFailureInChain(
              chain,
              sourceHash,
              { code: 'CHILD_CREATE_MISMATCH', message: 'receipt reconciliation failed' },
              retained,
            ),
          );
          assert.equal(result.journal.get(sourceHash).receipt.status, '0x1');
        }
      }

      const response = await result.handlers.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionReceipt',
        params: [sourceHash],
      });
      assert.deepEqual(response, { jsonrpc: '2.0', id: 1, result: null });
      assert.equal(result.calls.filter(call => call.type === 'upstream').length, 0);
    });
  }
});

test('maps code, storage, balance, and eth_call targets while preserving safe opaque calldata', async t => {
  const result = fixture(t, {
    resolveCallContext: async () => undefined,
  });
  result.addressMap.set({
    predicted: TARGET,
    actual: TARGET_ACTUAL,
    creator: WALLET.address,
    sender: WALLET.address,
    sourceTransaction: SOURCE_TX,
  });
  for (const [method, params] of [
    ['eth_getCode', [TARGET, 'latest']],
    ['eth_getStorageAt', [TARGET, '0x0', 'latest']],
    ['eth_getBalance', [TARGET, 'latest']],
    ['eth_call', [{ to: TARGET, data: '0x1234' }, 'latest']],
  ]) {
    await result.handlers.handle({ jsonrpc: '2.0', id: method, method, params });
  }
  assert.deepEqual(
    result.calls.filter(call => call.type === 'upstream').map(call => call.params),
    [
      [TARGET_ACTUAL, 'latest'],
      [TARGET_ACTUAL, '0x0', 'latest'],
      [TARGET_ACTUAL, 'latest'],
      [{ to: TARGET_ACTUAL, data: '0x1234' }, 'latest'],
    ],
  );

  await result.handlers.handle({
    jsonrpc: '2.0',
    id: 'zero',
    method: 'eth_getCode',
    params: [`0x${'00'.repeat(20)}`, 'latest'],
  });
  assert.deepEqual(result.calls.at(-1).params, [`0x${'00'.repeat(20)}`, 'latest']);
});

test('retries numbered immutable reads as latest only after the explicit stock TRE quantity error', async t => {
  const attempts = [];
  const result = fixture(t, {
    resolveCallContext: async () => undefined,
    upstream: {
      async request(method, params) {
        attempts.push({ method, params: structuredClone(params) });
        if (params.at(-1) === '0x13') {
          throw Object.assign(new Error('QUANTITY not supported, just support TAG as latest'), { code: -32602 });
        }
        return `${method}:latest`;
      },
    },
  });

  for (const [method, params] of [
    ['eth_getCode', [TARGET, '0x13']],
    ['eth_getBalance', [TARGET, '0x13']],
    ['eth_getStorageAt', [TARGET, '0x0', '0x13']],
    ['eth_call', [{ to: TARGET, data: '0x1234' }, '0x13']],
  ]) {
    const response = await result.handlers.handle({ jsonrpc: '2.0', id: method, method, params });
    assert.equal(response.result, `${method}:latest`);
  }
  assert.deepEqual(
    attempts.map(attempt => [attempt.method, attempt.params.at(-1)]),
    [
      ['eth_getCode', '0x13'],
      ['eth_getCode', 'latest'],
      ['eth_getBalance', '0x13'],
      ['eth_getBalance', 'latest'],
      ['eth_getStorageAt', '0x13'],
      ['eth_getStorageAt', 'latest'],
      ['eth_call', '0x13'],
      ['eth_call', 'latest'],
    ],
  );

  for (const error of [
    Object.assign(new Error('different invalid params'), { code: -32602 }),
    Object.assign(new Error('QUANTITY not supported, just support TAG as latest'), { code: -32000 }),
  ]) {
    const isolated = fixture(t, {
      upstream: {
        async request() {
          throw error;
        },
      },
    });
    const response = await isolated.handlers.handle({
      jsonrpc: '2.0',
      id: error.code,
      method: 'eth_getCode',
      params: [TARGET, '0x13'],
    });
    assert.equal(response.error.code, error.code);
    assert.equal(response.error.message, error.message);
  }
});

test('rejects opaque call bytes containing a known predicted ABI word when metadata is unavailable', async t => {
  const result = fixture(t, { resolveCallContext: async () => undefined });
  result.addressMap.set({
    predicted: TARGET,
    actual: TARGET_ACTUAL,
    creator: WALLET.address,
    sender: WALLET.address,
    sourceTransaction: SOURCE_TX,
  });
  const data = `0x12345678${'00'.repeat(12)}${TARGET.slice(2)}`;
  const response = await result.handlers.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: TARGET, data }, 'latest'],
  });
  assert.equal(response.error.code, -32000);
  assert.equal(response.error.data.code, 'OPAQUE_PREDICTED_ADDRESS');
  assert.equal(result.calls.filter(call => call.type === 'upstream').length, 0);
});

test('resolves predicted and actual addresses to EVM, TRON hex, Base58, provenance, and durable metadata', async t => {
  const result = fixture(t);
  result.addressMap.set({
    predicted: TARGET,
    actual: TARGET_ACTUAL,
    creator: WALLET.address,
    sender: WALLET.address,
    sourceTransaction: SOURCE_TX,
  });
  result.addressMap.setContractMetadata({
    predicted: TARGET,
    contractKind: 'proxy-admin',
    artifactIdentity: {
      sourceName: 'contracts/proxy/transparent/ProxyAdmin.sol',
      contractName: 'ProxyAdmin',
      fullyQualifiedName: 'contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin',
    },
    sourceTransaction: SOURCE_TX,
  });

  const response = await result.handlers.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tron_resolveAddress',
    params: [TARGET_ACTUAL],
  });
  assert.equal(response.result.predicted, TARGET);
  assert.equal(response.result.actual, TARGET_ACTUAL);
  assert.equal(response.result.tronHex, `41${TARGET_ACTUAL.slice(2)}`);
  assert.match(response.result.base58, /^T/);
  assert.equal(response.result.mapping.sourceTransaction, SOURCE_TX);
  assert.equal(response.result.metadata.contractKind, 'proxy-admin');

  const zero = await result.handlers.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tron_resolveAddress',
    params: [`0x${'00'.repeat(20)}`],
  });
  assert.equal(zero.result.predicted, `0x${'00'.repeat(20)}`);
  assert.equal(zero.result.mapping, null);
});

test('resolves an internally-created ProxyAdmin ABI from durable metadata and verified artifacts', async t => {
  let seenContext;
  const result = fixture(t, {
    useDefaultResolveCallContext: true,
    findArtifactPaths(outputDirectory, reference) {
      assert.equal(reference, 'contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin');
      return [path.join(outputDirectory, 'ProxyAdmin.sol', 'ProxyAdmin.json')];
    },
    verifyArtifactProvenance() {
      return { abi: ['function owner() view returns (address)'], provenanceHash: `0x${'66'.repeat(32)}` };
    },
    async rewriteCall(decoded, context) {
      seenContext = context;
      return { ...decoded, to: TARGET_ACTUAL };
    },
  });
  result.addressMap.set({
    predicted: TARGET,
    actual: TARGET_ACTUAL,
    creator: WALLET.address,
    sender: WALLET.address,
    sourceTransaction: SOURCE_TX,
  });
  const proxyAdminIdentity = {
    sourceName: 'contracts/proxy/transparent/ProxyAdmin.sol',
    contractName: 'ProxyAdmin',
    fullyQualifiedName: 'contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin',
  };
  result.addressMap.setContractMetadata({
    predicted: TARGET,
    contractKind: 'proxy-admin',
    artifactIdentity: proxyAdminIdentity,
    sourceTransaction: SOURCE_TX,
  });
  const raw = await signedTransaction({ to: TARGET, nonce: 15, data: '0x1234' });
  assert.equal((await send(result.handlers, raw)).result, keccak256(raw));
  assert.deepEqual(seenContext, {
    targetKind: 'proxy-admin',
    abi: ['function owner() view returns (address)'],
    artifactIdentity: proxyAdminIdentity,
    provenanceHash: `0x${'66'.repeat(32)}`,
  });
});

test('propagates upstream JSON-RPC errors without rewriting their code or data', async t => {
  const error = Object.assign(new Error('upstream reverted'), { code: -32042, data: { reason: 'boom' } });
  const { handlers } = fixture(t, {
    upstream: {
      async request() {
        throw error;
      },
    },
  });
  const response = await handlers.handle({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
  assert.deepEqual(response, {
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32042, message: 'upstream reverted', data: { reason: 'boom' } },
  });
});

test('implements strict JSON-RPC single, batch, notification, and invalid request semantics', async t => {
  const { handlers } = fixture(t);
  assert.deepEqual(await handlers.handle([]), {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32600, message: 'Invalid Request' },
  });
  const batch = await handlers.handle([
    { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
    { jsonrpc: '2.0', method: 'eth_gasPrice', params: [] },
    { jsonrpc: '2.0', id: 2, method: 'missing_method', params: [] },
    { jsonrpc: '2.0', id: 3, method: 'eth_chainId', params: {}, extra: true },
  ]);
  assert.equal(batch.length, 3);
  assert.equal(batch[0].result, `0x${CHAIN_ID.toString(16)}`);
  assert.equal(batch[1].error.code, -32601);
  assert.equal(batch[2].error.code, -32600);
  assert.equal(await handlers.handle({ jsonrpc: '2.0', method: 'eth_chainId', params: [] }), undefined);
  assert.equal(
    (await handlers.handle({ jsonrpc: '2.0', id: 4, method: 'eth_chainId', params: ['unexpected'] })).error.code,
    -32602,
  );
});

test('turns deterministic prebuild failures into durable terminal failures and never broadcasts', async t => {
  const raw = await signedTransaction({ nonce: 12 });
  const sourceHash = keccak256(raw);
  const result = fixture(t, {
    sourceHash,
    matchDeploymentArtifact() {
      const error = new Error('artifact mismatch');
      error.code = 'ARTIFACT_NOT_FOUND';
      throw error;
    },
  });
  const response = await send(result.handlers, raw);
  assert.equal(response.error.code, -32000);
  assert.equal(result.journal.get(sourceHash).state, 'failed');
  assert.equal(result.journal.get(sourceHash).failure.code, 'ARTIFACT_NOT_FOUND');
  assert.equal(result.calls.filter(call => call.type === 'broadcast').length, 0);
  assert.equal(
    (
      await result.handlers.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'eth_getTransactionByHash',
        params: [sourceHash],
      })
    ).result,
    null,
  );
});

test('classifies privileged contract kinds only for exact canonical TRON artifact identities', () => {
  const canonical = [
    ['openzeppelin-tron-solidity/contracts/proxy/TRC1967/TRC1967Proxy.sol', 'TRC1967Proxy', 'uups-proxy'],
    [
      'openzeppelin-tron-solidity/contracts/proxy/transparent/TransparentUpgradeableProxy.sol',
      'TransparentUpgradeableProxy',
      'transparent-proxy',
    ],
    ['openzeppelin-tron-solidity/contracts/proxy/transparent/ProxyAdmin.sol', 'ProxyAdmin', 'proxy-admin'],
    [
      'openzeppelin-tron-solidity/contracts/proxy/beacon/UpgradeableBeacon.sol',
      'UpgradeableBeacon',
      'upgradeable-beacon',
    ],
    ['openzeppelin-tron-solidity/contracts/proxy/beacon/BeaconProxy.sol', 'BeaconProxy', 'beacon-proxy'],
  ];
  for (const [sourceName, contractName, expected] of canonical) {
    for (const prefix of ['', 'lib/']) {
      const source = `${prefix}${sourceName}`;
      assert.equal(
        contractKindForArtifact({ sourceName: source, contractName, fullyQualifiedName: `${source}:${contractName}` }),
        expected,
      );
    }
  }

  for (const contractName of [
    'TRC1967Proxy',
    'ERC1967Proxy',
    'TransparentUpgradeableProxy',
    'ProxyAdmin',
    'UpgradeableBeacon',
    'BeaconProxy',
  ]) {
    const sourceName = `contracts/unrelated/${contractName}.sol`;
    assert.equal(
      contractKindForArtifact({ sourceName, contractName, fullyQualifiedName: `${sourceName}:${contractName}` }),
      'contract',
    );
  }
  assert.equal(
    contractKindForArtifact({
      sourceName: 'vendor/openzeppelin-tron-solidity/contracts/proxy/transparent/ProxyAdmin.sol',
      contractName: 'ProxyAdmin',
      fullyQualifiedName: 'vendor/openzeppelin-tron-solidity/contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin',
    }),
    'contract',
  );
});
