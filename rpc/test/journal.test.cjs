const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { keccak256 } = require('ethers');

const { TransactionJournal } = require('../journal.cjs');
const { JsonStore } = require('../store.cjs');

const SOURCE_BYTES = `0x${'01'.repeat(97)}`;
const SOURCE_HASH = keccak256(SOURCE_BYTES);
const NATIVE_BYTES = `0a02ABcd${'42'.repeat(40)}`;
const NATIVE_TXID = `${'cd'.repeat(32)}`;

function fixture(t, chain = 'tre:728126428', ownerId = 'boot-a') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-tron-journal-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, 'state.json');
  return {
    journal: new TransactionJournal(new JsonStore(statePath), chain, { ownerId }),
    statePath,
  };
}

function nativeTransaction(overrides = {}) {
  return {
    signedNativeTransaction: NATIVE_BYTES,
    nativeTransactionId: NATIVE_TXID,
    ...overrides,
  };
}

test('durably follows received -> native-built -> broadcast -> confirmed', t => {
  const { journal } = fixture(t);

  assert.deepEqual(journal.receive(SOURCE_BYTES), {
    shouldBuild: true,
    record: {
      sourceTransactionHash: SOURCE_HASH,
      signedEthereumTransaction: SOURCE_BYTES,
      state: 'received',
      buildClaimOwner: 'boot-a',
    },
  });
  assert.deepEqual(journal.recordNativeBuilt(SOURCE_HASH, nativeTransaction()), {
    sourceTransactionHash: SOURCE_HASH,
    signedEthereumTransaction: SOURCE_BYTES,
    state: 'native-built',
    ...nativeTransaction(),
  });
  assert.equal(journal.recordBroadcast(SOURCE_HASH).state, 'broadcast');

  const receipt = { transactionHash: SOURCE_HASH, blockNumber: '0x2a', status: '0x1' };
  assert.deepEqual(journal.recordConfirmed(SOURCE_HASH, receipt), {
    sourceTransactionHash: SOURCE_HASH,
    signedEthereumTransaction: SOURCE_BYTES,
    state: 'confirmed',
    ...nativeTransaction(),
    receipt,
  });
  assert.deepEqual(journal.get(SOURCE_HASH), journal.recordConfirmed(SOURCE_HASH, receipt));
});

test('rejects missing records and illegal state transitions', t => {
  const { journal } = fixture(t);

  assert.throws(() => journal.recordNativeBuilt(SOURCE_HASH, nativeTransaction()), /unknown.*transaction/i);
  journal.receive(SOURCE_BYTES);
  assert.throws(() => journal.recordBroadcast(SOURCE_HASH), /received.*broadcast/i);
  assert.throws(() => journal.recordConfirmed(SOURCE_HASH, {}), /received.*confirmed/i);
  journal.recordNativeBuilt(SOURCE_HASH, nativeTransaction());
  assert.throws(() => journal.recordConfirmed(SOURCE_HASH, {}), /native-built.*confirmed/i);
  journal.recordBroadcast(SOURCE_HASH);
  assert.throws(() => journal.recordNativeBuilt(SOURCE_HASH, nativeTransaction()), /broadcast.*native-built/i);
});

test('records terminal failures idempotently and forbids later transitions', t => {
  const { journal } = fixture(t);
  const failure = { code: 'UNSUPPORTED_TRANSACTION', message: 'typed transaction is unsupported' };

  journal.receive(SOURCE_BYTES);
  assert.deepEqual(journal.recordFailed(SOURCE_HASH, failure), {
    sourceTransactionHash: SOURCE_HASH,
    signedEthereumTransaction: SOURCE_BYTES,
    state: 'failed',
    failure,
  });
  assert.deepEqual(journal.recordFailed(SOURCE_HASH, failure), journal.get(SOURCE_HASH));
  assert.throws(() => journal.recordFailed(SOURCE_HASH, { ...failure, message: 'different' }), /failure.*conflict/i);
  assert.throws(() => journal.recordNativeBuilt(SOURCE_HASH, nativeTransaction()), /failed.*native-built/i);
  assert.throws(() => journal.recordBroadcast(SOURCE_HASH), /failed.*broadcast/i);
  assert.throws(() => journal.recordConfirmed(SOURCE_HASH, {}), /failed.*confirmed/i);
});

