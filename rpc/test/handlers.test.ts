import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { Interface, Transaction, Wallet, getCreateAddress, keccak256, toBeHex, toUtf8Bytes } from 'ethers';

import { AddressMap } from '../../dist/rpc/address-map.js';
import { contractKindForArtifact, createRpcHandlers, nativeContractAddress } from '../../dist/rpc/handlers.js';
import { rewriteCall as realRewriteCall } from '../../dist/rpc/rewriter.js';
import { TransactionJournal, recordRetainedFailureInChain } from '../../dist/rpc/journal.js';
import { acquireStateLock } from '../../dist/rpc/state-lock.js';
import { JsonStore } from '../../dist/rpc/store.js';
import { UpstreamRpcError } from '../../dist/rpc/upstream.js';

// Test fixtures — signed transactions, journal records, native/simulation/receipt payloads, and the
// injectable handler dependency overrides — are deliberately loosely shaped, mirroring the external,
// dynamically-shaped data rpc-src/handlers.ts validates at runtime. `any` is used deliberately
// throughout this file for that content, matching rpc-src/handlers.ts's own handling.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonAny = any;

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
  let resolve!: (value?: unknown) => void;
  const promise = new Promise(resolvePromise => (resolve = resolvePromise));
  return { promise, resolve };
}

