const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { getCreateAddress, keccak256 } = require('ethers');

const { AddressMap } = require('../address-map.cjs');
const { CreateReconciler, CreateReconciliationError } = require('../create-reconciler.cjs');
const { TransactionJournal } = require('../journal.cjs');
const { JsonStore } = require('../store.cjs');

const CHAIN = 'tre:728126428';
const SOURCE_BYTES = `0x${'01'.repeat(97)}`;
const SOURCE_HASH = keccak256(SOURCE_BYTES);
const NATIVE_BYTES = `0a02ABcd${'42'.repeat(40)}`;
const NATIVE_TXID = 'cd'.repeat(32);
const PROVENANCE_HASH = `0x${'44'.repeat(32)}`;
const SENDER = `0x${'10'.repeat(20)}`;
const ROOT_PREDICTED = `0x${'11'.repeat(20)}`;
const ROOT_ACTUAL = `0x${'22'.repeat(20)}`;
const CHILD_ACTUAL_1 = `0x${'31'.repeat(20)}`;
const CHILD_ACTUAL_2 = `0x${'32'.repeat(20)}`;
const CHILD_ACTUAL_3 = `0x${'33'.repeat(20)}`;
const TRANSPARENT_IDENTITY = {
  sourceName: 'lib/openzeppelin-tron-solidity/contracts/proxy/transparent/TransparentUpgradeableProxy.sol',
  contractName: 'TransparentUpgradeableProxy',
  fullyQualifiedName:
    'lib/openzeppelin-tron-solidity/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy',
};
const PROXY_ADMIN_IDENTITY = {
  sourceName: 'openzeppelin-tron-solidity/contracts/proxy/transparent/ProxyAdmin.sol',
  contractName: 'ProxyAdmin',
  fullyQualifiedName: 'openzeppelin-tron-solidity/contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin',
};

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-tron-reconciler-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, 'state.json');
  const store = new JsonStore(statePath);
  const journal = new TransactionJournal(store, CHAIN, { ownerId: 'boot-a' });
  const addressMap = new AddressMap(store, CHAIN);
  const reconciler = new CreateReconciler(journal, addressMap);
  journal.receive(SOURCE_BYTES);
  return { addressMap, journal, reconciler, statePath, store };
}

function nativeTransaction() {
  return { signedNativeTransaction: NATIVE_BYTES, nativeTransactionId: NATIVE_TXID };
}

function simulation(attempts) {
  return { nativeTransactionId: NATIVE_TXID, traceComplete: true, childCreateAttempts: attempts };
}

function attempt(callerAddress, createdAddress, success = true) {
  return { callerAddress, createdAddress, success };
}

function context(overrides = {}) {
  return {
    kind: 'deployment',
    from: SENDER,
    to: null,
    nonce: '0',
    predictedContractAddress: ROOT_PREDICTED,
    actualTarget: ROOT_ACTUAL,
    contractKind: 'transparent-proxy',
    artifactIdentity: TRANSPARENT_IDENTITY,
    provenanceHash: PROVENANCE_HASH,
    ...overrides,
  };
}

function receipt(creations) {
  return {
    transactionHash: SOURCE_HASH,
    blockNumber: '0x2a',
    status: '0x1',
    tron: {
      nativeTransactionId: NATIVE_TXID,
      actualContractAddress: ROOT_ACTUAL,
      internalTransactions: creations.map((actual, index) => ({
        hash: `0x${String(index + 1).padStart(64, '0')}`,
        callerAddress: ROOT_ACTUAL,
        transferToAddress: actual,
        note: 'create',
        rejected: false,
        callValueInfo: [],
      })),
    },
  };
}

function prepareAndBroadcast(journal, reconciler, attempts, prepareContext = context()) {
  const prepared = reconciler.recordPreparedNative(
    SOURCE_HASH,
    nativeTransaction(),
    simulation(attempts),
    prepareContext,
  );
  journal.recordBroadcast(SOURCE_HASH);
  return prepared.childCreatePlan;
}

test('reverse-resolves the actual caller and derives the first child with CREATE nonce 1', t => {
  const { journal, reconciler } = fixture(t);
  const plan = prepareAndBroadcast(journal, reconciler, [attempt(ROOT_ACTUAL, CHILD_ACTUAL_1)]);
  const predicted = getCreateAddress({ from: ROOT_PREDICTED, nonce: 1 });

  assert.equal(plan.attempts[0].predictedCaller, ROOT_PREDICTED);
  assert.equal(plan.attempts[0].nonce, '1');
  assert.equal(plan.attempts[0].predictedAddress, predicted.toLowerCase());
  assert.deepEqual(journal.get(SOURCE_HASH).childCreatePlan, plan);
});

