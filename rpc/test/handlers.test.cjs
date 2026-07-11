'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { Transaction, Wallet, getCreateAddress, keccak256, toBeHex } = require('ethers');

const { AddressMap } = require('../address-map.cjs');
const { createRpcHandlers, nativeContractAddress } = require('../handlers.cjs');
const { TransactionJournal } = require('../journal.cjs');
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
    async buildCreate(value) {
      calls.push({ type: 'buildCreate', value });
      return { signedNativeTransaction: NATIVE_BYTES, nativeTransactionId: NATIVE_TXID };
    },
    async buildCall(value) {
      calls.push({ type: 'buildCall', value });
      return { signedNativeTransaction: NATIVE_BYTES, nativeTransactionId: NATIVE_TXID };
    },
    async simulateSigned(bytes, txid) {
      calls.push({ type: 'simulate', bytes, txid });
      return { nativeTransactionId: txid, energyUsed: 123, traceComplete: true, childCreateAttempts: [] };
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
          sender: operationContext.from,
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

test('reports chain ID and forwards nonce, gas price, and gas/energy estimates', async t => {
  const { handlers, calls } = fixture(t);
  assert.deepEqual(await handlers.handle({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), {
    jsonrpc: '2.0',
    id: 1,
    result: `0x${CHAIN_ID.toString(16)}`,
  });
  await handlers.handle({ jsonrpc: '2.0', id: 2, method: 'eth_getTransactionCount', params: [TARGET, 'latest'] });
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
      ['eth_getTransactionCount', [TARGET, 'latest']],
      ['eth_gasPrice', []],
      ['eth_estimateGas', [{ to: TARGET_ACTUAL, data: '0x1234' }]],
    ],
  );
});

test('composes deployment decode, provenance, rewrite, exact simulation, durable prepare, broadcast, wait, and reconcile', async t => {
  const raw = await signedTransaction();
  const sourceHash = keccak256(raw);
  const result = fixture(t, { sourceHash });
  const response = await send(result.handlers, raw);

  assert.deepEqual(response, { jsonrpc: '2.0', id: 1, result: sourceHash });
  assert.deepEqual(
    result.calls.map(call => call.type),
    ['buildCreate', 'simulate', 'prepared', 'broadcast', 'wait', 'reconcile'],
  );
  assert.equal(result.calls.find(call => call.type === 'broadcast').state, 'native-built');
  const operation = result.calls.find(call => call.type === 'prepared').operationContext;
  assert.equal(operation.predictedContractAddress, getCreateAddress({ from: WALLET.address, nonce: 3 }).toLowerCase());
  assert.equal(operation.actualTarget, ACTUAL_TARGET);
  assert.equal(operation.contractKind, 'contract');
  assert.deepEqual(operation.artifactIdentity, ARTIFACT_IDENTITY);
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
          childCreatePlan: { version: 1, sender: WALLET.address, attempts: [], counterBases: {}, counterFinals: {} },
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