async function signedTransaction(overrides: JsonAny = {}) {
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

async function seedConfirmedDeployment(
  result: JsonAny,
  {
    identity = ARTIFACT_IDENTITY,
    provenanceHash = `0x${'55'.repeat(32)}`,
    predicted = TARGET,
    actual = TARGET_ACTUAL,
    nonce = 12,
  }: JsonAny = {},
) {
  const raw = await signedTransaction({ to: null, nonce, data: '0x6000' });
  const sourceHash = keccak256(raw);
  const operationContext = {
    kind: 'deployment',
    from: WALLET.address.toLowerCase(),
    to: null,
    nonce: String(nonce),
    predictedContractAddress: predicted,
    actualTarget: actual,
    contractKind: contractKindForArtifact(identity),
    artifactIdentity: identity,
    provenanceHash,
  };
  result.journal.receive(raw);
  result.journal.recordNativeBuilt(
    sourceHash,
    { signedNativeTransaction: NATIVE_BYTES, nativeTransactionId: NATIVE_TXID },
    {
      operationContext,
      childCreatePlan: {
        version: 1,
        mode: 'exact-signed',
        sender: operationContext.from,
        simulationRootAddress: actual,
        attempts: [],
        counterBases: {},
        counterFinals: {},
      },
    },
  );
  result.journal.recordBroadcast(sourceHash);
  result.journal.recordConfirmed(sourceHash, translatedReceipt(sourceHash, operationContext));
  return sourceHash;
}

function translatedReceipt(sourceHash: JsonAny, context: JsonAny, overrides: JsonAny = {}) {
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

function fixture(t: TestContext, overrides: JsonAny = {}): JsonAny {
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
  // The nonce-ordered send queue releases a source transaction only when its nonce equals the
  // signer's durable expected nonce. A lone transaction fixture whose nonce sits above zero models a
  // signer whose earlier nonces are already consumed on-chain, so seed the matching durable baseline
  // to reflect that expectation instead of leaving a spurious gap below the transaction.
  if (overrides.nonceBaseline !== undefined) {
    addressMap.setNonceBaseline({ sender: WALLET.address, nonce: BigInt(overrides.nonceBaseline) });
  }
  const calls: JsonAny[] = [];
  const upstream = overrides.upstream ?? {
    async request(method: JsonAny, params: JsonAny) {
      calls.push({ type: 'upstream', method, params });
      return `${method}:result`;
    },
  };
  const nativeClient = overrides.nativeClient ?? {
    async assertSimulationReady() {
      calls.push({ type: 'simulationReady' });
      return 'exact-signed';
    },
    async buildCreate(value: JsonAny) {
      calls.push({ type: 'buildCreate', value });
      return { signedNativeTransaction: NATIVE_BYTES, nativeTransactionId: NATIVE_TXID, transaction: { built: true } };
    },
    async buildCall(value: JsonAny) {
      calls.push({ type: 'buildCall', value });
      return { signedNativeTransaction: NATIVE_BYTES, nativeTransactionId: NATIVE_TXID, transaction: { built: true } };
    },
    async simulateSigned(bytes: JsonAny, txid: JsonAny, transaction: JsonAny) {
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
    async broadcastSigned(bytes: JsonAny, txid: JsonAny) {
      calls.push({
        type: 'broadcast',
        bytes,
        txid,
        state: journal.get(overrides.sourceHash ?? `0x${'00'.repeat(32)}`)?.state,
      });
      return { nativeTransactionId: txid, duplicate: false };
    },
    async getTransaction(txid: JsonAny) {
      calls.push({ type: 'getTransaction', txid });
      return null;
    },
    async waitForReceipt(txid: JsonAny, context: JsonAny) {
      calls.push({ type: 'wait', txid, context });
      return translatedReceipt(context.sourceTransactionHash, context);
    },
  };
  const reconciler = overrides.reconciler ?? {
    recordPreparedNative(sourceHash: JsonAny, native: JsonAny, simulation: JsonAny, operationContext: JsonAny) {
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
    reconcile(sourceHash: JsonAny, receipt: JsonAny) {
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
        artifact: { abi: [{ type: 'constructor', inputs: [] }], deployedBytecode: { object: '0x6001' } },
        creationBytecode: '0x6000',
        constructorData: '0x',
        // `contractName` is supplied by the `...ARTIFACT_IDENTITY` spread below.
        ...ARTIFACT_IDENTITY,
        provenanceHash: `0x${'55'.repeat(32)}`,
        requiresLinking: false,
      })),
    rewriteDeployment: overrides.rewriteDeployment ?? (async (match: JsonAny) => ({ ...match, initcode: '0x6000' })),
    rewriteCall: overrides.rewriteCall ?? (async (decoded: JsonAny) => ({ ...decoded, to: TARGET_ACTUAL })),
    ...(overrides.delay === undefined ? {} : { delay: overrides.delay }),
    ...(overrides.descriptorCaptureRetryDelayMs === undefined
      ? {}
      : { descriptorCaptureRetryDelayMs: overrides.descriptorCaptureRetryDelayMs }),
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

async function send(handlers: JsonAny, raw: JsonAny, id = 1) {
  return handlers.handle({ jsonrpc: '2.0', id, method: 'eth_sendRawTransaction', params: [raw] });
}

test('reports chain ID and serves a virtual source nonce while forwarding gas queries', async (t: TestContext) => {
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
    calls.filter((call: JsonAny) => call.type === 'upstream').map((call: JsonAny) => [call.method, call.params]),
    [
      ['eth_gasPrice', []],
      ['eth_estimateGas', [{ to: TARGET_ACTUAL, data: '0x1234' }]],
    ],
  );
});

test('derives latest and pending source nonces from durable journal state without upstream support', async (t: TestContext) => {
  const raw = await signedTransaction({ nonce: 0 });
  const result = fixture(t, { sourceHash: keccak256(raw) });
  result.journal.receive(raw);
  const wrongChain = await signedTransaction({ chainId: 1, nonce: 99 });
  result.journal.receive(wrongChain);

  const count = (block: JsonAny) =>
    result.handlers.handle({
      jsonrpc: '2.0',
      id: block === 'pending' ? 1 : 2,
      method: 'eth_getTransactionCount',
      params: [WALLET.address, block],
    });
  assert.equal((await count('latest')).result, '0x0');
  assert.equal((await count('pending')).result, '0x1');
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
    result.calls.some((call: JsonAny) => call.type === 'upstream'),
    false,
  );

  await result.handlers.dispatch('eth_sendRawTransaction', [raw]);
  assert.equal((await count('latest')).result, '0x1');
  assert.equal((await count('pending')).result, '0x1');
  assert.equal(
    result.calls.some((call: JsonAny) => call.type === 'upstream'),
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

test('derives historical source nonces from confirmed journal receipts at canonical block quantities', async (t: TestContext) => {
  const raw = await signedTransaction({ nonce: 0 });
  const result = fixture(t, { sourceHash: keccak256(raw) });
  await result.handlers.dispatch('eth_sendRawTransaction', [raw]);

  const count = async (block: JsonAny, address: JsonAny = WALLET.address) =>
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
  assert.equal(await count('0x2a'), '0x1');
  assert.equal(await count('0x2b'), '0x1');
  assert.equal(await count('0x2a', TARGET), '0x0');
  assert.equal(
    result.calls.some((call: JsonAny) => call.type === 'upstream'),
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

test('honors an adopted nonce-baseline floor for the configured sender and rejects a send below it', async (t: TestContext) => {
  const result = fixture(t);
  // Seed the durable floor directly through the address-map API, the way `adopt --nonce-baseline`
  // populates state, without going through the CLI.
  result.addressMap.setNonceBaseline({ sender: WALLET.address, nonce: 5n });

  const count = await result.handlers.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getTransactionCount',
    params: [WALLET.address, 'latest'],
  });
  assert.equal(count.result, '0x5');

  const stale = await signedTransaction({ nonce: 3 });
  await assert.rejects(
    result.handlers.dispatch('eth_sendRawTransaction', [stale]),
    (error: JsonAny) => error.code === 'NONCE_TOO_LOW',
  );
});

test('normalizes the stock TRE empty state root before Forge deserializes a block', async (t: TestContext) => {
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
      async request(method: JsonAny, params: JsonAny) {
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

test('provenance-matches and address-rewrites deployment gas estimates without building or journaling', async (t: TestContext) => {
  const senderActual = `0x${'a1'.repeat(20)}`;
  for (const [dataKey, target] of [
    ['data', undefined],
    ['input', null],
  ] as [string, null | undefined][]) {
    await t.test(`${dataKey}/${target === null ? 'null target' : 'absent target'}`, async (t: TestContext) => {
      let matched: JsonAny;
      let rewritten: JsonAny;
      const result = fixture(t, {
        matchDeploymentArtifact(value: JsonAny) {
          matched = value;
          return {
            provenanceHash: `0x${'55'.repeat(32)}`,
            constructorData: `0x${'00'.repeat(32)}`,
            creationBytecode: '0x6000',
          };
        },
        async rewriteDeployment(match: JsonAny, dependencies: JsonAny) {
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
      const transaction: JsonAny = { from: WALLET.address, [dataKey]: '0x6000', value: '0x0' };
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
        result.calls.some((call: JsonAny) => call.type === 'buildCreate' || call.type === 'buildCall'),
        false,
      );
      assert.deepEqual(result.journal.list(), []);
    });
  }
});

test('rejects malformed or provenance-mismatched deployment estimates before upstream or native work', async (t: TestContext) => {
  for (const [name, transaction] of [
    ['conflicting data/input', { data: '0x6000', input: '0x6001' }],
    ['artifact mismatch', { data: '0xdeadbeef' }],
  ] as [string, JsonAny][]) {
    await t.test(name, async (t: TestContext) => {
      const result = fixture(t, {
        matchDeploymentArtifact() {
          const error: JsonAny = new Error('No provenance-verified deployment artifact matches');
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

test('composes deployment decode, provenance, rewrite, exact simulation, durable prepare, broadcast, wait, and reconcile', async (t: TestContext) => {
  const raw = await signedTransaction();
  const sourceHash = keccak256(raw);
  const result = fixture(t, { sourceHash, nonceBaseline: 3 });
  const response = await send(result.handlers, raw);

  assert.deepEqual(response, { jsonrpc: '2.0', id: 1, result: sourceHash });
  assert.deepEqual(
    result.calls.map((call: JsonAny) => call.type),
    ['simulationReady', 'buildCreate', 'simulate', 'prepared', 'broadcast', 'wait', 'reconcile'],
  );
  assert.equal(result.calls.find((call: JsonAny) => call.type === 'broadcast').state, 'native-built');
  const operation = result.calls.find((call: JsonAny) => call.type === 'prepared').operationContext;
  assert.equal(operation.predictedContractAddress, getCreateAddress({ from: WALLET.address, nonce: 3 }).toLowerCase());
  assert.equal(operation.actualTarget, ACTUAL_TARGET);
  assert.equal(operation.contractKind, 'contract');
  assert.deepEqual(operation.artifactIdentity, ARTIFACT_IDENTITY);
  const receiptResolvers = result.calls.find((call: JsonAny) => call.type === 'wait').context;
  assert.equal(receiptResolvers.resolveAddress(ACTUAL_TARGET), operation.predictedContractAddress);
  assert.equal(receiptResolvers.resolveInternalAddress(ACTUAL_TARGET), ACTUAL_TARGET);
  assert.equal(result.journal.get(sourceHash).state, 'confirmed');
});

test('joins concurrent source retries and never invokes a second native builder', async (t: TestContext) => {
  const raw = await signedTransaction();
  let release!: (value?: unknown) => void;
  const gate = new Promise(resolve => (release = resolve));
  const result = fixture(t, { nonceBaseline: 3 });
  const wait = result.nativeClient.waitForReceipt;
  result.nativeClient.waitForReceipt = async (...args: JsonAny[]) => {
    await gate;
    return wait(...args);
  };

  const first = send(result.handlers, raw, 1);
  const second = send(result.handlers, raw, 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.calls.filter((call: JsonAny) => call.type === 'buildCreate').length, 1);
  release();
  assert.equal((await first).result, keccak256(raw));
  assert.equal((await second).result, keccak256(raw));
  assert.equal(result.calls.filter((call: JsonAny) => call.type === 'broadcast').length, 1);
});

test('processes a dependent call at its nonce order against the prior deployment mapping despite reversed concurrent arrival', async (t: TestContext) => {
  const rawDeploy = await signedTransaction({ to: null, nonce: 0, data: '0x6000' });
  const deployHash = keccak256(rawDeploy);
  const predicted = getCreateAddress({ from: WALLET.address, nonce: 0 }).toLowerCase();
  const rawCall = await signedTransaction({ to: predicted, nonce: 1, data: '0x1234' });
  const callHash = keccak256(rawCall);

  let result: JsonAny;
  // The real default resolve-call-context and call rewrite depend on the durable address map; this
  // models that dependency without the artifact-verification machinery — a call target resolves to
  // its actual native address only once the deployment that produced it has published its mapping.
  const reconciler = {
    recordPreparedNative(sourceHash: JsonAny, native: JsonAny, simulation: JsonAny, operationContext: JsonAny) {
      result.calls.push({ type: 'prepared', sourceHash, operationContext });
      return result.journal.recordNativeBuilt(sourceHash, native, {
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
    reconcile(sourceHash: JsonAny, receipt: JsonAny) {
      const context = result.journal.get(sourceHash).operationContext;
      if (context.kind === 'deployment') {
        result.addressMap.set({
          predicted: context.predictedContractAddress,
          actual: context.actualTarget,
          creator: context.from,
          sender: context.from,
          sourceTransaction: sourceHash,
        });
      }
      result.calls.push({ type: 'reconcile', sourceHash });
      return result.journal.recordConfirmed(sourceHash, receipt);
    },
  };
  result = fixture(t, {
    reconciler,
    resolveCallContext: async (target: JsonAny) =>
      result.addressMap.resolvePredicted(target) === undefined
        ? undefined
        : {
            targetKind: 'contract',
            abi: ['function ping()'],
            artifactIdentity: ARTIFACT_IDENTITY,
            provenanceHash: null,
          },
    async rewriteCall(decoded: JsonAny) {
      return { ...decoded, to: result.addressMap.toActual(decoded.to) ?? decoded.to };
    },
  });

  // Reversed arrival: the dependent call (nonce 1) is submitted before the deployment (nonce 0),
  // reproducing the out-of-order race a non-`--slow` Forge broadcast creates when its dependent
  // sends reach the gateway as separate concurrent requests.
  const callResponse = send(result.handlers, rawCall, 1);
  const deployResponse = send(result.handlers, rawDeploy, 2);
  assert.equal((await deployResponse).result, deployHash);
  assert.equal((await callResponse).result, callHash);

  const callBuild = result.calls.find((call: JsonAny) => call.type === 'buildCall');
  // On real Ethereum nonce 1 cannot execute before nonce 0; the gateway must likewise resolve the
  // call against the deployment's published actual address, not the untranslated predicted address.
  assert.equal(callBuild.value.contractAddress, ACTUAL_TARGET);
});

test('same-owner retries resume a transient builder failure without concurrent duplicate work', async (t: TestContext) => {
  const raw = await signedTransaction({ nonce: 30 });
  const sourceHash = keccak256(raw);
  const result = fixture(t, { sourceHash, nonceBaseline: 30 });
  const originalBuild = result.nativeClient.buildCreate.bind(result.nativeClient);
  const firstBuild = deferred();
  let buildAttempts = 0;
  result.nativeClient.buildCreate = async (value: JsonAny) => {
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
  assert.equal(result.calls.filter((call: JsonAny) => call.type === 'broadcast').length, 0);

  assert.equal((await send(result.handlers, raw, 3)).result, sourceHash);
  assert.equal(buildAttempts, 2);
  assert.equal(result.calls.filter((call: JsonAny) => call.type === 'broadcast').length, 1);
  assert.equal(result.journal.get(sourceHash).state, 'confirmed');
});

test('same-owner retries rebuild after a transient exact-simulation transport failure', async (t: TestContext) => {
  const raw = await signedTransaction({ nonce: 31 });
  const sourceHash = keccak256(raw);
  const result = fixture(t, { sourceHash, nonceBaseline: 31 });
  const originalSimulation = result.nativeClient.simulateSigned.bind(result.nativeClient);
  let simulationAttempts = 0;
  result.nativeClient.simulateSigned = async (...args: JsonAny[]) => {
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
  assert.equal(result.calls.filter((call: JsonAny) => call.type === 'broadcast').length, 0);

  assert.equal((await send(result.handlers, raw, 2)).result, sourceHash);
  assert.equal(simulationAttempts, 2);
  assert.equal(result.calls.filter((call: JsonAny) => call.type === 'buildCreate').length, 2);
  assert.equal(result.calls.filter((call: JsonAny) => call.type === 'broadcast').length, 1);
});

test('ordinary send retries cannot take over a received claim owned by another boot', async (t: TestContext) => {
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
    result.calls.some((call: JsonAny) => call.type === 'buildCreate' || call.type === 'broadcast'),
    false,
  );
});

test('rewrites and builds a native call once with durable target metadata', async (t: TestContext) => {
  const raw = await signedTransaction({ to: TARGET, nonce: 7, data: '0x1234' });
  const sourceHash = keccak256(raw);
  const result = fixture(t, { sourceHash, nonceBaseline: 7 });

  const response = await send(result.handlers, raw);
  assert.equal(response.result, sourceHash);
  assert.equal(result.calls.filter((call: JsonAny) => call.type === 'buildCreate').length, 0);
  assert.equal(result.calls.filter((call: JsonAny) => call.type === 'buildCall').length, 1);
  assert.equal(result.calls.find((call: JsonAny) => call.type === 'buildCall').value.contractAddress, TARGET_ACTUAL);
  const operation = result.calls.find((call: JsonAny) => call.type === 'prepared').operationContext;
  assert.equal(operation.kind, 'call');
  assert.equal(operation.to, TARGET.toLowerCase());
  assert.equal(operation.actualTarget, TARGET_ACTUAL);
  assert.deepEqual(operation.artifactIdentity, ARTIFACT_IDENTITY);
});

test('presents a confirmed call target in the same predicted or actual domain signed by Forge', async (t: TestContext) => {
  for (const [index, sourceTarget] of [TARGET, TARGET_ACTUAL].entries()) {
    await t.test(index === 0 ? 'predicted source target' : 'actual source target', async (t: TestContext) => {
      const raw = await signedTransaction({ to: sourceTarget, nonce: 40 + index, data: '0x1234' });
      const sourceHash = keccak256(raw);
      const result = fixture(t, { sourceHash, nonceBaseline: 40 + index });
      result.addressMap.set({
        predicted: TARGET,
        actual: TARGET_ACTUAL,
        creator: WALLET.address,
        sender: WALLET.address,
        sourceTransaction: SOURCE_TX,
      });

      assert.equal((await send(result.handlers, raw)).result, sourceHash);
      const operation = result.calls.find((call: JsonAny) => call.type === 'prepared').operationContext;
      const receiptResolvers = result.calls.find((call: JsonAny) => call.type === 'wait').context;
      assert.equal(operation.to.toLowerCase(), sourceTarget.toLowerCase());
      assert.equal(operation.actualTarget, TARGET_ACTUAL);
      assert.equal(receiptResolvers.resolveAddress(TARGET_ACTUAL), sourceTarget.toLowerCase());
    });
  }
});

test('recovers native-built and broadcast records without ever calling a builder', async (t: TestContext) => {
  for (const [initialState, present, expectedBroadcasts] of [
    ['native-built', true, 0],
    ['native-built', false, 1],
    ['broadcast', true, 0],
    ['broadcast', false, 1],
  ]) {
    await t.test(`${initialState}/${present ? 'present' : 'absent'}`, async (t: TestContext) => {
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
      result.nativeClient.getTransaction = async (txid: JsonAny) => {
        result.calls.push({ type: 'getTransaction', txid });
        return present ? { confirmed: false, transaction: {} } : null;
      };

      const response = await send(result.handlers, raw);
      assert.equal(response.result, sourceHash);
      assert.equal(
        result.calls.filter((call: JsonAny) => call.type === 'buildCreate' || call.type === 'buildCall').length,
        0,
      );
      assert.equal(result.calls.filter((call: JsonAny) => call.type === 'broadcast').length, expectedBroadcasts);
      if (expectedBroadcasts === 1) {
        assert.equal(result.calls.find((call: JsonAny) => call.type === 'broadcast').bytes, NATIVE_BYTES);
      }
      assert.equal(result.journal.get(sourceHash).state, 'confirmed');
    });
  }
});

test('startup recovery requires an authentic held state lock and explicitly CAS-recovers received claims', async (t: TestContext) => {
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
  assert.equal(result.calls.filter((call: JsonAny) => call.type === 'buildCreate').length, 1);
  assert.equal(result.journal.get(keccak256(raw)).state, 'confirmed');
});

test('replays interrupted received builds in ascending nonce order, not journal storage order', async (t: TestContext) => {
  // nonce 2 has a higher source hash than nonce 4, so hash-ordered replay would process nonce 4
  // first; recovery must instead replay the lower nonce first to preserve dependent ordering.
  const lower = await signedTransaction({ to: null, nonce: 2, data: '0x6000' });
  const higher = await signedTransaction({ to: null, nonce: 4, data: '0x6000' });
  assert.equal(keccak256(lower) > keccak256(higher), true);

  const result = fixture(t, { ownerId: 'boot-new', allowRecovery: true });
  const oldJournal = new TransactionJournal(result.store, CHAIN, { ownerId: 'boot-old' });
  oldJournal.receive(higher);
  oldJournal.receive(lower);

  const capability = await acquireStateLock(result.statePath);
  t.after(() => capability.release());
  const recovered = await result.handlers.recoverStartup(capability);

  assert.deepEqual(recovered, [keccak256(lower), keccak256(higher)]);
  assert.deepEqual(
    result.calls.filter((call: JsonAny) => call.type === 'prepared').map((call: JsonAny) => call.operationContext.nonce),
    ['2', '4'],
  );
});

test('replays durable receipts and Ethereum transactions after restart', async (t: TestContext) => {
  const raw = await signedTransaction();
  const sourceHash = keccak256(raw);
  const first = fixture(t, { sourceHash, nonceBaseline: 3 });
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
  assert.equal(transaction.result.v, toBeHex(Transaction.from(raw).signature!.networkV!));
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

test('replays receipts only from confirmed journal records and hides retained success-shaped failure receipts', async (t: TestContext) => {
  for (const state of ['received', 'native-built', 'broadcast', 'failed-retained']) {
    await t.test(state, async (t: TestContext) => {
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
          result.store.transaction(CHAIN, (chain: JsonAny) =>
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
      assert.equal(result.calls.filter((call: JsonAny) => call.type === 'upstream').length, 0);
    });
  }
});

test('maps code, storage, balance, and eth_call targets while preserving safe opaque calldata', async (t: TestContext) => {
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
    result.calls.filter((call: JsonAny) => call.type === 'upstream').map((call: JsonAny) => call.params),
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

test('eth_getLogs forward-maps the filter to actual and reverse-maps returned log addresses to predicted', async (t: TestContext) => {
  const paddedActual = `0x${'00'.repeat(12)}${'a2'.repeat(20)}`;
  const paddedPredicted = `0x${'00'.repeat(12)}${'22'.repeat(20)}`;
  const signature = `0x${'dd'.repeat(32)}`;
  const captured: JsonAny[] = [];
  const upstreamLogs = [
    { address: TARGET_ACTUAL, topics: [signature, paddedActual], data: paddedActual, blockNumber: '0x2a', logIndex: '0x0' },
  ];
  const result = fixture(t, {
    upstream: {
      async request(method: JsonAny, params: JsonAny) {
        captured.push({ method, params });
        return method === 'eth_getLogs' ? upstreamLogs : `${method}:result`;
      },
    },
  });
  result.addressMap.set({
    predicted: TARGET,
    actual: TARGET_ACTUAL,
    creator: WALLET.address,
    sender: WALLET.address,
    sourceTransaction: SOURCE_TX,
  });

  const response = await result.handlers.handle({
    jsonrpc: '2.0',
    id: 'logs',
    method: 'eth_getLogs',
    params: [{ address: TARGET, topics: [signature, paddedPredicted], fromBlock: '0x1' }],
  });

  // Inbound: the predicted filter address and address-topic are mapped to the actual world before
  // the node ever sees them — otherwise the node has nothing at the predicted address and matches none.
  const forwarded = captured.find((call: JsonAny) => call.method === 'eth_getLogs');
  assert.deepEqual(forwarded.params, [{ address: TARGET_ACTUAL, topics: [signature, paddedActual], fromBlock: '0x1' }]);

  // Outbound: the returned log's emitter address, indexed address topic, and data address are all
  // reverse-mapped back to the predicted world; the event-signature topic is left untouched.
  assert.deepEqual(response.result, [
    { address: TARGET, topics: [signature, paddedPredicted], data: paddedPredicted, blockNumber: '0x2a', logIndex: '0x0' },
  ]);
});

// A predicted deployment's runtime code carries its role immutable (_admin/_beacon/__self) holding an
// actual-world address; eth_getCode must project that word to the predicted world so code agrees with
// the reverse-mapped storage slot. Which word to rewrite comes from the deployment's provenance-bound
// semantic descriptors in the durable artifact snapshot — never a coincidental low-20 match.
const IMMUTABLE_ADMIN_ACTUAL = `0x${'a4'.repeat(20)}`;
const IMMUTABLE_ADMIN_PREDICTED = `0x${'d4'.repeat(20)}`;
const PROXY_IDENTITY = {
  sourceName: 'openzeppelin-tron-solidity/contracts/proxy/transparent/TransparentUpgradeableProxy.sol',
  contractName: 'TransparentUpgradeableProxy',
  fullyQualifiedName:
    'openzeppelin-tron-solidity/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy',
};

function seedProxyWithImmutable(result: JsonAny, opts: JsonAny = {}) {
  const {
    provenanceHash = `0x${'71'.repeat(32)}`,
    contractKind = 'transparent-proxy',
    controllerActual = IMMUTABLE_ADMIN_ACTUAL,
    controllerPredicted = IMMUTABLE_ADMIN_PREDICTED,
    mapController = true,
    // The snapshot's runtime-template hash; a zero-immutable proxy's raw-code pass-through verifies the
    // served code against it, so those tests seed the keccak of the code the upstream stub serves.
    runtimeBytecodeHash = `0x${'99'.repeat(32)}`,
    // When false, the artifact snapshot (with immutable offsets) is written but NO deployment-descriptor
    // record is seeded, modeling a legacy/pending deployment that eth_getCode enriches ephemerally.
    descriptorRecord = true,
  } = opts;
  const role = contractKind === 'transparent-proxy' ? 'admin' : contractKind === 'beacon-proxy' ? 'beacon' : 'self';
  // A 'self' descriptor commits to the deployment's OWN actual (a UUPS impl's __self); a proxy controller
  // descriptor commits to the embedded admin/beacon actual. `descriptors` may be passed explicitly,
  // including `null` to model a legacy deployment with neither a descriptor record nor snapshot offsets,
  // or `[]` for a captured deployment that carries no role immutable.
  const expectedActual = role === 'self' ? TARGET_ACTUAL : controllerActual;
  const descriptors = 'descriptors' in opts ? opts.descriptors : [{ role, start: 2, length: 32, expectedActual }];
  result.addressMap.set({
    predicted: TARGET,
    actual: TARGET_ACTUAL,
    creator: WALLET.address,
    sender: WALLET.address,
    sourceTransaction: SOURCE_TX,
  });
  // A proxy controller (admin/beacon) is a distinct mapped deployment; a 'self' immutable projects
  // through the deployment's own TARGET mapping set above.
  if (mapController && role !== 'self') {
    result.addressMap.set({
      predicted: controllerPredicted,
      actual: controllerActual,
      creator: WALLET.address,
      sender: WALLET.address,
      sourceTransaction: `0x${'ac'.repeat(32)}`,
    });
  }
  result.addressMap.setContractMetadata({
    predicted: TARGET,
    contractKind,
    artifactIdentity: PROXY_IDENTITY,
    sourceTransaction: SOURCE_TX,
    provenanceHash,
  });
  // Descriptors === null models a LEGACY deployment: no snapshot offsets and no descriptor record, so
  // ephemeral enrichment has nothing to rebuild from and a proxy fails closed. Otherwise the snapshot
  // carries the artifact-scoped offsets derived from the descriptors' byte ranges.
  const legacy = descriptors === null || descriptors === undefined;
  // `references` may be passed explicitly to make the snapshot offsets disagree with the seeded
  // descriptors (e.g. an empty descriptor record for an artifact that DOES declare an immutable).
  const references =
    'references' in opts ? opts.references : legacy ? undefined : descriptors.map((d: JsonAny) => ({ start: d.start, length: d.length }));
  result.addressMap.setArtifactSnapshot({
    provenanceHash,
    artifactIdentity: PROXY_IDENTITY,
    contractKind,
    abi: [],
    creationBytecodeHash: `0x${'88'.repeat(32)}`,
    runtimeBytecodeHash,
    ...(references === undefined ? {} : { immutableReferences: references }),
  });
  if (!legacy && descriptorRecord) {
    result.addressMap.setDeploymentDescriptor({ predicted: TARGET, status: 'complete', descriptors });
  }
}

// A 32-byte immutable word at byte offset 2 (chars 4..67): 12 zero bytes then the address low 20.
function proxyRuntimeCode(embedded: string): string {
  return `0x6080${'00'.repeat(12)}${embedded.slice(2)}6000`;
}

// Two 32-byte immutable words, at byte offsets 2 and 34, each holding an address in its low 20 bytes.
function twoWordRuntimeCode(first: string, second: string): string {
  return `0x6080${'00'.repeat(12)}${first.slice(2)}${'00'.repeat(12)}${second.slice(2)}6000`;
}

test('projects address-bearing immutables in eth_getCode for a mapped predicted proxy', async (t: TestContext) => {
  const result = fixture(t, {
    resolveCallContext: async () => undefined,
    upstream: {
      async request(method: JsonAny, params: JsonAny) {
        if (method === 'eth_getCode') return proxyRuntimeCode(IMMUTABLE_ADMIN_ACTUAL);
        return `${method}:result`;
      },
    },
  });
  seedProxyWithImmutable(result);

  const response = await result.handlers.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getCode',
    params: [TARGET, 'latest'],
  });
  // The embedded actual admin must be projected to its predicted address in the returned code.
  assert.equal(response.result, proxyRuntimeCode(IMMUTABLE_ADMIN_PREDICTED));
});

test('reads the raw upstream code for an actual (non-predicted) address without projecting', async (t: TestContext) => {
  const result = fixture(t, {
    resolveCallContext: async () => undefined,
    upstream: {
      async request(method: JsonAny) {
        if (method === 'eth_getCode') return proxyRuntimeCode(IMMUTABLE_ADMIN_ACTUAL);
        return `${method}:result`;
      },
    },
  });
  seedProxyWithImmutable(result);

  const response = await result.handlers.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getCode',
    params: [TARGET_ACTUAL, 'latest'],
  });
  // An actual-world read is served byte-for-byte; the embedded admin stays actual.
  assert.equal(response.result, proxyRuntimeCode(IMMUTABLE_ADMIN_ACTUAL));
});

test('fails closed for a transparent proxy whose snapshot lacks descriptors', async (t: TestContext) => {
  const result = fixture(t, {
    resolveCallContext: async () => undefined,
    upstream: {
      async request(method: JsonAny) {
        if (method === 'eth_getCode') return proxyRuntimeCode(IMMUTABLE_ADMIN_ACTUAL);
        return `${method}:result`;
      },
    },
  });
  // A legacy snapshot predating the descriptor capture: a proxy with no admin descriptor cannot project.
  seedProxyWithImmutable(result, { descriptors: null });

  const response = await result.handlers.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getCode',
    params: [TARGET, 'latest'],
  });
  assert.equal(response.error.code, -32000);
  assert.equal(response.error.data.code, 'UNPROJECTABLE_PROXY_CODE');
});

test('passes through empty upstream code for a mapped predicted proxy instead of failing closed', async (t: TestContext) => {
  const result = fixture(t, {
    resolveCallContext: async () => undefined,
    upstream: {
      async request(method: JsonAny) {
        if (method === 'eth_getCode') return '0x';
        return `${method}:result`;
      },
    },
  });
  // A fully-mapped proxy with offsets present, but the upstream reports no code at this block.
  seedProxyWithImmutable(result);

  const response = await result.handlers.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getCode',
    params: [TARGET, 'latest'],
  });
  // Code-less reads (e.g. a historical or pre-deployment block) have no immutable to project and must
  // not trip the proxy fail-closed path.
  assert.equal(response.result, '0x');
  assert.equal(response.error, undefined);
});

test('fails closed for a beacon proxy whose embedded beacon does not resolve to a mapped address', async (t: TestContext) => {
  const result = fixture(t, {
    resolveCallContext: async () => undefined,
    upstream: {
      async request(method: JsonAny) {
        if (method === 'eth_getCode') return proxyRuntimeCode(IMMUTABLE_ADMIN_ACTUAL);
        return `${method}:result`;
      },
    },
  });
  // The beacon immutable is present in the code but never mapped, so its word cannot be projected.
  seedProxyWithImmutable(result, { contractKind: 'beacon-proxy', mapController: false });

  const response = await result.handlers.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getCode',
    params: [TARGET, 'latest'],
  });
  assert.equal(response.error.code, -32000);
  assert.equal(response.error.data.code, 'UNPROJECTABLE_PROXY_CODE');
});

test('projects a UUPS impl __self at every captured offset to its own predicted address', async (t: TestContext) => {
  // A UUPS implementation is a plain 'contract' kind whose __self immutable holds its own actual
  // address, possibly at several offsets; each is projected to the deployment's predicted address.
  const runtimeCode = twoWordRuntimeCode(TARGET_ACTUAL, TARGET_ACTUAL);
  const result = fixture(t, {
    resolveCallContext: async () => undefined,
    upstream: {
      async request(method: JsonAny) {
        if (method === 'eth_getCode') return runtimeCode;
        return `${method}:result`;
      },
    },
  });
  seedProxyWithImmutable(result, {
    contractKind: 'contract',
    descriptors: [
      { role: 'self', start: 2, length: 32, expectedActual: TARGET_ACTUAL },
      { role: 'self', start: 34, length: 32, expectedActual: TARGET_ACTUAL },
    ],
  });
  const mapped = await result.handlers.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getCode',
    params: [TARGET, 'latest'],
  });
  assert.equal(mapped.result, twoWordRuntimeCode(TARGET, TARGET));
});

// The semantic-binding guarantee: a `contract` whose non-role address immutable happens to hold a value
// that resolves to a mapped predicted address must be LEFT UNTOUCHED. Capture never records a descriptor
// for a non-role immutable, so the deployment's descriptor list is empty and eth_getCode rewrites
// nothing — a coincidental low-20 match is never projected (the uniform model would have rewritten it).
test('leaves a mapped non-role contract immutable untouched in eth_getCode', async (t: TestContext) => {
  const runtimeCode = proxyRuntimeCode(IMMUTABLE_ADMIN_ACTUAL);
  const result = fixture(t, {
    resolveCallContext: async () => undefined,
    upstream: {
      async request(method: JsonAny) {
        if (method === 'eth_getCode') return runtimeCode;
        return `${method}:result`;
      },
    },
  });
  // The embedded address is mapped (IMMUTABLE_ADMIN_ACTUAL) but is not this contract's own actual, so
  // capture produced no descriptor for it; the code must pass through byte-for-byte.
  seedProxyWithImmutable(result, { contractKind: 'contract', descriptors: [] });
  const response = await result.handlers.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getCode',
    params: [TARGET, 'latest'],
  });
  assert.equal(response.result, runtimeCode);
});

// A proxy artifact that declares NO immutables at all (its admin/beacon lives only in the ERC-1967
// storage slots, as in the OpenZeppelin v4 proxies) embeds no address in its runtime code, so raw code
// cannot contradict the reverse-mapped storage slots. A complete-but-empty descriptor record backed by
// authoritative empty snapshot offsets serves the code byte-for-byte instead of failing closed.
test('serves raw code for a transparent proxy whose artifact declares no immutables', async (t: TestContext) => {
  const runtimeCode = '0x60806000';
  const result = fixture(t, {
    resolveCallContext: async () => undefined,
    upstream: {
      async request(method: JsonAny) {
        if (method === 'eth_getCode') return runtimeCode;
        return `${method}:result`;
      },
    },
  });
  // Snapshot offsets [] (the artifact declares no immutables), a captured complete/empty record, and a
  // runtime-template hash matching the served code (a zero-immutable deployment's code IS its template).
  seedProxyWithImmutable(result, { descriptors: [], runtimeBytecodeHash: keccak256(runtimeCode) });
  const response = await result.handlers.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getCode',
    params: [TARGET, 'latest'],
  });
  assert.equal(response.error, undefined);
  assert.equal(response.result, runtimeCode);
});

// The same zero-immutable proxy read before any descriptor record exists (pending capture or legacy):
// the ephemeral enrichment resolves authoritative empty offsets and passes the code through.
test('serves raw code ephemerally for a zero-immutable proxy with no descriptor record', async (t: TestContext) => {
  const runtimeCode = '0x60806000';
  const result = fixture(t, {
    resolveCallContext: async () => undefined,
    upstream: {
      async request(method: JsonAny) {
        if (method === 'eth_getCode') return runtimeCode;
        return `${method}:result`;
      },
    },
  });
  seedProxyWithImmutable(result, { descriptors: [], descriptorRecord: false, runtimeBytecodeHash: keccak256(runtimeCode) });
  const response = await result.handlers.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getCode',
    params: [TARGET, 'latest'],
  });
  assert.equal(response.error, undefined);
  assert.equal(response.result, runtimeCode);
});

// The provenance hash binds creation bytecode and sources, NOT the deployed bytecode's immutable
// reference map — so an artifact whose reference map was stripped (tampered or corrupted) still
// verifies and captures an authoritative-looking empty range list. The zero-immutable pass-through
// therefore also verifies the SERVED code against the snapshot's runtime-template hash: a genuine
// zero-immutable deployment's on-chain code equals its template byte-for-byte, while a proxy whose
// immutables were hidden carries live addresses where the template has zeros. Mismatch fails closed.
test('fails closed for a zero-immutable proxy record whose served code does not match the runtime template', async (t: TestContext) => {
  const result = fixture(t, {
    resolveCallContext: async () => undefined,
    upstream: {
      async request(method: JsonAny) {
        // The served code embeds a live admin address — it cannot be the zero-immutable template.
        if (method === 'eth_getCode') return proxyRuntimeCode(IMMUTABLE_ADMIN_ACTUAL);
        return `${method}:result`;
      },
    },
  });
  // Empty offsets and an empty complete record, but the template hash disagrees with the served code.
  seedProxyWithImmutable(result, { descriptors: [], runtimeBytecodeHash: keccak256('0x60806000') });
  const response = await result.handlers.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getCode',
    params: [TARGET, 'latest'],
  });
  assert.equal(response.error.code, -32000);
  assert.equal(response.error.data.code, 'UNPROJECTABLE_PROXY_CODE');
});

// The empty-record pass-through is gated on the ARTIFACT declaring no immutables: a complete-but-empty
// record for an artifact whose snapshot offsets DO declare an address-width immutable is a capture
// defect, and serving raw code would resurrect the projected-vs-storage contradiction. Fail closed.
test('fails closed for a proxy whose complete record is empty but artifact declares an address immutable', async (t: TestContext) => {
  const result = fixture(t, {
    resolveCallContext: async () => undefined,
    upstream: {
      async request(method: JsonAny) {
        if (method === 'eth_getCode') return proxyRuntimeCode(IMMUTABLE_ADMIN_ACTUAL);
        return `${method}:result`;
      },
    },
  });
  seedProxyWithImmutable(result, { descriptors: [], references: [{ start: 2, length: 32 }] });
  const response = await result.handlers.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getCode',
    params: [TARGET, 'latest'],
  });
  assert.equal(response.error.code, -32000);
  assert.equal(response.error.data.code, 'UNPROJECTABLE_PROXY_CODE');
});

// A descriptor is an authoritative commitment: if the on-chain runtime word no longer equals the
// captured expectedActual, that is artifact/code drift and eth_getCode fails closed even for a plain
// contract, rather than serving code that contradicts the commitment.
test('fails closed when a contract self descriptor no longer matches the on-chain code', async (t: TestContext) => {
  const result = fixture(t, {
    resolveCallContext: async () => undefined,
    upstream: {
      async request(method: JsonAny) {
        if (method === 'eth_getCode') return proxyRuntimeCode(IMMUTABLE_ADMIN_ACTUAL);
        return `${method}:result`;
      },
    },
  });
  // Captured expectedActual is the contract's own actual (TARGET_ACTUAL), but the live word now holds a
  // different address, so the commitment is violated.
  seedProxyWithImmutable(result, { contractKind: 'contract' });
  const response = await result.handlers.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getCode',
    params: [TARGET, 'latest'],
  });
  assert.equal(response.error.code, -32000);
  assert.equal(response.error.data.code, 'UNPROJECTABLE_PROXY_CODE');
});

test('reads raw code for a mapped predicted address that has no resolvable metadata', async (t: TestContext) => {
  const runtimeCode = proxyRuntimeCode(IMMUTABLE_ADMIN_ACTUAL);
  const result = fixture(t, {
    resolveCallContext: async () => undefined,
    upstream: {
      async request(method: JsonAny) {
        if (method === 'eth_getCode') return runtimeCode;
        return `${method}:result`;
      },
    },
  });
  // Mapped but unmanaged: no contract metadata and no journal provenance, so nothing is projected.
  result.addressMap.set({
    predicted: TARGET,
    actual: TARGET_ACTUAL,
    creator: WALLET.address,
    sender: WALLET.address,
    sourceTransaction: SOURCE_TX,
  });
  const response = await result.handlers.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getCode',
    params: [TARGET, 'latest'],
  });
  assert.equal(response.result, runtimeCode);
});

// (a) Regression for the release blocker: two deployments of the SAME artifact (one provenance hash)
// with DIFFERENT controllers/actuals. Before the deployment-scoped descriptor index, the second
// deployment's snapshot write threw 'Artifact snapshot conflict' (deployment-specific role values were
// stored on the artifact-keyed snapshot). Now the artifact snapshot is shared byte-identical (offsets
// only) while each deployment owns its own descriptor record, and each eth_getCode read projects its
// OWN controller into the predicted world.
for (const kind of ['transparent-proxy', 'beacon-proxy', 'contract'] as const) {
  test(`two deployments of the same ${kind} artifact keep independent descriptors and project their own controller`, async (t: TestContext) => {
    const provenanceHash = `0x${'7a'.repeat(32)}`;
    const identity = kind === 'contract' ? ARTIFACT_IDENTITY : PROXY_IDENTITY;
    const role = kind === 'transparent-proxy' ? 'admin' : kind === 'beacon-proxy' ? 'beacon' : 'self';
    // Deployment A and B: distinct predicted/actual, and (for a proxy) distinct controllers.
    const A = { predicted: `0x${'a1'.repeat(20)}`, actual: `0x${'a2'.repeat(20)}`, ctrlActual: `0x${'a3'.repeat(20)}`, ctrlPredicted: `0x${'a4'.repeat(20)}` };
    const B = { predicted: `0x${'b1'.repeat(20)}`, actual: `0x${'b2'.repeat(20)}`, ctrlActual: `0x${'b3'.repeat(20)}`, ctrlPredicted: `0x${'b4'.repeat(20)}` };
    // For a UUPS impl the role is `self`: the embedded value is the deployment's OWN actual and it
    // projects to its OWN predicted; a proxy embeds its controller's actual and projects to the
    // controller's predicted.
    const embeddedActual = (d: typeof A) => (role === 'self' ? d.actual : d.ctrlActual);
    const projectedTo = (d: typeof A) => (role === 'self' ? d.predicted : d.ctrlPredicted);
    const code: Record<string, string> = {
      [A.actual]: proxyRuntimeCode(embeddedActual(A)),
      [B.actual]: proxyRuntimeCode(embeddedActual(B)),
    };
    const result = fixture(t, {
      resolveCallContext: async () => undefined,
      upstream: {
        async request(method: JsonAny, params: JsonAny) {
          if (method === 'eth_getCode') return code[params[0]] ?? '0x';
          return `${method}:result`;
        },
      },
    });
    const seed = (d: typeof A) => {
      result.addressMap.set({ predicted: d.predicted, actual: d.actual, creator: WALLET.address, sender: WALLET.address, sourceTransaction: keccak256(toUtf8Bytes(`m:${d.predicted}`)) });
      if (role !== 'self') {
        result.addressMap.set({ predicted: d.ctrlPredicted, actual: d.ctrlActual, creator: WALLET.address, sender: WALLET.address, sourceTransaction: keccak256(toUtf8Bytes(`c:${d.ctrlActual}`)) });
      }
      result.addressMap.setContractMetadata({ predicted: d.predicted, contractKind: kind, artifactIdentity: identity, sourceTransaction: keccak256(toUtf8Bytes(`m:${d.predicted}`)), provenanceHash });
      const expectedActual = role === 'self' ? d.actual : d.ctrlActual;
      return { snapshot: result.addressMap.setArtifactSnapshot({ provenanceHash, artifactIdentity: identity, contractKind: kind, abi: [], creationBytecodeHash: `0x${'88'.repeat(32)}`, runtimeBytecodeHash: `0x${'99'.repeat(32)}`, immutableReferences: [{ start: 2, length: 32 }] }), expectedActual };
    };
    const seedA = seed(A);
    // The second deployment's snapshot write is byte-identical and must NOT throw (the old blocker).
    const seedB = seed(B);
    assert.deepEqual(seedA.snapshot, seedB.snapshot);
    result.addressMap.setDeploymentDescriptor({ predicted: A.predicted, status: 'complete', descriptors: [{ role, start: 2, length: 32, expectedActual: seedA.expectedActual }] });
    result.addressMap.setDeploymentDescriptor({ predicted: B.predicted, status: 'complete', descriptors: [{ role, start: 2, length: 32, expectedActual: seedB.expectedActual }] });

    // Two distinct descriptor records, keyed by predicted, each committing to its own controller.
    assert.notDeepEqual(
      result.addressMap.resolveDeploymentDescriptor(A.predicted),
      result.addressMap.resolveDeploymentDescriptor(B.predicted),
    );

    for (const d of [A, B]) {
      const response = await result.handlers.handle({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [d.predicted, 'latest'] });
      assert.equal(response.error, undefined, `${kind} ${d.predicted}`);
      assert.equal(response.result, proxyRuntimeCode(projectedTo(d)), `${kind} ${d.predicted}`);
    }
  });
}

// (d) A legacy/pending deployment (a snapshot carrying the artifact-scoped offsets but NO descriptor
// record) is enriched ephemerally at eth_getCode from the served runtime code and projected, without
// any durable write. This is the read-path self-heal that lets a proxy project before repair runs.
test('ephemerally enriches and projects a mapped proxy that has no descriptor record yet', async (t: TestContext) => {
  const result = fixture(t, {
    resolveCallContext: async () => undefined,
    upstream: {
      async request(method: JsonAny) {
        if (method === 'eth_getCode') return proxyRuntimeCode(IMMUTABLE_ADMIN_ACTUAL);
        return `${method}:result`;
      },
    },
  });
  // Snapshot offsets present, controller mapped, but no deployment-descriptor record written.
  seedProxyWithImmutable(result, { descriptorRecord: false });
  assert.equal(result.addressMap.resolveDeploymentDescriptor(TARGET), undefined);

  const response = await result.handlers.handle({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [TARGET, 'latest'] });
  assert.equal(response.error, undefined);
  assert.equal(response.result, proxyRuntimeCode(IMMUTABLE_ADMIN_PREDICTED));
  // The read path never persists: the record is still absent after the ephemeral enrichment.
  assert.equal(result.addressMap.resolveDeploymentDescriptor(TARGET), undefined);
});

test('projects a mapped proxy code after the numbered-block stock TRE quantity retry', async (t: TestContext) => {
  const attempts: JsonAny[] = [];
  const result = fixture(t, {
    resolveCallContext: async () => undefined,
    upstream: {
      async request(method: JsonAny, params: JsonAny) {
        attempts.push({ method, block: params.at(-1) });
        if (method === 'eth_getCode' && params.at(-1) === '0x13') {
          throw new UpstreamRpcError(-32602, 'QUANTITY not supported, just support TAG as latest');
        }
        if (method === 'eth_getCode') return proxyRuntimeCode(IMMUTABLE_ADMIN_ACTUAL);
        return `${method}:result`;
      },
    },
  });
  seedProxyWithImmutable(result);

  const response = await result.handlers.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getCode',
    params: [TARGET, '0x13'],
  });
  // The stock-quantity retry still fires before projection, and the retried code is then projected.
  assert.deepEqual(
    attempts.map(a => [a.method, a.block]),
    [
      ['eth_getCode', '0x13'],
      ['eth_getCode', 'latest'],
    ],
  );
  assert.equal(response.result, proxyRuntimeCode(IMMUTABLE_ADMIN_PREDICTED));
});