test('advances caller nonces for failed attempts and maps successful children in execution order', t => {
  const { addressMap, journal, reconciler } = fixture(t);
  const attempts = [
    attempt(ROOT_ACTUAL, `0x${'00'.repeat(20)}`, false),
    attempt(ROOT_ACTUAL, CHILD_ACTUAL_1),
    attempt(ROOT_ACTUAL, CHILD_ACTUAL_2),
  ];
  const plan = prepareAndBroadcast(journal, reconciler, attempts);
  const confirmed = reconciler.reconcile(SOURCE_HASH, receipt([CHILD_ACTUAL_1, CHILD_ACTUAL_2]));
  const first = getCreateAddress({ from: ROOT_PREDICTED, nonce: 2 }).toLowerCase();
  const second = getCreateAddress({ from: ROOT_PREDICTED, nonce: 3 }).toLowerCase();

  assert.deepEqual(
    plan.attempts.map(item => [item.nonce, item.success]),
    [
      ['1', false],
      ['2', true],
      ['3', true],
    ],
  );
  assert.equal(addressMap.toActual(first), CHILD_ACTUAL_1);
  assert.equal(addressMap.toActual(second), CHILD_ACTUAL_2);
  assert.equal(reconciler.nextNonce(ROOT_PREDICTED), 4n);
  assert.equal(confirmed.state, 'confirmed');
});

test('uses provisional successful child mappings for nested callers and starts each new contract at nonce 1', t => {
  const { addressMap, journal, reconciler } = fixture(t);
  const predictedChild = getCreateAddress({ from: ROOT_PREDICTED, nonce: 1 }).toLowerCase();
  const predictedGrandchild = getCreateAddress({ from: predictedChild, nonce: 1 }).toLowerCase();
  const plan = prepareAndBroadcast(journal, reconciler, [
    attempt(ROOT_ACTUAL, CHILD_ACTUAL_1),
    attempt(CHILD_ACTUAL_1, CHILD_ACTUAL_2),
  ]);
  const nestedReceipt = receipt([CHILD_ACTUAL_1, CHILD_ACTUAL_2]);
  nestedReceipt.tron.internalTransactions[1].callerAddress = CHILD_ACTUAL_1;
  reconciler.reconcile(SOURCE_HASH, nestedReceipt);

  assert.equal(plan.attempts[1].predictedCaller, predictedChild);
  assert.equal(plan.attempts[1].nonce, '1');
  assert.equal(plan.attempts[1].predictedAddress, predictedGrandchild);
  assert.equal(addressMap.toActual(predictedGrandchild), CHILD_ACTUAL_2);
  assert.equal(reconciler.nextNonce(predictedChild), 2n);
});

test('persists counters and child mappings across restart', t => {
  const { journal, reconciler, statePath } = fixture(t);
  prepareAndBroadcast(journal, reconciler, [attempt(ROOT_ACTUAL, CHILD_ACTUAL_1)]);
  reconciler.reconcile(SOURCE_HASH, receipt([CHILD_ACTUAL_1]));

  const restartedStore = new JsonStore(statePath);
  const restarted = new CreateReconciler(
    new TransactionJournal(restartedStore, CHAIN, { ownerId: 'boot-b' }),
    new AddressMap(restartedStore, CHAIN),
  );
  assert.equal(restarted.nextNonce(ROOT_PREDICTED), 2n);
  assert.equal(
    new AddressMap(new JsonStore(statePath), CHAIN).toActual(getCreateAddress({ from: ROOT_PREDICTED, nonce: 1 })),
    CHILD_ACTUAL_1,
  );
});