test('retains built native bytes and txid when a later stage fails', t => {
  const { journal, statePath } = fixture(t);
  const failure = { code: 'SIMULATION_INCOMPLETE', message: 'child attempt trace is incomplete' };

  journal.receive(SOURCE_BYTES);
  journal.recordNativeBuilt(SOURCE_HASH, nativeTransaction());
  journal.recordBroadcast(SOURCE_HASH);
  assert.deepEqual(journal.recordFailed(SOURCE_HASH, failure), {
    sourceTransactionHash: SOURCE_HASH,
    signedEthereumTransaction: SOURCE_BYTES,
    state: 'failed',
    ...nativeTransaction(),
    failure,
  });

  const restarted = new TransactionJournal(new JsonStore(statePath), 'tre:728126428');
  assert.deepEqual(restarted.get(SOURCE_HASH), journal.get(SOURCE_HASH));
});

test('returns an existing record for an identical source retry', t => {
  const { journal } = fixture(t);
  journal.receive(SOURCE_BYTES);
  journal.recordNativeBuilt(SOURCE_HASH, nativeTransaction());

  assert.deepEqual(journal.receive(SOURCE_BYTES.toUpperCase().replace('0X', '0x')), {
    shouldBuild: false,
    record: {
      sourceTransactionHash: SOURCE_HASH,
      signedEthereumTransaction: SOURCE_BYTES,
      state: 'native-built',
      ...nativeTransaction(),
    },
  });
  assert.equal(journal.list().length, 1);
});

test('grants only one native-build claim to concurrent receives in one boot', t => {
  const { journal } = fixture(t);

  const first = journal.receive(SOURCE_BYTES);
  const inProgressRetry = journal.receive(SOURCE_BYTES);

  assert.equal(first.shouldBuild, true);
  assert.equal(inProgressRetry.shouldBuild, false);
  assert.deepEqual(inProgressRetry.record, first.record);
  assert.throws(
    () =>
      new TransactionJournal(journal.store, 'tre:728126428', { ownerId: 'boot-same' }).recordNativeBuilt(
        SOURCE_HASH,
        nativeTransaction(),
      ),
    /build claim/i,
  );
});

test('a restarted boot atomically takes over a stranded received build claim', t => {
  const { journal, statePath } = fixture(t);
  assert.equal(journal.receive(SOURCE_BYTES).shouldBuild, true);

  const restarted = new TransactionJournal(new JsonStore(statePath), 'tre:728126428', {
    ownerId: 'boot-b',
  });
  const takeover = restarted.receive(SOURCE_BYTES);
  assert.equal(takeover.shouldBuild, true);
  assert.equal(takeover.record.buildClaimOwner, 'boot-b');
  assert.equal(restarted.receive(SOURCE_BYTES).shouldBuild, false);
  assert.throws(
    () => journal.recordFailed(SOURCE_HASH, { code: 'STALE_BOOT', message: 'must not commit' }),
    /build claim/i,
  );
  assert.throws(() => journal.recordNativeBuilt(SOURCE_HASH, nativeTransaction()), /build claim/i);
  assert.equal(restarted.recordNativeBuilt(SOURCE_HASH, nativeTransaction()).state, 'native-built');
  assert.equal(restarted.get(SOURCE_HASH).buildClaimOwner, undefined);
});