test('retries numbered immutable reads as latest only after the explicit stock TRE quantity error', async (t: TestContext) => {
  const attempts: JsonAny[] = [];
  const result = fixture(t, {
    resolveCallContext: async () => undefined,
    upstream: {
      async request(method: JsonAny, params: JsonAny) {
        attempts.push({ method, params: structuredClone(params) });
        if (params.at(-1) === '0x13') {
          throw new UpstreamRpcError(-32602, 'QUANTITY not supported, just support TAG as latest');
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
    new UpstreamRpcError(-32602, 'different invalid params'),
    new UpstreamRpcError(-32000, 'QUANTITY not supported, just support TAG as latest'),
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

test('rejects opaque call bytes containing a known predicted ABI word when metadata is unavailable', async (t: TestContext) => {
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
  assert.equal(result.calls.filter((call: JsonAny) => call.type === 'upstream').length, 0);
});

test('resolves predicted and actual addresses to EVM, TRON hex, Base58, provenance, and durable metadata', async (t: TestContext) => {
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

test('resolves an internally-created ProxyAdmin ABI from durable metadata and verified artifacts', async (t: TestContext) => {
  let seenContext;
  const transparentIdentity = {
    sourceName: 'openzeppelin-tron-solidity/contracts/proxy/transparent/TransparentUpgradeableProxy.sol',
    contractName: 'TransparentUpgradeableProxy',
    fullyQualifiedName:
      'openzeppelin-tron-solidity/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy',
  };
  const result = fixture(t, {
    nonceBaseline: 15,
    useDefaultResolveCallContext: true,
    findArtifactPaths(outputDirectory: JsonAny, reference: JsonAny) {
      if (reference === transparentIdentity.fullyQualifiedName) {
        return [path.join(outputDirectory, 'TransparentUpgradeableProxy.sol', 'TransparentUpgradeableProxy.json')];
      }
      assert.equal(reference, 'openzeppelin-tron-solidity/contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin');
      return [path.join(outputDirectory, 'ProxyAdmin.sol', 'ProxyAdmin.json')];
    },
    verifyArtifactProvenance({ artifactPath }: JsonAny) {
      return artifactPath.includes('TransparentUpgradeableProxy')
        ? { abi: [], provenanceHash: `0x${'55'.repeat(32)}` }
        : { abi: ['function owner() view returns (address)'], provenanceHash: `0x${'66'.repeat(32)}` };
    },
    async rewriteCall(decoded: JsonAny, context: JsonAny) {
      seenContext = context;
      return { ...decoded, to: TARGET_ACTUAL };
    },
  });
  const sourceTransaction = await seedConfirmedDeployment(result, { identity: transparentIdentity });
  result.addressMap.set({
    predicted: TARGET,
    actual: TARGET_ACTUAL,
    creator: WALLET.address,
    sender: WALLET.address,
    sourceTransaction,
  });
  const proxyAdminIdentity = {
    sourceName: 'openzeppelin-tron-solidity/contracts/proxy/transparent/ProxyAdmin.sol',
    contractName: 'ProxyAdmin',
    fullyQualifiedName: 'openzeppelin-tron-solidity/contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin',
  };
  result.addressMap.setContractMetadata({
    predicted: TARGET,
    contractKind: 'proxy-admin',
    artifactIdentity: proxyAdminIdentity,
    sourceTransaction,
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

// A deployment persists its verified artifact envelope so a later same-FQN replacement on disk
// cannot orphan the original deployment's ABI.
test('persists an immutable artifact snapshot for a confirmed deployment', async (t: TestContext) => {
  const raw = await signedTransaction();
  const result = fixture(t, { nonceBaseline: 3 });
  assert.equal((await send(result.handlers, raw)).result, keccak256(raw));

  assert.deepEqual(result.addressMap.resolveArtifactSnapshot(`0x${'55'.repeat(32)}`), {
    provenanceHash: `0x${'55'.repeat(32)}`,
    artifactIdentity: ARTIFACT_IDENTITY,
    contractKind: 'contract',
    abi: [{ type: 'constructor', inputs: [] }],
    creationBytecodeHash: keccak256('0x6000'),
    runtimeBytecodeHash: keccak256('0x6001'),
    // A plain contract with no immutables carries an empty artifact-scoped offset list.
    immutableReferences: [],
  });
});

// A deployment whose artifact declares an address-width immutable binds its role descriptors from the
// deployment's ACTUAL on-chain runtime code, read once the transaction has confirmed (the artifact's
// deployedBytecode carries the word zeroed). Here a UUPS implementation's __self holds the deployment's
// own actual address, so a 'self' descriptor is captured; a plain contract deploy reads no code.
test('captures role-immutable descriptors from the confirmed on-chain code of a deployment', async (t: TestContext) => {
  const raw = await signedTransaction();
  const selfWord = `0x6080${'00'.repeat(12)}${ACTUAL_TARGET.slice(2)}6000`;
  let getCodeReads = 0;
  const result = fixture(t, {
    nonceBaseline: 3,
    matchDeploymentArtifact: () => ({
      abi: [{ type: 'constructor', inputs: [] }],
      artifact: {
        abi: [{ type: 'constructor', inputs: [] }],
        deployedBytecode: { object: selfWord, immutableReferences: { '1': [{ start: 2, length: 32 }] } },
      },
      creationBytecode: '0x6000',
      constructorData: '0x',
      ...ARTIFACT_IDENTITY,
      provenanceHash: `0x${'55'.repeat(32)}`,
      requiresLinking: false,
    }),
    upstream: {
      async request(method: JsonAny, params: JsonAny) {
        if (method === 'eth_getCode') {
          getCodeReads += 1;
          // Descriptor capture reads the raw actual address directly (no predicted->actual mapping).
          assert.equal(params[0], ACTUAL_TARGET);
          return selfWord;
        }
        return `${method}:result`;
      },
    },
  });
  // The reconciler maps the deployment's predicted->actual at confirm; seed that mapping (the fixture's
  // fake reconciler does not) so the per-deployment descriptor can be persisted keyed by predicted.
  const predicted = getCreateAddress({ from: WALLET.address, nonce: 3 }).toLowerCase();
  result.addressMap.set({
    predicted,
    actual: ACTUAL_TARGET,
    creator: WALLET.address,
    sender: WALLET.address,
    sourceTransaction: `0x${'1c'.repeat(32)}`,
  });
  assert.equal((await send(result.handlers, raw)).result, keccak256(raw));

  assert.equal(getCodeReads, 1);
  const snapshot = result.addressMap.resolveArtifactSnapshot(`0x${'55'.repeat(32)}`);
  // The artifact-scoped offsets live on the snapshot; the deployment-specific role values live in the
  // per-predicted descriptor index, captured complete from the confirmed on-chain code.
  assert.deepEqual(snapshot?.immutableReferences, [{ start: 2, length: 32 }]);
  assert.deepEqual(result.addressMap.resolveDeploymentDescriptor(predicted), {
    predicted,
    status: 'complete',
    descriptors: [{ role: 'self', start: 2, length: 32, expectedActual: ACTUAL_TARGET }],
  });
});

// The prepared-native journal record and the artifact snapshot are written in two separate store
// transactions, so a crash between them leaves a prepared deployment with no snapshot. Recovery
// reconstructs the missing snapshot from the on-disk artifact when its fresh provenance still matches.
function seedPreparedWithoutSnapshot(
  result: JsonAny,
  raw: JsonAny,
  provenanceHash: JsonAny,
  {
    identity = ARTIFACT_IDENTITY,
    actualTarget = ACTUAL_TARGET,
    contractKind = 'contract',
  }: JsonAny = {},
) {
  const sourceHash = keccak256(raw);
  const nonce = Transaction.from(raw).nonce;
  result.journal.receive(raw);
  result.journal.recordNativeBuilt(
    sourceHash,
    { signedNativeTransaction: NATIVE_BYTES, nativeTransactionId: NATIVE_TXID },
    {
      operationContext: {
        kind: 'deployment',
        from: WALLET.address,
        to: null,
        nonce: String(nonce),
        predictedContractAddress: getCreateAddress({ from: WALLET.address, nonce }),
        actualTarget,
        contractKind,
        artifactIdentity: identity,
        provenanceHash,
      },
      childCreatePlan: {
        version: 1,
        mode: 'exact-signed',
        sender: WALLET.address,
        simulationRootAddress: actualTarget,
        attempts: [],
        counterBases: {},
        counterFinals: {},
      },
    },
  );
  return sourceHash;
}

function diskArtifact(provenanceHash: JsonAny) {
  return {
    artifact: {
      abi: [{ type: 'constructor', inputs: [] }],
      bytecode: { object: '0x6000' },
      deployedBytecode: { object: '0x6001' },
    },
    artifactPath: '/out/Box.sol/Box.json',
    sourceName: ARTIFACT_IDENTITY.sourceName,
    contractName: ARTIFACT_IDENTITY.contractName,
    fullyQualifiedName: ARTIFACT_IDENTITY.fullyQualifiedName,
    provenanceHash,
  };
}

test('reconstructs a prepared deployment artifact snapshot lost to a crash when the on-disk artifact still matches', async (t: TestContext) => {
  const provenanceHash = `0x${'55'.repeat(32)}`;
  const raw = await signedTransaction({ to: null, nonce: 8, data: '0x6000' });
  const result = fixture(t, {
    ownerId: 'boot-new',
    allowRecovery: true,
    findArtifactPaths: () => ['/out/Box.sol/Box.json'],
    verifyArtifactProvenance: () => diskArtifact(provenanceHash),
  });
  const sourceHash = seedPreparedWithoutSnapshot(result, raw, provenanceHash);
  assert.equal(result.addressMap.resolveArtifactSnapshot(provenanceHash), undefined);

  const capability = await acquireStateLock(result.statePath);
  t.after(() => capability.release());
  await result.handlers.recoverStartup(capability);

  const snapshot = result.addressMap.resolveArtifactSnapshot(provenanceHash);
  assert.equal(snapshot?.provenanceHash, provenanceHash);
  assert.equal(snapshot?.artifactIdentity.fullyQualifiedName, ARTIFACT_IDENTITY.fullyQualifiedName);
  assert.deepEqual(snapshot?.abi, [{ type: 'constructor', inputs: [] }]);
  assert.equal(result.journal.get(sourceHash).state, 'confirmed');
});

test('leaves the crash-lost snapshot absent when the on-disk artifact provenance no longer matches', async (t: TestContext) => {
  const journaledHash = `0x${'55'.repeat(32)}`;
  const replacedHash = `0x${'66'.repeat(32)}`;
  const raw = await signedTransaction({ to: null, nonce: 8, data: '0x6000' });
  const result = fixture(t, {
    ownerId: 'boot-new',
    allowRecovery: true,
    findArtifactPaths: () => ['/out/Box.sol/Box.json'],
    verifyArtifactProvenance: () => diskArtifact(replacedHash),
  });
  const sourceHash = seedPreparedWithoutSnapshot(result, raw, journaledHash);

  const capability = await acquireStateLock(result.statePath);
  t.after(() => capability.release());
  await result.handlers.recoverStartup(capability);

  // Recovery proceeds and confirms the deployment, but the mismatched disk artifact is never bound as
  // this deployment's snapshot; a later resolution keeps the legacy no-snapshot failure behavior.
  assert.equal(result.journal.get(sourceHash).state, 'confirmed');
  assert.equal(result.addressMap.resolveArtifactSnapshot(journaledHash), undefined);
  assert.equal(result.addressMap.resolveArtifactSnapshot(replacedHash), undefined);
});

// Durability twin of the repair gate: when a LEGACY offset-less snapshot already exists, recovery must
// enrich it with the artifact's immutable offsets before (or as) it completes the descriptor. Without
// this, a completed zero-immutable proxy descriptor would resolve an offset-less snapshot on later
// reads, fall back to the on-disk artifact, and fail the proxy closed forever once that artifact is
// removed — and the complete+offset-less state is otherwise skipped by every subsequent recovery.
test('startup recovery enriches a legacy offset-less snapshot so a completed descriptor stays durable', async (t: TestContext) => {
  const provenanceHash = `0x${'57'.repeat(32)}`;
  const raw = await signedTransaction({ to: null, nonce: 8, data: '0x6000' });
  const result = fixture(t, {
    ownerId: 'boot-new',
    allowRecovery: true,
    findArtifactPaths: () => ['/out/Box.sol/Box.json'],
    verifyArtifactProvenance: () => diskArtifact(provenanceHash),
  });
  seedPreparedWithoutSnapshot(result, raw, provenanceHash, { contractKind: 'transparent-proxy' });
  // A legacy snapshot predating the offsets field is already present (no immutableReferences).
  result.addressMap.setArtifactSnapshot({
    provenanceHash,
    artifactIdentity: ARTIFACT_IDENTITY,
    contractKind: 'transparent-proxy',
    abi: [],
    creationBytecodeHash: `0x${'88'.repeat(32)}`,
    runtimeBytecodeHash: `0x${'99'.repeat(32)}`,
  });
  assert.equal(result.addressMap.resolveArtifactSnapshot(provenanceHash)?.immutableReferences, undefined);

  const capability = await acquireStateLock(result.statePath);
  t.after(() => capability.release());
  await result.handlers.recoverStartup(capability);

  // The disk artifact declares no immutables, so the enriched offsets are the empty list — defined, so
  // a later read resolves them durably instead of depending on the on-disk artifact.
  assert.deepEqual(result.addressMap.resolveArtifactSnapshot(provenanceHash)?.immutableReferences, []);
});

const IMMUTABLE_IDENTITY = {
  sourceName: 'contracts/Impl.sol',
  contractName: 'Impl',
  fullyQualifiedName: 'contracts/Impl.sol:Impl',
};

// An address-width immutable is bound after confirmation by reading the deployment's ACTUAL on-chain
// runtime code. That post-confirmation read can transiently fail or return not-yet-populated '0x' code
// (read-your-writes / node lag). Capture must never let that failure escape a CONFIRMED deployment's
// recovery: recovery of this and every subsequent pending record must complete, and the base envelope
// (ABI, provenance, bytecode hashes) must still persist so ABI-orphan protection is never lost. The
// role descriptors are simply absent (an empty list), which fails a later proxy read closed exactly as
// a missing snapshot would.
test('startup recovery survives a transient descriptor-capture failure and still recovers later records', async (t: TestContext) => {
  const failingProvenance = `0x${'55'.repeat(32)}`;
  const plainProvenance = `0x${'66'.repeat(32)}`;
  const failingActual = `0x${'aa'.repeat(20)}`;
  const plainActual = `0x${'bb'.repeat(20)}`;
  let getCodeReads = 0;
  const result = fixture(t, {
    ownerId: 'boot-new',
    allowRecovery: true,
    delay: async () => {},
    findArtifactPaths: (_out: JsonAny, fqn: JsonAny) => [`/out/${fqn}.json`],
    verifyArtifactProvenance: ({ artifactPath }: JsonAny) =>
      artifactPath === `/out/${IMMUTABLE_IDENTITY.fullyQualifiedName}.json`
        ? {
            artifact: {
              abi: [{ type: 'constructor', inputs: [] }],
              bytecode: { object: '0x6000' },
              deployedBytecode: { object: '0x6001', immutableReferences: { '1': [{ start: 2, length: 32 }] } },
            },
            artifactPath,
            ...IMMUTABLE_IDENTITY,
            provenanceHash: failingProvenance,
          }
        : {
            artifact: {
              abi: [{ type: 'constructor', inputs: [] }],
              bytecode: { object: '0x6000' },
              deployedBytecode: { object: '0x6001' },
            },
            artifactPath,
            ...ARTIFACT_IDENTITY,
            provenanceHash: plainProvenance,
          },
    upstream: {
      async request(method: JsonAny) {
        if (method === 'eth_getCode') {
          getCodeReads += 1;
          throw new Error('upstream getCode transiently unavailable');
        }
        return `${method}:result`;
      },
    },
  });

  const failingRaw = await signedTransaction({ to: null, nonce: 8, data: '0x6000' });
  const plainRaw = await signedTransaction({ to: null, nonce: 9, data: '0x6000' });
  const failingHash = seedPreparedWithoutSnapshot(result, failingRaw, failingProvenance, {
    identity: IMMUTABLE_IDENTITY,
    actualTarget: failingActual,
  });
  const plainHash = seedPreparedWithoutSnapshot(result, plainRaw, plainProvenance, { actualTarget: plainActual });

  const capability = await acquireStateLock(result.statePath);
  t.after(() => capability.release());
  const recovered = await result.handlers.recoverStartup(capability);

  // The transient capture failure of the lower-nonce record neither threw out of recovery nor aborted
  // recovery of the later record; both confirmed.
  assert.deepEqual(recovered, [failingHash, plainHash]);
  assert.equal(result.journal.get(failingHash).state, 'confirmed');
  assert.equal(result.journal.get(plainHash).state, 'confirmed');
  // The address-immutable record retried the read the bounded number of times, then persisted its base
  // envelope with an empty descriptor list rather than throwing.
  assert.equal(getCodeReads, 3);
  const failingSnapshot = result.addressMap.resolveArtifactSnapshot(failingProvenance);
  assert.equal(failingSnapshot?.provenanceHash, failingProvenance);
  assert.deepEqual(failingSnapshot?.abi, [{ type: 'constructor', inputs: [] }]);
  // The base snapshot persists the artifact-scoped offsets even though the post-confirmation code read
  // failed; the descriptor capture is left pending, to be completed later by recovery or repair.
  assert.deepEqual(failingSnapshot?.immutableReferences, [{ start: 2, length: 32 }]);
  // The later plain record read no code and snapshotted normally.
  const plainSnapshot = result.addressMap.resolveArtifactSnapshot(plainProvenance);
  assert.deepEqual(plainSnapshot?.abi, [{ type: 'constructor', inputs: [] }]);
});

// A live re-send that resumes a prepared address-immutable deployment through resumePrepared confirms
// the transaction, so a subsequent transient capture failure must not throw back to the caller: the
// deployment is already confirmed (the confirmed short-circuit would then block any retry), so the base
// snapshot must still persist here rather than being lost forever.
test('a re-sent prepared deployment confirms and persists its base snapshot despite a transient capture failure', async (t: TestContext) => {
  const provenanceHash = `0x${'55'.repeat(32)}`;
  const raw = await signedTransaction({ to: null, nonce: 8, data: '0x6000' });
  let getCodeReads = 0;
  const result = fixture(t, {
    delay: async () => {},
    findArtifactPaths: () => [`/out/${IMMUTABLE_IDENTITY.fullyQualifiedName}.json`],
    verifyArtifactProvenance: () => ({
      artifact: {
        abi: [{ type: 'constructor', inputs: [] }],
        bytecode: { object: '0x6000' },
        deployedBytecode: { object: '0x6001', immutableReferences: { '1': [{ start: 2, length: 32 }] } },
      },
      artifactPath: `/out/${IMMUTABLE_IDENTITY.fullyQualifiedName}.json`,
      ...IMMUTABLE_IDENTITY,
      provenanceHash,
    }),
    upstream: {
      async request(method: JsonAny) {
        if (method === 'eth_getCode') {
          getCodeReads += 1;
          throw new Error('upstream getCode transiently unavailable');
        }
        return `${method}:result`;
      },
    },
  });
  const sourceHash = seedPreparedWithoutSnapshot(result, raw, provenanceHash, { identity: IMMUTABLE_IDENTITY });

  const response = await send(result.handlers, raw);
  assert.equal(response.error, undefined);
  assert.equal(response.result, sourceHash);
  assert.equal(result.journal.get(sourceHash).state, 'confirmed');
  assert.equal(getCodeReads, 3);
  const snapshot = result.addressMap.resolveArtifactSnapshot(provenanceHash);
  assert.equal(snapshot?.provenanceHash, provenanceHash);
  assert.deepEqual(snapshot?.abi, [{ type: 'constructor', inputs: [] }]);
  assert.deepEqual(snapshot?.immutableReferences, [{ start: 2, length: 32 }]);
});

// A read that fails on the first attempt but succeeds on retry (absorbing node lag) still binds the
// role descriptor, and does so within the bounded attempt budget.
test('a deploy descriptor capture retries a transient read failure and binds the descriptor on success', async (t: TestContext) => {
  const raw = await signedTransaction();
  const selfWord = `0x6080${'00'.repeat(12)}${ACTUAL_TARGET.slice(2)}6000`;
  let getCodeReads = 0;
  const result = fixture(t, {
    nonceBaseline: 3,
    delay: async () => {},
    matchDeploymentArtifact: () => ({
      abi: [{ type: 'constructor', inputs: [] }],
      artifact: {
        abi: [{ type: 'constructor', inputs: [] }],
        deployedBytecode: { object: selfWord, immutableReferences: { '1': [{ start: 2, length: 32 }] } },
      },
      creationBytecode: '0x6000',
      constructorData: '0x',
      ...ARTIFACT_IDENTITY,
      provenanceHash: `0x${'55'.repeat(32)}`,
      requiresLinking: false,
    }),
    upstream: {
      async request(method: JsonAny, params: JsonAny) {
        if (method === 'eth_getCode') {
          getCodeReads += 1;
          if (getCodeReads === 1) throw new Error('transient read-your-writes lag');
          assert.equal(params[0], ACTUAL_TARGET);
          return selfWord;
        }
        return `${method}:result`;
      },
    },
  });
  const predicted = getCreateAddress({ from: WALLET.address, nonce: 3 }).toLowerCase();
  result.addressMap.set({
    predicted,
    actual: ACTUAL_TARGET,
    creator: WALLET.address,
    sender: WALLET.address,
    sourceTransaction: `0x${'2c'.repeat(32)}`,
  });
  assert.equal((await send(result.handlers, raw)).result, keccak256(raw));
  assert.equal(getCodeReads, 2);
  const snapshot = result.addressMap.resolveArtifactSnapshot(`0x${'55'.repeat(32)}`);
  assert.deepEqual(snapshot?.immutableReferences, [{ start: 2, length: 32 }]);
  assert.deepEqual(result.addressMap.resolveDeploymentDescriptor(predicted), {
    predicted,
    status: 'complete',
    descriptors: [{ role: 'self', start: 2, length: 32, expectedActual: ACTUAL_TARGET }],
  });
});

// A deploy whose post-confirmation code read never populates ('0x' on every attempt) still persists the
// base envelope (with offsets) and marks its descriptor capture PENDING, rather than dropping the
// snapshot on a confirmed deployment. The pending record is completed later by recovery or repair.
test('a deploy persists its base snapshot and a pending descriptor when the capture read persistently fails', async (t: TestContext) => {
  const raw = await signedTransaction();
  const selfWord = `0x6080${'00'.repeat(12)}${ACTUAL_TARGET.slice(2)}6000`;
  let getCodeReads = 0;
  const result = fixture(t, {
    nonceBaseline: 3,
    delay: async () => {},
    matchDeploymentArtifact: () => ({
      abi: [{ type: 'constructor', inputs: [] }],
      artifact: {
        abi: [{ type: 'constructor', inputs: [] }],
        deployedBytecode: { object: selfWord, immutableReferences: { '1': [{ start: 2, length: 32 }] } },
      },
      creationBytecode: '0x6000',
      constructorData: '0x',
      ...ARTIFACT_IDENTITY,
      provenanceHash: `0x${'55'.repeat(32)}`,
      requiresLinking: false,
    }),
    upstream: {
      async request(method: JsonAny) {
        if (method === 'eth_getCode') {
          getCodeReads += 1;
          return '0x';
        }
        return `${method}:result`;
      },
    },
  });
  const predicted = getCreateAddress({ from: WALLET.address, nonce: 3 }).toLowerCase();
  result.addressMap.set({
    predicted,
    actual: ACTUAL_TARGET,
    creator: WALLET.address,
    sender: WALLET.address,
    sourceTransaction: `0x${'3c'.repeat(32)}`,
  });
  assert.equal((await send(result.handlers, raw)).result, keccak256(raw));
  assert.equal(getCodeReads, 3);
  const snapshot = result.addressMap.resolveArtifactSnapshot(`0x${'55'.repeat(32)}`);
  assert.equal(snapshot?.provenanceHash, `0x${'55'.repeat(32)}`);
  assert.deepEqual(snapshot?.abi, [{ type: 'constructor', inputs: [] }]);
  assert.deepEqual(snapshot?.immutableReferences, [{ start: 2, length: 32 }]);
  assert.deepEqual(result.addressMap.resolveDeploymentDescriptor(predicted), {
    predicted,
    status: 'pending',
    descriptors: [],
  });
});

// A deployment whose runtime bytecode still carries unresolved external-library link placeholders
// (__$...$__) — a shape artifact provenance explicitly permits — snapshots successfully by hashing
// the raw runtime template rather than demanding fully linked pure hex.
test('snapshots a linked-library deployment whose runtime bytecode carries link placeholders', async (t: TestContext) => {
  const raw = await signedTransaction();
  const linkedRuntime = `0x6001__$${'a'.repeat(34)}$__6002`;
  const result = fixture(t, {
    nonceBaseline: 3,
    matchDeploymentArtifact: () => ({
      abi: [{ type: 'constructor', inputs: [] }],
      artifact: { abi: [{ type: 'constructor', inputs: [] }], deployedBytecode: { object: linkedRuntime } },
      creationBytecode: '0x6000',
      constructorData: '0x',
      ...ARTIFACT_IDENTITY,
      provenanceHash: `0x${'55'.repeat(32)}`,
      requiresLinking: true,
    }),
  });
  assert.equal((await send(result.handlers, raw)).result, keccak256(raw));

  assert.deepEqual(result.addressMap.resolveArtifactSnapshot(`0x${'55'.repeat(32)}`), {
    provenanceHash: `0x${'55'.repeat(32)}`,
    artifactIdentity: ARTIFACT_IDENTITY,
    contractKind: 'contract',
    abi: [{ type: 'constructor', inputs: [] }],
    creationBytecodeHash: keccak256('0x6000'),
    runtimeBytecodeHash: keccak256(toUtf8Bytes(linkedRuntime.toLowerCase())),
    immutableReferences: [],
  });
});

// Scenario (1): a same-FQN artifact replaced in place after deployment (fresh disk provenance no
// longer matches) still resolves for call interpretation through the immutable snapshot.
test('resolves a same-FQN contract via its snapshot after the on-disk artifact provenance changes', async (t: TestContext) => {
  const pingData = new Interface(['function ping()']).encodeFunctionData('ping', []);
  const result = fixture(t, {
    nonceBaseline: 16,
    useDefaultResolveCallContext: true,
    rewriteCall: realRewriteCall,
    findArtifactPaths(outputDirectory: JsonAny, reference: JsonAny) {
      assert.equal(reference, ARTIFACT_IDENTITY.fullyQualifiedName);
      return [path.join(outputDirectory, 'Box.sol', 'Box.json')];
    },
    verifyArtifactProvenance() {
      return { abi: ['function ping()'], provenanceHash: `0x${'66'.repeat(32)}` };
    },
  });
  const sourceTransaction = await seedConfirmedDeployment(result);
  result.addressMap.set({
    predicted: TARGET,
    actual: TARGET_ACTUAL,
    creator: WALLET.address,
    sender: WALLET.address,
    sourceTransaction,
  });
  result.addressMap.setContractMetadata({
    predicted: TARGET,
    contractKind: 'contract',
    artifactIdentity: ARTIFACT_IDENTITY,
    sourceTransaction,
  });
  result.addressMap.setArtifactSnapshot({
    provenanceHash: `0x${'55'.repeat(32)}`,
    artifactIdentity: ARTIFACT_IDENTITY,
    contractKind: 'contract',
    abi: ['function ping()'],
    creationBytecodeHash: keccak256('0x6000'),
    runtimeBytecodeHash: keccak256('0x6001'),
  });

  const raw = await signedTransaction({ to: TARGET, nonce: 16, data: pingData });
  assert.equal((await send(result.handlers, raw)).result, keccak256(raw));
  const built = result.calls.find((call: JsonAny) => call.type === 'buildCall');
  assert.equal(built.value.contractAddress, TARGET_ACTUAL);
  assert.equal(built.value.data, pingData);
});

// Scenario (5), legacy: a deployment journaled before snapshots exist (no snapshot for its
// provenance) keeps the byte-identical ARTIFACT_PROVENANCE_CHANGED failure.
test('preserves ARTIFACT_PROVENANCE_CHANGED when a changed artifact has no snapshot fallback', async (t: TestContext) => {
  const result = fixture(t, {
    nonceBaseline: 16,
    useDefaultResolveCallContext: true,
    findArtifactPaths(outputDirectory: JsonAny, reference: JsonAny) {
      assert.equal(reference, ARTIFACT_IDENTITY.fullyQualifiedName);
      return [path.join(outputDirectory, 'Box.sol', 'Box.json')];
    },
    verifyArtifactProvenance() {
      return { abi: ['function ping()'], provenanceHash: `0x${'66'.repeat(32)}` };
    },
  });
  const sourceTransaction = await seedConfirmedDeployment(result);
  result.addressMap.set({
    predicted: TARGET,
    actual: TARGET_ACTUAL,
    creator: WALLET.address,
    sender: WALLET.address,
    sourceTransaction,
  });
  result.addressMap.setContractMetadata({
    predicted: TARGET,
    contractKind: 'contract',
    artifactIdentity: ARTIFACT_IDENTITY,
    sourceTransaction,
  });

  const raw = await signedTransaction({ to: TARGET, nonce: 16, data: '0x5c36b186' });
  const response = await send(result.handlers, raw);
  assert.equal(response.error.code, -32000);
  assert.equal(response.error.data.code, 'ARTIFACT_PROVENANCE_CHANGED');
  assert.equal(
    result.calls.some((call: JsonAny) => call.type === 'buildCall' || call.type === 'broadcast'),
    false,
  );
});

const UUPS_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const BEACON_STORAGE_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const BEACON_IMPLEMENTATION_SELECTOR = '0x5c60da1b';

function slotWord(address: JsonAny) {
  return `0x${'00'.repeat(12)}${address.slice(2)}`;
}

// Scenario (2): the UUPS upgrade call itself — previously impossible once the implementation's
// on-disk artifact was replaced in place — now succeeds by resolving the implementation ABI from
// the immutable snapshot captured at the implementation's deployment.
test('rewrites a UUPS upgradeToAndCall through a proxy whose implementation artifact was replaced', async (t: TestContext) => {
  const proxyIdentity = {
    sourceName: 'openzeppelin-tron-solidity/contracts/proxy/TRC1967/TRC1967Proxy.sol',
    contractName: 'TRC1967Proxy',
    fullyQualifiedName: 'openzeppelin-tron-solidity/contracts/proxy/TRC1967/TRC1967Proxy.sol:TRC1967Proxy',
  };
  const proxyPredicted = `0x${'11'.repeat(20)}`;
  const proxyActual = `0x${'b1'.repeat(20)}`;
  const implPredicted = `0x${'22'.repeat(20)}`;
  const implActual = `0x${'b2'.repeat(20)}`;
  const newImplementation = `0x${'33'.repeat(20)}`;
  const proxyProvenance = `0x${'55'.repeat(32)}`;
  const implProvenance = `0x${'aa'.repeat(32)}`;
  const implAbi = ['function upgradeToAndCall(address newImplementation, bytes data)', 'function value() view returns (uint256)'];

  const result = fixture(t, {
    useDefaultResolveCallContext: true,
    rewriteCall: realRewriteCall,
    findArtifactPaths(outputDirectory: JsonAny, reference: JsonAny) {
      return reference === proxyIdentity.fullyQualifiedName
        ? [path.join(outputDirectory, 'TRC1967Proxy.sol', 'TRC1967Proxy.json')]
        : [path.join(outputDirectory, 'Box.sol', 'Box.json')];
    },
    verifyArtifactProvenance({ artifactPath }: JsonAny) {
      // The implementation's disk artifact was replaced in place: its fresh provenance no longer
      // matches what was recorded at deployment, forcing the snapshot fallback.
      return artifactPath.includes('TRC1967Proxy')
        ? { abi: [], provenanceHash: proxyProvenance }
        : { abi: implAbi, provenanceHash: `0x${'ee'.repeat(32)}` };
    },
    upstream: {
      async request(method: JsonAny, params: JsonAny) {
        if (method === 'eth_getStorageAt' && params[1] === UUPS_IMPLEMENTATION_SLOT) return slotWord(implActual);
        return `${method}:result`;
      },
    },
  });

  const proxySource = await seedConfirmedDeployment(result, {
    identity: proxyIdentity,
    provenanceHash: proxyProvenance,
    predicted: proxyPredicted,
    actual: proxyActual,
    nonce: 20,
  });
  const implSource = await seedConfirmedDeployment(result, {
    identity: ARTIFACT_IDENTITY,
    provenanceHash: implProvenance,
    predicted: implPredicted,
    actual: implActual,
    nonce: 21,
  });
  for (const [predicted, actual, sourceTransaction] of [
    [proxyPredicted, proxyActual, proxySource],
    [implPredicted, implActual, implSource],
  ] as JsonAny[]) {
    result.addressMap.set({ predicted, actual, creator: WALLET.address, sender: WALLET.address, sourceTransaction });
  }
  result.addressMap.setContractMetadata({
    predicted: proxyPredicted,
    contractKind: 'uups-proxy',
    artifactIdentity: proxyIdentity,
    sourceTransaction: proxySource,
  });
  result.addressMap.setContractMetadata({
    predicted: implPredicted,
    contractKind: 'contract',
    artifactIdentity: ARTIFACT_IDENTITY,
    sourceTransaction: implSource,
  });
  result.addressMap.setArtifactSnapshot({
    provenanceHash: implProvenance,
    artifactIdentity: ARTIFACT_IDENTITY,
    contractKind: 'contract',
    abi: implAbi,
    creationBytecodeHash: keccak256('0x6000'),
    runtimeBytecodeHash: keccak256('0x6001'),
  });

  const upgradeData = new Interface([
    'function upgradeToAndCall(address newImplementation, bytes data)',
  ]).encodeFunctionData('upgradeToAndCall', [newImplementation, '0x']);
  const raw = await signedTransaction({ to: proxyPredicted, nonce: 22, data: upgradeData });
  assert.equal((await send(result.handlers, raw)).result, keccak256(raw));
  const built = result.calls.find((call: JsonAny) => call.type === 'buildCall');
  assert.equal(built.value.contractAddress, proxyActual);
  assert.equal(built.value.data, upgradeData);
});

// Scenario (3): transparent-proxy and beacon-proxy equivalents of the snapshot fallback — a normal
// call through the proxy resolves the replaced implementation's ABI from the snapshot.
for (const kind of ['transparent-proxy', 'beacon-proxy'] as const) {
  test(`resolves a ${kind} implementation ABI via snapshot after the implementation artifact changes`, async (t: TestContext) => {
    const proxyIdentity =
      kind === 'transparent-proxy'
        ? {
            sourceName: 'openzeppelin-tron-solidity/contracts/proxy/transparent/TransparentUpgradeableProxy.sol',
            contractName: 'TransparentUpgradeableProxy',
            fullyQualifiedName:
              'openzeppelin-tron-solidity/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy',
          }
        : {
            sourceName: 'openzeppelin-tron-solidity/contracts/proxy/beacon/BeaconProxy.sol',
            contractName: 'BeaconProxy',
            fullyQualifiedName: 'openzeppelin-tron-solidity/contracts/proxy/beacon/BeaconProxy.sol:BeaconProxy',
          };
    const proxyPredicted = `0x${'11'.repeat(20)}`;
    const proxyActual = `0x${'b1'.repeat(20)}`;
    const beaconActual = `0x${'bc'.repeat(20)}`;
    const implPredicted = `0x${'22'.repeat(20)}`;
    const implActual = `0x${'b2'.repeat(20)}`;
    const proxyProvenance = `0x${'55'.repeat(32)}`;
    const implProvenance = `0x${'aa'.repeat(32)}`;
    const implAbi = ['function value() view returns (uint256)'];
    const callData = new Interface(implAbi).encodeFunctionData('value', []);
    const upstreamCalls: JsonAny[] = [];

    const result = fixture(t, {
      useDefaultResolveCallContext: true,
      rewriteCall: realRewriteCall,
      findArtifactPaths(outputDirectory: JsonAny, reference: JsonAny) {
        return reference === proxyIdentity.fullyQualifiedName
          ? [path.join(outputDirectory, 'Proxy.sol', 'Proxy.json')]
          : [path.join(outputDirectory, 'Box.sol', 'Box.json')];
      },
      verifyArtifactProvenance({ artifactPath }: JsonAny) {
        return artifactPath.includes('Proxy')
          ? { abi: [], provenanceHash: proxyProvenance }
          : { abi: implAbi, provenanceHash: `0x${'ee'.repeat(32)}` };
      },
      upstream: {
        async request(method: JsonAny, params: JsonAny) {
          upstreamCalls.push({ method, params });
          if (method === 'eth_getStorageAt' && params[1] === UUPS_IMPLEMENTATION_SLOT) return slotWord(implActual);
          if (method === 'eth_getStorageAt' && params[1] === BEACON_STORAGE_SLOT) return slotWord(beaconActual);
          if (method === 'eth_call' && params[0]?.data === BEACON_IMPLEMENTATION_SELECTOR) return slotWord(implActual);
          return `${method}:result`;
        },
      },
    });

    const proxySource = await seedConfirmedDeployment(result, {
      identity: proxyIdentity,
      provenanceHash: proxyProvenance,
      predicted: proxyPredicted,
      actual: proxyActual,
      nonce: 20,
    });
    const implSource = await seedConfirmedDeployment(result, {
      identity: ARTIFACT_IDENTITY,
      provenanceHash: implProvenance,
      predicted: implPredicted,
      actual: implActual,
      nonce: 21,
    });
    for (const [predicted, actual, sourceTransaction] of [
      [proxyPredicted, proxyActual, proxySource],
      [implPredicted, implActual, implSource],
    ] as JsonAny[]) {
      result.addressMap.set({ predicted, actual, creator: WALLET.address, sender: WALLET.address, sourceTransaction });
    }
    result.addressMap.setContractMetadata({
      predicted: proxyPredicted,
      contractKind: kind,
      artifactIdentity: proxyIdentity,
      sourceTransaction: proxySource,
    });
    result.addressMap.setContractMetadata({
      predicted: implPredicted,
      contractKind: 'contract',
      artifactIdentity: ARTIFACT_IDENTITY,
      sourceTransaction: implSource,
    });
    result.addressMap.setArtifactSnapshot({
      provenanceHash: implProvenance,
      artifactIdentity: ARTIFACT_IDENTITY,
      contractKind: 'contract',
      abi: implAbi,
      creationBytecodeHash: keccak256('0x6000'),
      runtimeBytecodeHash: keccak256('0x6001'),
    });

    const response = await result.handlers.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: proxyPredicted, data: callData }, 'latest'],
    });
    assert.equal(response.result, 'eth_call:result');
    const forwarded = upstreamCalls.filter(
      (call: JsonAny) => call.method === 'eth_call' && call.params[0]?.data !== BEACON_IMPLEMENTATION_SELECTOR,
    );
    assert.equal(forwarded.at(-1).params[0].to, proxyActual);
    assert.equal(forwarded.at(-1).params[0].data, callData);
  });
}

const ADMIN_STORAGE_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const UUPS_UPGRADE_ABI = ['function upgradeToAndCall(address newImplementation, bytes data)'];
const PROXY_ADMIN_UPGRADE_ABI = ['function upgradeAndCall(address proxy, address implementation, bytes data)'];
const BEACON_UPGRADE_ABI = ['function upgradeTo(address newImplementation)'];

// Register a gateway-deployed implementation with a confirmed predicted->actual mapping and an
// immutable artifact snapshot, so its provenance resolves as intact through the normal machinery.
async function seedGatewayImplementation(
  result: JsonAny,
  { predicted, actual, provenance, nonce, abi }: JsonAny,
) {
  const source = await seedConfirmedDeployment(result, {
    identity: ARTIFACT_IDENTITY,
    provenanceHash: provenance,
    predicted,
    actual,
    nonce,
  });
  result.addressMap.set({ predicted, actual, creator: WALLET.address, sender: WALLET.address, sourceTransaction: source });
  result.addressMap.setArtifactSnapshot({
    provenanceHash: provenance,
    artifactIdentity: ARTIFACT_IDENTITY,
    contractKind: 'contract',
    abi,
    creationBytecodeHash: keccak256('0x6000'),
    runtimeBytecodeHash: keccak256('0x6001'),
  });
  return source;
}

// A UUPS upgradeToAndCall against an externally-deployed proxy (no gateway metadata) that embeds a
// gateway predicted implementation is rewritten to the actual implementation once the proxy's live
// TRC-1967 implementation slot proves the topology.
test('rewrites an external UUPS upgradeToAndCall implementation argument to its actual address', async (t: TestContext) => {
  const proxyExternal = `0x${'c1'.repeat(20)}`;
  const implPredicted = `0x${'22'.repeat(20)}`;
  const implActual = `0x${'b2'.repeat(20)}`;
  const result = fixture(t, {
    resolveCallContext: async () => undefined,
    upstream: {
      async request(method: JsonAny, params: JsonAny) {
        if (method === 'eth_getStorageAt' && params[0] === proxyExternal && params[1] === UUPS_IMPLEMENTATION_SLOT) {
          return slotWord(`0x${'e1'.repeat(20)}`);
        }
        return `${method}:result`;
      },
    },
  });
  await seedGatewayImplementation(result, {
    predicted: implPredicted,
    actual: implActual,
    provenance: `0x${'aa'.repeat(32)}`,
    nonce: 21,
    abi: ['function value() view returns (uint256)'],
  });
  const upgradeData = new Interface(UUPS_UPGRADE_ABI).encodeFunctionData('upgradeToAndCall', [implPredicted, '0x']);
  const raw = await signedTransaction({ to: proxyExternal, nonce: 22, data: upgradeData });
  assert.equal((await send(result.handlers, raw)).result, keccak256(raw));
  const built = result.calls.find((call: JsonAny) => call.type === 'buildCall');
  assert.equal(built.value.contractAddress, proxyExternal);
  assert.equal(
    built.value.data,
    new Interface(UUPS_UPGRADE_ABI).encodeFunctionData('upgradeToAndCall', [implActual, '0x']),
  );
});

// A ProxyAdmin upgradeAndCall against an externally-deployed ProxyAdmin is rewritten once the proxy
// argument's live TRC-1967 admin slot proves the target is that proxy's admin.
test('rewrites an external ProxyAdmin upgradeAndCall implementation argument to its actual address', async (t: TestContext) => {
  const adminExternal = `0x${'c1'.repeat(20)}`;
  const proxyExternal = `0x${'c2'.repeat(20)}`;
  const implPredicted = `0x${'22'.repeat(20)}`;
  const implActual = `0x${'b2'.repeat(20)}`;
  const result = fixture(t, {
    resolveCallContext: async () => undefined,
    upstream: {
      async request(method: JsonAny, params: JsonAny) {
        if (method === 'eth_getStorageAt' && params[0] === proxyExternal && params[1] === ADMIN_STORAGE_SLOT) {
          return slotWord(adminExternal);
        }
        return `${method}:result`;
      },
    },
  });
  await seedGatewayImplementation(result, {
    predicted: implPredicted,
    actual: implActual,
    provenance: `0x${'aa'.repeat(32)}`,
    nonce: 21,
    abi: ['function value() view returns (uint256)'],
  });
  const upgradeData = new Interface(PROXY_ADMIN_UPGRADE_ABI).encodeFunctionData('upgradeAndCall', [
    proxyExternal,
    implPredicted,
    '0x',
  ]);
  const raw = await signedTransaction({ to: adminExternal, nonce: 22, data: upgradeData });
  assert.equal((await send(result.handlers, raw)).result, keccak256(raw));
  const built = result.calls.find((call: JsonAny) => call.type === 'buildCall');
  assert.equal(built.value.contractAddress, adminExternal);
  assert.equal(
    built.value.data,
    new Interface(PROXY_ADMIN_UPGRADE_ABI).encodeFunctionData('upgradeAndCall', [proxyExternal, implActual, '0x']),
  );
});

// A beacon upgradeTo against an externally-deployed UpgradeableBeacon is rewritten once the beacon's
// live implementation() view proves the topology.
test('rewrites an external beacon upgradeTo implementation argument to its actual address', async (t: TestContext) => {
  const beaconExternal = `0x${'c1'.repeat(20)}`;
  const implPredicted = `0x${'22'.repeat(20)}`;
  const implActual = `0x${'b2'.repeat(20)}`;
  const result = fixture(t, {
    resolveCallContext: async () => undefined,
    upstream: {
      async request(method: JsonAny, params: JsonAny) {
        if (method === 'eth_call' && params[0]?.to === beaconExternal && params[0]?.data === BEACON_IMPLEMENTATION_SELECTOR) {
          return slotWord(`0x${'e1'.repeat(20)}`);
        }
        return `${method}:result`;
      },
    },
  });
  await seedGatewayImplementation(result, {
    predicted: implPredicted,
    actual: implActual,
    provenance: `0x${'aa'.repeat(32)}`,
    nonce: 21,
    abi: ['function value() view returns (uint256)'],
  });
  const upgradeData = new Interface(BEACON_UPGRADE_ABI).encodeFunctionData('upgradeTo', [implPredicted]);
  const raw = await signedTransaction({ to: beaconExternal, nonce: 22, data: upgradeData });
  assert.equal((await send(result.handlers, raw)).result, keccak256(raw));
  const built = result.calls.find((call: JsonAny) => call.type === 'buildCall');
  assert.equal(built.value.contractAddress, beaconExternal);
  assert.equal(built.value.data, new Interface(BEACON_UPGRADE_ABI).encodeFunctionData('upgradeTo', [implActual]));
});

// Adversarial: the recognized selector plus a known predicted implementation, but the target's live
// topology does not match (no implementation slot) — the existing fail-closed rejection is unchanged.
test('rejects an external UUPS upgrade whose target has no implementation slot', async (t: TestContext) => {
  const proxyExternal = `0x${'c1'.repeat(20)}`;
  const implPredicted = `0x${'22'.repeat(20)}`;
  const implActual = `0x${'b2'.repeat(20)}`;
  const result = fixture(t, {
    resolveCallContext: async () => undefined,
    upstream: {
      async request(method: JsonAny, params: JsonAny) {
        if (method === 'eth_getStorageAt' && params[1] === UUPS_IMPLEMENTATION_SLOT) return `0x${'00'.repeat(32)}`;
        return `${method}:result`;
      },
    },
  });
  await seedGatewayImplementation(result, {
    predicted: implPredicted,
    actual: implActual,
    provenance: `0x${'aa'.repeat(32)}`,
    nonce: 21,
    abi: ['function value() view returns (uint256)'],
  });
  const upgradeData = new Interface(UUPS_UPGRADE_ABI).encodeFunctionData('upgradeToAndCall', [implPredicted, '0x']);
  const raw = await signedTransaction({ to: proxyExternal, nonce: 22, data: upgradeData });
  const response = await send(result.handlers, raw);
  assert.equal(response.error.data.code, 'OPAQUE_PREDICTED_ADDRESS');
  assert.equal(
    result.calls.some((call: JsonAny) => call.type === 'buildCall' || call.type === 'broadcast'),
    false,
  );
});

// Adversarial: the recognized selector but the embedded implementation is not a known predicted
// deployment, while a known predicted address rides along in the payload — rejected exactly as today,
// without ever probing the target's topology.
test('rejects an external upgrade selector whose embedded implementation is unknown', async (t: TestContext) => {
  const proxyExternal = `0x${'c1'.repeat(20)}`;
  const unknownImplementation = `0x${'d4'.repeat(20)}`;
  const upstreamCalls: JsonAny[] = [];
  const result = fixture(t, {
    nonceBaseline: 22,
    resolveCallContext: async () => undefined,
    upstream: {
      async request(method: JsonAny, params: JsonAny) {
        upstreamCalls.push({ method, params });
        return `${method}:result`;
      },
    },
  });
  result.addressMap.set({
    predicted: TARGET,
    actual: TARGET_ACTUAL,
    creator: WALLET.address,
    sender: WALLET.address,
    sourceTransaction: SOURCE_TX,
  });
  const upgradeData = new Interface(UUPS_UPGRADE_ABI).encodeFunctionData('upgradeToAndCall', [
    unknownImplementation,
    `0x${'00'.repeat(12)}${TARGET.slice(2)}`,
  ]);
  const raw = await signedTransaction({ to: proxyExternal, nonce: 22, data: upgradeData });
  const response = await send(result.handlers, raw);
  assert.equal(response.error.data.code, 'OPAQUE_PREDICTED_ADDRESS');
  assert.equal(
    upstreamCalls.some((call: JsonAny) => call.method === 'eth_getStorageAt' || call.method === 'eth_call'),
    false,
  );
});

// Adversarial: a non-recognized selector that embeds a known predicted address is rejected as today,
// untouched by the recognized-upgrade path.
test('rejects a non-matching selector that embeds a known predicted address as before', async (t: TestContext) => {
  const targetExternal = `0x${'c1'.repeat(20)}`;
  const upstreamCalls: JsonAny[] = [];
  const result = fixture(t, {
    nonceBaseline: 22,
    resolveCallContext: async () => undefined,
    upstream: {
      async request(method: JsonAny, params: JsonAny) {
        upstreamCalls.push({ method, params });
        return `${method}:result`;
      },
    },
  });
  result.addressMap.set({
    predicted: TARGET,
    actual: TARGET_ACTUAL,
    creator: WALLET.address,
    sender: WALLET.address,
    sourceTransaction: SOURCE_TX,
  });
  const data = `0x12345678${'00'.repeat(12)}${TARGET.slice(2)}`;
  const raw = await signedTransaction({ to: targetExternal, nonce: 22, data });
  const response = await send(result.handlers, raw);
  assert.equal(response.error.data.code, 'OPAQUE_PREDICTED_ADDRESS');
  assert.equal(
    upstreamCalls.some((call: JsonAny) => call.method === 'eth_getStorageAt' || call.method === 'eth_call'),
    false,
  );
});

// Adversarial: a verified recognized upgrade whose implementation argument is rewritten still fails
// closed when a second predicted address rides in the init payload — the narrow rewrite never blesses
// any other embedded predicted address.
test('rejects a recognized external upgrade that smuggles a second predicted address in its payload', async (t: TestContext) => {
  const proxyExternal = `0x${'c1'.repeat(20)}`;
  const implPredicted = `0x${'33'.repeat(20)}`;
  const implActual = `0x${'b3'.repeat(20)}`;
  const result = fixture(t, {
    resolveCallContext: async () => undefined,
    upstream: {
      async request(method: JsonAny, params: JsonAny) {
        if (method === 'eth_getStorageAt' && params[1] === UUPS_IMPLEMENTATION_SLOT) return slotWord(`0x${'e1'.repeat(20)}`);
        return `${method}:result`;
      },
    },
  });
  await seedGatewayImplementation(result, {
    predicted: implPredicted,
    actual: implActual,
    provenance: `0x${'aa'.repeat(32)}`,
    nonce: 21,
    abi: ['function value() view returns (uint256)'],
  });
  result.addressMap.set({
    predicted: TARGET,
    actual: TARGET_ACTUAL,
    creator: WALLET.address,
    sender: WALLET.address,
    sourceTransaction: SOURCE_TX,
  });
  const upgradeData = new Interface(UUPS_UPGRADE_ABI).encodeFunctionData('upgradeToAndCall', [
    implPredicted,
    `0x${'00'.repeat(12)}${TARGET.slice(2)}`,
  ]);
  const raw = await signedTransaction({ to: proxyExternal, nonce: 22, data: upgradeData });
  const response = await send(result.handlers, raw);
  assert.equal(response.error.data.code, 'OPAQUE_PREDICTED_ADDRESS');
  assert.equal(
    result.calls.some((call: JsonAny) => call.type === 'buildCall' || call.type === 'broadcast'),
    false,
  );
});

// An eth_call return whose ABI declares an address output has any mapped actual address in that
// output reverse-mapped to its predicted address, so a Forge script sees the deterministic addresses
// it deployed against.
test('translates mapped actual addresses in eth_call return data to their predicted addresses', async (t: TestContext) => {
  const abi = ['function impl() view returns (address)'];
  const retPredicted = `0x${'77'.repeat(20)}`;
  const retActual = `0x${'c7'.repeat(20)}`;
  const result = fixture(t, {
    resolveCallContext: async () => ({ targetKind: 'contract', abi, artifactIdentity: ARTIFACT_IDENTITY }),
    rewriteCall: async (decoded: JsonAny) => ({ ...decoded, to: TARGET_ACTUAL }),
    upstream: {
      async request(method: JsonAny) {
        if (method === 'eth_call') return new Interface(abi).encodeFunctionResult('impl', [retActual]);
        return `${method}:result`;
      },
    },
  });
  result.addressMap.set({
    predicted: retPredicted,
    actual: retActual,
    creator: WALLET.address,
    sender: WALLET.address,
    sourceTransaction: SOURCE_TX,
  });
  const callData = new Interface(abi).encodeFunctionData('impl', []);
  const response = await result.handlers.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: TARGET, data: callData }, 'latest'],
  });
  assert.equal(response.result, new Interface(abi).encodeFunctionResult('impl', [retPredicted]));
});

// An address returned by an eth_call that is not a known mapped actual is left byte-for-byte unchanged.
test('leaves an unmapped address in eth_call return data unchanged', async (t: TestContext) => {
  const abi = ['function impl() view returns (address)'];
  const unknown = `0x${'d4'.repeat(20)}`;
  const encoded = new Interface(abi).encodeFunctionResult('impl', [unknown]);
  const result = fixture(t, {
    resolveCallContext: async () => ({ targetKind: 'contract', abi, artifactIdentity: ARTIFACT_IDENTITY }),
    rewriteCall: async (decoded: JsonAny) => ({ ...decoded, to: TARGET_ACTUAL }),
    upstream: {
      async request(method: JsonAny) {
        if (method === 'eth_call') return encoded;
        return `${method}:result`;
      },
    },
  });
  const callData = new Interface(abi).encodeFunctionData('impl', []);
  const response = await result.handlers.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: TARGET, data: callData }, 'latest'],
  });
  assert.equal(response.result, encoded);
});

// Reverse-mapping is strictly ABI-type driven: a uint256 return whose value numerically equals a
// mapped actual address is never treated as an address and is left unchanged.
test('leaves a uint256 eth_call return that looks like a mapped address unchanged', async (t: TestContext) => {
  const abi = ['function n() view returns (uint256)'];
  const retActual = `0x${'c7'.repeat(20)}`;
  const encoded = new Interface(abi).encodeFunctionResult('n', [BigInt(retActual)]);
  const result = fixture(t, {
    resolveCallContext: async () => ({ targetKind: 'contract', abi, artifactIdentity: ARTIFACT_IDENTITY }),
    rewriteCall: async (decoded: JsonAny) => ({ ...decoded, to: TARGET_ACTUAL }),
    upstream: {
      async request(method: JsonAny) {
        if (method === 'eth_call') return encoded;
        return `${method}:result`;
      },
    },
  });
  result.addressMap.set({
    predicted: `0x${'77'.repeat(20)}`,
    actual: retActual,
    creator: WALLET.address,
    sender: WALLET.address,
    sourceTransaction: SOURCE_TX,
  });
  const callData = new Interface(abi).encodeFunctionData('n', []);
  const response = await result.handlers.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: TARGET, data: callData }, 'latest'],
  });
  assert.equal(response.result, encoded);
});