test('persists derivable ProxyAdmin kind and artifact identity for a transparent proxy child', t => {
  const { addressMap, journal, reconciler, statePath } = fixture(t);
  const predictedAdmin = getCreateAddress({ from: ROOT_PREDICTED, nonce: 1 }).toLowerCase();
  prepareAndBroadcast(journal, reconciler, [attempt(ROOT_ACTUAL, CHILD_ACTUAL_1)]);
  reconciler.reconcile(SOURCE_HASH, receipt([CHILD_ACTUAL_1]));

  assert.deepEqual(addressMap.resolveContractMetadata(predictedAdmin), {
    predicted: predictedAdmin,
    contractKind: 'proxy-admin',
    artifactIdentity: PROXY_ADMIN_IDENTITY,
    sourceTransaction: SOURCE_HASH,
  });
  assert.deepEqual(
    new AddressMap(new JsonStore(statePath), CHAIN).resolveContractMetadata(CHILD_ACTUAL_1),
    addressMap.resolveContractMetadata(predictedAdmin),
  );
});

test('refuses incomplete simulation before broadcast and persists a deterministic terminal failure', t => {
  const { journal, reconciler } = fixture(t);

  assert.throws(
    () =>
      reconciler.recordPreparedNative(
        SOURCE_HASH,
        nativeTransaction(),
        { nativeTransactionId: NATIVE_TXID, traceComplete: false, childCreateAttempts: [] },
        context(),
      ),
    error => error instanceof CreateReconciliationError && error.code === 'SIMULATION_INCOMPLETE',
  );
  assert.deepEqual(journal.get(SOURCE_HASH).failure, {
    code: 'SIMULATION_INCOMPLETE',
    message: 'Exact simulation did not provide a complete child CREATE trace',
  });
  assert.throws(() => journal.recordBroadcast(SOURCE_HASH), /failed.*broadcast/i);
});

test('binds the complete simulation trace to the exact signed native transaction ID', t => {
  const { journal, reconciler } = fixture(t);

  assert.throws(
    () =>
      reconciler.recordPreparedNative(
        SOURCE_HASH,
        nativeTransaction(),
        { ...simulation([]), nativeTransactionId: 'ef'.repeat(32) },
        context(),
      ),
    error => error instanceof CreateReconciliationError && error.code === 'SIMULATION_TRANSACTION_MISMATCH',
  );
  assert.equal(journal.get(SOURCE_HASH).state, 'failed');
});

test('recovers only a simulation-complete native-built transaction with its exact operation context', t => {
  const { journal, reconciler, statePath } = fixture(t);
  const plan = reconciler.recordPreparedNative(
    SOURCE_HASH,
    nativeTransaction(),
    simulation([attempt(ROOT_ACTUAL, CHILD_ACTUAL_1)]),
    context(),
  ).childCreatePlan;

  const restarted = new TransactionJournal(new JsonStore(statePath), CHAIN, { ownerId: 'boot-b' });
  const record = restarted.get(SOURCE_HASH);
  assert.equal(record.state, 'native-built');
  assert.deepEqual(
    {
      signedNativeTransaction: record.signedNativeTransaction,
      nativeTransactionId: record.nativeTransactionId,
    },
    nativeTransaction(),
  );
  assert.deepEqual(record.operationContext, context());
  assert.deepEqual(record.childCreatePlan, plan);
  assert.equal(restarted.receive(SOURCE_BYTES).shouldBuild, false);
});

test('refuses a persisted plan whose predicted child is not derived from its caller and nonce', t => {
  const { reconciler, statePath } = fixture(t);
  reconciler.recordPreparedNative(
    SOURCE_HASH,
    nativeTransaction(),
    simulation([attempt(ROOT_ACTUAL, CHILD_ACTUAL_1)]),
    context(),
  );
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.chains[CHAIN].transactionJournal.records[SOURCE_HASH].childCreatePlan.attempts[0].predictedAddress =
    CHILD_ACTUAL_3;
  fs.writeFileSync(statePath, JSON.stringify(state));

  const restartedStore = new JsonStore(statePath);
  const restarted = new TransactionJournal(restartedStore, CHAIN, { ownerId: 'boot-b' });
  assert.throws(() => restarted.get(SOURCE_HASH), /corrupt.*journal.*record/i);
});