test('the current takeover owner can terminally fail a stranded received claim', t => {
  const { journal, statePath } = fixture(t);
  journal.receive(SOURCE_BYTES);

  const restarted = new TransactionJournal(new JsonStore(statePath), 'tre:728126428', {
    ownerId: 'boot-b',
  });
  assert.equal(restarted.receive(SOURCE_BYTES).shouldBuild, true);
  const failed = restarted.recordFailed(SOURCE_HASH, {
    code: 'UNSUPPORTED_TRANSACTION',
    message: 'source cannot be translated',
  });

  assert.equal(failed.state, 'failed');
  assert.equal(failed.buildClaimOwner, undefined);
});

test('never replaces a persisted native transaction during retry', t => {
  const { journal } = fixture(t);
  journal.receive(SOURCE_BYTES);
  journal.recordNativeBuilt(SOURCE_HASH, nativeTransaction());

  assert.deepEqual(journal.recordNativeBuilt(SOURCE_HASH, nativeTransaction()), journal.get(SOURCE_HASH));
  assert.throws(
    () =>
      journal.recordNativeBuilt(SOURCE_HASH, nativeTransaction({ signedNativeTransaction: `0a02${'99'.repeat(42)}` })),
    /native transaction.*conflict/i,
  );
  assert.throws(
    () => journal.recordNativeBuilt(SOURCE_HASH, nativeTransaction({ nativeTransactionId: 'ef'.repeat(32) })),
    /native transaction.*conflict/i,
  );
  assert.deepEqual(journal.get(SOURCE_HASH), {
    sourceTransactionHash: SOURCE_HASH,
    signedEthereumTransaction: SOURCE_BYTES,
    state: 'native-built',
    ...nativeTransaction(),
  });
});

test('resumes the exact signed native transaction after a crash at native-built', t => {
  const { journal, statePath } = fixture(t);
  journal.receive(SOURCE_BYTES);
  journal.recordNativeBuilt(SOURCE_HASH, nativeTransaction());

  const restarted = new TransactionJournal(new JsonStore(statePath), 'tre:728126428', {
    ownerId: 'boot-b',
  });
  assert.deepEqual(restarted.receive(SOURCE_BYTES), {
    record: journal.get(SOURCE_HASH),
    shouldBuild: false,
  });
  assert.equal(restarted.get(SOURCE_HASH).signedNativeTransaction, NATIVE_BYTES);
  assert.equal(restarted.get(SOURCE_HASH).nativeTransactionId, NATIVE_TXID);
});

test('resumes the exact native transaction after a crash at broadcast', t => {
  const { journal, statePath } = fixture(t);
  journal.receive(SOURCE_BYTES);
  journal.recordNativeBuilt(SOURCE_HASH, nativeTransaction());
  journal.recordBroadcast(SOURCE_HASH);

  const restarted = new TransactionJournal(new JsonStore(statePath), 'tre:728126428', {
    ownerId: 'boot-b',
  });
  const resumed = restarted.receive(SOURCE_BYTES);
  assert.equal(resumed.shouldBuild, false);
  assert.equal(resumed.record.state, 'broadcast');
  assert.equal(resumed.record.signedNativeTransaction, NATIVE_BYTES);
  assert.equal(resumed.record.nativeTransactionId, NATIVE_TXID);
});

test('replays a persisted receipt after restart without changing it', t => {
  const { journal, statePath } = fixture(t);
  const receipt = {
    transactionHash: SOURCE_HASH,
    blockHash: `0x${'ef'.repeat(32)}`,
    logs: [{ address: `0x${'12'.repeat(20)}`, topics: [] }],
  };
  journal.receive(SOURCE_BYTES);
  journal.recordNativeBuilt(SOURCE_HASH, nativeTransaction());
  journal.recordBroadcast(SOURCE_HASH);
  journal.recordConfirmed(SOURCE_HASH, receipt);

  const restarted = new TransactionJournal(new JsonStore(statePath), 'tre:728126428', {
    ownerId: 'boot-b',
  });
  assert.deepEqual(restarted.receive(SOURCE_BYTES).record.receipt, receipt);
  assert.deepEqual(restarted.recordConfirmed(SOURCE_HASH, structuredClone(receipt)).receipt, receipt);
  assert.throws(
    () => restarted.recordConfirmed(SOURCE_HASH, { ...receipt, blockHash: `0x${'aa'.repeat(32)}` }),
    /receipt.*conflict/i,
  );
});