// eth_getStorageAt reverse-maps a stored actual address to its predicted address only for the three
// TRC-1967 slots; every other slot is returned byte-for-byte.
test('reverse-maps a TRC-1967 storage slot address while leaving other slots untouched', async (t: TestContext) => {
  const implPredicted = `0x${'22'.repeat(20)}`;
  const implActual = `0x${'b2'.repeat(20)}`;
  const proxyExternal = `0x${'c1'.repeat(20)}`;
  const result = fixture(t, {
    resolveCallContext: async () => undefined,
    upstream: {
      async request() {
        return slotWord(implActual);
      },
    },
  });
  result.addressMap.set({
    predicted: implPredicted,
    actual: implActual,
    creator: WALLET.address,
    sender: WALLET.address,
    sourceTransaction: SOURCE_TX,
  });
  const storageAt = async (slot: JsonAny) =>
    (
      await result.handlers.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getStorageAt',
        params: [proxyExternal, slot, 'latest'],
      })
    ).result;

  for (const slot of [UUPS_IMPLEMENTATION_SLOT, ADMIN_STORAGE_SLOT, BEACON_STORAGE_SLOT]) {
    assert.equal(await storageAt(slot), slotWord(implPredicted));
  }
  assert.equal(await storageAt('0x5'), slotWord(implActual));
});