for (const mismatch of ['count', 'order']) {
  test(`retains a fatal post-receipt ${mismatch} mismatch without publishing partial state`, t => {
    const { addressMap, journal, reconciler } = fixture(t);
    const plan = prepareAndBroadcast(journal, reconciler, [
      attempt(ROOT_ACTUAL, CHILD_ACTUAL_1),
      attempt(ROOT_ACTUAL, CHILD_ACTUAL_2),
    ]);
    const mismatchedReceipt =
      mismatch === 'count' ? receipt([CHILD_ACTUAL_1]) : receipt([CHILD_ACTUAL_2, CHILD_ACTUAL_1]);

    assert.throws(
      () => reconciler.reconcile(SOURCE_HASH, mismatchedReceipt),
      error => error instanceof CreateReconciliationError && error.code === 'CHILD_CREATE_MISMATCH',
    );
    const retained = journal.get(SOURCE_HASH);
    assert.equal(retained.state, 'failed');
    assert.deepEqual(retained.receipt, mismatchedReceipt);
    assert.deepEqual(retained.childCreatePlan, plan);
    assert.equal(addressMap.list().length, 0);
    assert.equal(reconciler.nextNonce(ROOT_PREDICTED), 1n);
  });
}

test('retains a fatal mismatch when a receipt creation has a different caller than the simulation', t => {
  const { addressMap, journal, reconciler } = fixture(t);
  prepareAndBroadcast(journal, reconciler, [attempt(ROOT_ACTUAL, CHILD_ACTUAL_1)]);
  const mismatchedReceipt = receipt([CHILD_ACTUAL_1]);
  mismatchedReceipt.tron.internalTransactions[0].callerAddress = SENDER;

  assert.throws(
    () => reconciler.reconcile(SOURCE_HASH, mismatchedReceipt),
    error => error instanceof CreateReconciliationError && error.code === 'CHILD_CREATE_MISMATCH',
  );
  assert.equal(journal.get(SOURCE_HASH).state, 'failed');
  assert.equal(addressMap.list().length, 0);
});

test('retains a fatal mismatch when the deployment receipt has a different top-level actual address', t => {
  const { addressMap, journal, reconciler } = fixture(t);
  prepareAndBroadcast(journal, reconciler, []);
  const mismatchedReceipt = receipt([]);
  mismatchedReceipt.tron.actualContractAddress = CHILD_ACTUAL_3;

  assert.throws(
    () => reconciler.reconcile(SOURCE_HASH, mismatchedReceipt),
    error => error instanceof CreateReconciliationError && error.code === 'DEPLOYMENT_ADDRESS_MISMATCH',
  );
  assert.equal(journal.get(SOURCE_HASH).state, 'failed');
  assert.equal(addressMap.list().length, 0);
});

test('retains a fatal mapping conflict and atomically withholds receipt confirmation, metadata, and counters', t => {
  const { addressMap, journal, reconciler } = fixture(t);
  const predicted = getCreateAddress({ from: ROOT_PREDICTED, nonce: 1 }).toLowerCase();
  addressMap.set({
    predicted,
    actual: CHILD_ACTUAL_3,
    creator: ROOT_PREDICTED,
    sender: SENDER,
    sourceTransaction: `0x${'ab'.repeat(32)}`,
  });
  prepareAndBroadcast(journal, reconciler, [attempt(ROOT_ACTUAL, CHILD_ACTUAL_1)]);

  assert.throws(
    () => reconciler.reconcile(SOURCE_HASH, receipt([CHILD_ACTUAL_1])),
    error => error instanceof CreateReconciliationError && error.code === 'CHILD_CREATE_CONFLICT',
  );
  assert.equal(journal.get(SOURCE_HASH).state, 'failed');
  assert.equal(journal.get(SOURCE_HASH).receipt.tron.internalTransactions.length, 1);
  assert.equal(addressMap.toActual(predicted), CHILD_ACTUAL_3);
  assert.equal(addressMap.resolveContractMetadata(predicted), undefined);
  assert.equal(reconciler.nextNonce(ROOT_PREDICTED), 1n);
});

test('refuses a stale pending plan after another confirmation advances its caller counter', t => {
  const { journal, reconciler, store } = fixture(t);
  prepareAndBroadcast(journal, reconciler, [attempt(ROOT_ACTUAL, CHILD_ACTUAL_1)]);
  store.transaction(CHAIN, chain => {
    chain.childCreateReconciliation = {
      version: 1,
      nextNonceByCaller: { [ROOT_PREDICTED]: '2' },
    };
  });

  assert.throws(
    () => reconciler.reconcile(SOURCE_HASH, receipt([CHILD_ACTUAL_1])),
    error => error instanceof CreateReconciliationError && error.code === 'CHILD_CREATE_COUNTER_CONFLICT',
  );
  assert.equal(journal.get(SOURCE_HASH).state, 'failed');
  assert.equal(reconciler.nextNonce(ROOT_PREDICTED), 2n);
});