test('refuses corrupt persisted confirmed receipt shapes after restart', t => {
  const corruptReceipts = [null, [], 'receipt', 1, true];

  for (const corruptReceipt of corruptReceipts) {
    const { journal, statePath } = fixture(t);
    journal.receive(SOURCE_BYTES);
    journal.recordNativeBuilt(SOURCE_HASH, nativeTransaction());
    journal.recordBroadcast(SOURCE_HASH);
    journal.recordConfirmed(SOURCE_HASH, { status: '0x1' });

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.chains['tre:728126428'].transactionJournal.records[SOURCE_HASH].receipt = corruptReceipt;
    fs.writeFileSync(statePath, JSON.stringify(state));

    const restarted = new TransactionJournal(new JsonStore(statePath), 'tre:728126428', {
      ownerId: 'boot-b',
    });
    assert.throws(() => restarted.get(SOURCE_HASH), /corrupt.*journal.*record/i);
  }
});

test('refuses a persisted confirmation whose non-JSON receipt was omitted', t => {
  const { journal, statePath } = fixture(t);
  journal.receive(SOURCE_BYTES);
  journal.recordNativeBuilt(SOURCE_HASH, nativeTransaction());
  journal.recordBroadcast(SOURCE_HASH);
  journal.recordConfirmed(SOURCE_HASH, { status: '0x1' });

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.chains['tre:728126428'].transactionJournal.records[SOURCE_HASH].receipt = undefined;
  fs.writeFileSync(statePath, JSON.stringify(state));

  const restarted = new TransactionJournal(new JsonStore(statePath), 'tre:728126428', {
    ownerId: 'boot-b',
  });
  assert.throws(() => restarted.get(SOURCE_HASH), /corrupt.*journal.*record/i);
});

test('rejects a non-durable receipt before committing confirmation', t => {
  const { journal } = fixture(t);
  journal.receive(SOURCE_BYTES);
  journal.recordNativeBuilt(SOURCE_HASH, nativeTransaction());
  journal.recordBroadcast(SOURCE_HASH);

  assert.throws(() => journal.recordConfirmed(SOURCE_HASH, undefined), /receipt/i);
  assert.equal(journal.get(SOURCE_HASH).state, 'broadcast');
});

test('preserves signed native bytes and txid exactly', t => {
  const { journal, statePath } = fixture(t);
  journal.receive(SOURCE_BYTES);
  journal.recordNativeBuilt(SOURCE_HASH, nativeTransaction());

  const stored = JSON.parse(fs.readFileSync(statePath, 'utf8')).chains['tre:728126428'].transactionJournal.records[
    SOURCE_HASH
  ];
  assert.equal(stored.signedNativeTransaction, NATIVE_BYTES);
  assert.equal(stored.nativeTransactionId, NATIVE_TXID);
});

test('separates journals by chain and validates transaction inputs', t => {
  const { statePath } = fixture(t);
  const store = new JsonStore(statePath);
  const first = new TransactionJournal(store, 'chain-a');
  const second = new TransactionJournal(store, 'chain-b');

  first.receive(SOURCE_BYTES);
  assert.equal(second.get(SOURCE_HASH), undefined);
  assert.throws(() => first.receive('not-hex'), /signed Ethereum transaction/i);
  assert.throws(
    () => first.recordNativeBuilt(SOURCE_HASH, nativeTransaction({ nativeTransactionId: 'nope' })),
    /txid/i,
  );
  assert.throws(
    () => first.recordNativeBuilt(SOURCE_HASH, nativeTransaction({ signedNativeTransaction: 'not-hex' })),
    /signed native transaction/i,
  );
});