test('propagates branded upstream JSON-RPC errors without rewriting their code or data', async (t: TestContext) => {
  const error = new UpstreamRpcError(-32042, 'upstream reverted', { reason: 'boom' }, true);
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

test('does not reflect arbitrary dependency error messages to JSON-RPC clients', async (t: TestContext) => {
  const secret = 'PRIVATE_KEY_MATERIAL_SHOULD_NOT_LEAK';
  const { handlers } = fixture(t, {
    upstream: {
      async request() {
        throw Object.assign(new Error(secret), { code: 500, data: { secret } });
      },
    },
  });
  const response = await handlers.handle({ jsonrpc: '2.0', id: 1, method: 'eth_gasPrice', params: [] });
  assert.equal(response.error.code, -32000);
  assert.equal(response.error.message, 'TRON RPC operation failed');
  assert.equal(JSON.stringify(response).includes(secret), false);
});

test('implements strict JSON-RPC single, batch, notification, and invalid request semantics', async (t: TestContext) => {
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

test('turns deterministic prebuild failures into durable terminal failures and never broadcasts', async (t: TestContext) => {
  const raw = await signedTransaction({ nonce: 12 });
  const sourceHash = keccak256(raw);
  const result = fixture(t, {
    nonceBaseline: 12,
    sourceHash,
    matchDeploymentArtifact() {
      const error: JsonAny = new Error('artifact mismatch');
      error.code = 'ARTIFACT_NOT_FOUND';
      throw error;
    },
  });
  const response = await send(result.handlers, raw);
  assert.equal(response.error.code, -32000);
  assert.equal(result.journal.get(sourceHash).state, 'failed');
  assert.equal(result.journal.get(sourceHash).failure.code, 'ARTIFACT_NOT_FOUND');
  assert.equal(result.calls.filter((call: JsonAny) => call.type === 'broadcast').length, 0);
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

test('classifies privileged contract kinds only for exact canonical TRON and upstream v4 artifact identities', () => {
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
    for (const source of [
      sourceName,
      `lib/${sourceName}`,
      sourceName.replace('openzeppelin-tron-solidity/', 'lib/tron-contracts/'),
      `lib/openzeppelin-foundry-upgrades-tron/lib/${sourceName}`,
    ]) {
      assert.equal(
        contractKindForArtifact({ sourceName: source, contractName, fullyQualifiedName: `${source}:${contractName}` }),
        expected,
      );
    }
  }

  for (const [sourceName, contractName, expected] of [
    ['node_modules/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol', 'ERC1967Proxy', 'uups-proxy'],
    [
      'node_modules/@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol',
      'TransparentUpgradeableProxy',
      'transparent-proxy',
    ],
    ['node_modules/@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol', 'ProxyAdmin', 'proxy-admin'],
    [
      'node_modules/@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol',
      'UpgradeableBeacon',
      'upgradeable-beacon',
    ],
    ['node_modules/@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol', 'BeaconProxy', 'beacon-proxy'],
  ]) {
    assert.equal(
      contractKindForArtifact({ sourceName, contractName, fullyQualifiedName: `${sourceName}:${contractName}` }),
      expected,
    );
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
