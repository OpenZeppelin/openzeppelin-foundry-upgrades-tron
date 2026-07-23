import assert from 'node:assert/strict';
import test from 'node:test';

import { NonceOrderedQueue } from '../../dist/rpc/transaction-queue.js';

// The queue coordinates opaque per-signer work; the test doubles for released work, timers, and the
// durable expected-nonce oracle are deliberately loosely shaped, mirroring the runtime seam.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonAny = any;

// A tiny seeded PRNG (mulberry32) so every randomized/volume run is deterministic and reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  const copy = items.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rand() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// A harness whose expected-nonce oracle is a mutable per-signer map (the durable store double); a
// synchronous `run` records the per-signer release order and, on success, advances the signer's
// durable expected nonce so the queue treats that nonce as consumed on the next pump. Timers are
// captured, never auto-fired, so ordering is a pure function of enqueue/settlement sequencing.
function harness(overrides: JsonAny = {}) {
  const nextExpected = new Map<string, bigint>();
  const timers: JsonAny[] = [];
  const releases = new Map<string, bigint[]>();
  const queue = new NonceOrderedQueue({
    expectedNonce: (signer: string) => nextExpected.get(signer) ?? 0n,
    gapDeadlineMs: 1_000,
    scheduleTimeout: (callback: () => void, ms: number) => {
      const timer = { callback, ms, cancelled: false, fired: false };
      timers.push(timer);
      return timer;
    },
    cancelTimeout: (timer: JsonAny) => {
      timer.cancelled = true;
    },
    ...overrides,
  });
  const record = (signer: string, nonce: bigint) => {
    const list = releases.get(signer) ?? [];
    list.push(nonce);
    releases.set(signer, list);
  };
  const run = (signer: string, nonce: bigint, options: JsonAny = {}) => {
    record(signer, nonce);
    if (options.fail) throw Object.assign(new Error('processing failed'), { code: 'PROCESSING_FAILED' });
    nextExpected.set(signer, nonce + 1n);
    return `${signer}:${nonce}`;
  };
  const fireDeadline = () => {
    const timer = [...timers].reverse().find(candidate => !candidate.cancelled && !candidate.fired);
    assert.ok(timer !== undefined, 'expected an armed deadline timer');
    timer.fired = true;
    timer.callback();
  };
  return { queue, nextExpected, timers, releases, record, run, fireDeadline };
}

test('admits several signers strictly in ascending nonce order despite interleaved out-of-order enqueue', async () => {
  const { queue, releases, run } = harness();
  const signers = ['A', 'B', 'C'];
  const perSigner = 6;
  const results: JsonAny[] = [];
  // Enqueue every (signer, nonce) pair in a fixed interleaved, per-signer-reversed order so each
  // signer sees its nonces arrive high-to-low, all three signers interleaved with one another.
  for (let nonce = perSigner - 1; nonce >= 0; nonce -= 1) {
    for (const signer of signers) {
      const value = BigInt(nonce);
      results.push(queue.enqueue(signer, value, `0x${signer}${nonce}`, async () => run(signer, value)));
    }
  }
  await Promise.all(results);
  for (const signer of signers) {
    assert.deepEqual(
      releases.get(signer),
      Array.from({ length: perSigner }, (_unused, index) => BigInt(index)),
      `signer ${signer} released out of order`,
    );
  }
});

test('collapses a burst of duplicate same-hash enqueues into a single admission', async () => {
  const { queue, releases, run } = harness();
  const duplicates = Array.from({ length: 25 }, () =>
    queue.enqueue('A', 0n, '0xdup', async () => run('A', 0n)),
  );
  // Every duplicate resend must join the identical promise instance, never a second entry.
  for (const promise of duplicates) assert.equal(promise, duplicates[0]);
  const values = await Promise.all(duplicates);
  assert.deepEqual(new Set(values), new Set(['A:0']));
  assert.deepEqual(releases.get('A'), [0n]);
});

test('rejects every distinct payload competing for one still-pending nonce, admitting exactly one', async () => {
  const { queue, releases, run } = harness();
  // Enqueue a gap head (nonce 1 with expected 0) so it stays pending; competitors at the same nonce
  // are added synchronously before any microtask pump can drain it.
  const primary = queue.enqueue('A', 1n, '0x1-primary', async () => run('A', 1n));
  const competitors = Array.from({ length: 5 }, (_unused, index) =>
    queue.enqueue('A', 1n, `0x1-rival-${index}`, async () => run('A', 1n)),
  );
  for (const rival of competitors) {
    await assert.rejects(rival, (error: JsonAny) => error.code === 'NONCE_ALREADY_QUEUED');
  }
  // Fill the gap so the single admitted primary drains.
  const zero = queue.enqueue('A', 0n, '0x0', async () => run('A', 0n));
  assert.deepEqual(await Promise.all([zero, primary]), ['A:0', 'A:1']);
  assert.deepEqual(releases.get('A'), [0n, 1n]);
});

test('holds every waiter behind a persistent gap and evicts them all with NONCE_GAP_TIMEOUT', async () => {
  const { queue, releases, fireDeadline, run } = harness();
  // Nonce 0 (the head) never arrives; nonces 1..4 pile up behind the gap.
  const waiters = [1n, 2n, 3n, 4n].map(nonce =>
    queue.enqueue('A', nonce, `0x${nonce}`, async () => run('A', nonce)),
  );
  await flush();
  fireDeadline();
  for (const waiter of waiters) {
    await assert.rejects(waiter, (error: JsonAny) => error.code === 'NONCE_GAP_TIMEOUT');
  }
  assert.equal(releases.get('A'), undefined);
});

test('releases all gap-waiters in nonce order once the missing head fills before the deadline', async () => {
  const { queue, releases, timers, run } = harness();
  const waiters = [3n, 1n, 2n].map(nonce =>
    queue.enqueue('A', nonce, `0x${nonce}`, async () => run('A', nonce)),
  );
  await flush();
  const head = queue.enqueue('A', 0n, '0x0', async () => run('A', 0n));
  await Promise.all([head, ...waiters]);
  assert.deepEqual(releases.get('A'), [0n, 1n, 2n, 3n]);
  // The gap deadline armed while the head was missing must have been cancelled once it filled.
  assert.equal(timers.every((timer: JsonAny) => timer.cancelled || !timer.fired), true);
});

test('rejects a nonce that fell below the durable expectation mid-stream without re-running it', async () => {
  const { queue, releases, nextExpected, run } = harness();
  assert.equal(await queue.enqueue('A', 0n, '0x0', async () => run('A', 0n)), 'A:0');
  assert.equal(await queue.enqueue('A', 1n, '0x1', async () => run('A', 1n)), 'A:1');
  // The signer has durably consumed nonces 0 and 1; a late resend of nonce 0 is stale.
  assert.equal(nextExpected.get('A'), 2n);
  await assert.rejects(
    queue.enqueue('A', 0n, '0x0-late', async () => run('A', 0n)),
    (error: JsonAny) => error.code === 'NONCE_TOO_LOW',
  );
  // The stale resend never re-ran the already-consumed nonce.
  assert.deepEqual(releases.get('A'), [0n, 1n]);
});

test('continues at the durable cursor across a simulated restart without re-opening a filled gap', async () => {
  // The durable expected-nonce oracle (the store) survives a restart; the in-memory queue does not.
  const nextExpected = new Map<string, bigint>();
  const releases = new Map<string, bigint[]>();
  const record = (signer: string, nonce: bigint) => {
    const list = releases.get(signer) ?? [];
    list.push(nonce);
    releases.set(signer, list);
  };
  const run = (signer: string, nonce: bigint) => {
    record(signer, nonce);
    nextExpected.set(signer, nonce + 1n);
    return `${signer}:${nonce}`;
  };
  const options = {
    expectedNonce: (signer: string) => nextExpected.get(signer) ?? 0n,
    gapDeadlineMs: 1_000,
    scheduleTimeout: (callback: () => void) => ({ callback }),
    cancelTimeout: () => {},
  };

  const first = new NonceOrderedQueue(options);
  assert.equal(await first.enqueue('A', 0n, '0x0', async () => run('A', 0n)), 'A:0');
  assert.equal(await first.enqueue('A', 1n, '0x1', async () => run('A', 1n)), 'A:1');
  assert.equal(nextExpected.get('A'), 2n);

  // Restart: a fresh queue instance (empty in-memory state) reads the surviving durable cursor.
  const restarted = new NonceOrderedQueue(options);
  // A stale resend below the durable expectation is rejected, not replayed.
  await assert.rejects(
    restarted.enqueue('A', 0n, '0x0-restart', async () => run('A', 0n)),
    (error: JsonAny) => error.code === 'NONCE_TOO_LOW',
  );
  // The next in-order nonce releases immediately with no re-opened gap below it.
  assert.equal(await restarted.enqueue('A', 2n, '0x2', async () => run('A', 2n)), 'A:2');
  assert.equal(await restarted.enqueue('A', 3n, '0x3', async () => run('A', 3n)), 'A:3');
  assert.deepEqual(releases.get('A'), [0n, 1n, 2n, 3n]);
});

test('releases immediately at a non-zero adopted baseline nonce', async () => {
  const { queue, releases, nextExpected, run } = harness();
  // Model an adopted signer whose earlier nonces were consumed on-chain before this process started.
  nextExpected.set('A', 7n);
  assert.equal(await queue.enqueue('A', 7n, '0x7', async () => run('A', 7n)), 'A:7');
  assert.equal(await queue.enqueue('A', 8n, '0x8', async () => run('A', 8n)), 'A:8');
  assert.deepEqual(releases.get('A'), [7n, 8n]);
});

test('drains a high-volume seeded shuffle across signers with no drops, dupes, deadlock, or reorder', async () => {
  const { queue, releases, run } = harness();
  const rand = mulberry32(0x1234abcd);
  const signers = ['A', 'B', 'C', 'D', 'E'];
  const perSigner = 120; // 600 total transactions
  const jobs: { signer: string; nonce: bigint }[] = [];
  for (const signer of signers) {
    for (let nonce = 0; nonce < perSigner; nonce += 1) jobs.push({ signer, nonce: BigInt(nonce) });
  }
  const shuffled = shuffle(jobs, rand);
  const promises = shuffled.map(job =>
    queue.enqueue(job.signer, job.nonce, `0x${job.signer}-${job.nonce}`, async () => run(job.signer, job.nonce)),
  );
  const values = await Promise.all(promises);

  // No drops / no dupes: every enqueued job resolved with its unique value exactly once.
  assert.equal(values.length, shuffled.length);
  const expectedValues = new Set(shuffled.map(job => `${job.signer}:${job.nonce}`));
  assert.deepEqual(new Set(values), expectedValues);
  // Correct final per-signer order: strictly ascending 0..perSigner-1, complete, no repeats.
  for (const signer of signers) {
    assert.deepEqual(
      releases.get(signer),
      Array.from({ length: perSigner }, (_unused, index) => BigInt(index)),
      `signer ${signer} released out of order`,
    );
  }
});

test('preserves ordering when new out-of-order enqueues race an in-flight admission draining', async () => {
  const { queue, releases, nextExpected } = harness();
  const gate = deferred();
  const asyncRun = (signer: string, nonce: bigint, hold?: Promise<unknown>) =>
    queue.enqueue(signer, nonce, `0x${signer}-${nonce}`, async () => {
      if (hold !== undefined) await hold;
      const list = releases.get(signer) ?? [];
      list.push(nonce);
      releases.set(signer, list);
      nextExpected.set(signer, nonce + 1n);
      return `${signer}:${nonce}`;
    });

  // Admit nonce 0 and hold it in-flight (active) so the signer is mid-drain.
  const zero = asyncRun('A', 0n, gate.promise);
  await flush();
  assert.deepEqual(releases.get('A'), undefined); // still awaiting the gate

  // While nonce 0 is active, a burst of successors arrives out of order concurrently.
  const later = [4n, 2n, 3n, 1n, 5n].map(nonce => asyncRun('A', nonce));
  await flush();
  // None may jump ahead of the still-active head.
  assert.deepEqual(releases.get('A'), undefined);

  gate.resolve();
  await Promise.all([zero, ...later]);
  assert.deepEqual(releases.get('A'), [0n, 1n, 2n, 3n, 4n, 5n]);
});

test('keeps signers independent: a gap-blocked signer never stalls others under load', async () => {
  const { queue, releases, run } = harness();
  // Signer A is permanently blocked on a missing head (nonce 0 never arrives).
  const blocked = [1n, 2n, 3n].map(nonce => queue.enqueue('A', nonce, `0xA-${nonce}`, async () => run('A', nonce)));
  // Signers B and C are complete and must fully drain regardless of A.
  const rand = mulberry32(99);
  const others: JsonAny[] = [];
  for (const signer of ['B', 'C']) {
    for (const nonce of shuffle([0n, 1n, 2n, 3n, 4n], rand)) {
      others.push(queue.enqueue(signer, nonce, `0x${signer}-${nonce}`, async () => run(signer, nonce)));
    }
  }
  await Promise.all(others);
  assert.deepEqual(releases.get('B'), [0n, 1n, 2n, 3n, 4n]);
  assert.deepEqual(releases.get('C'), [0n, 1n, 2n, 3n, 4n]);
  // A is still parked behind its gap; its waiters have neither released nor rejected.
  assert.equal(releases.get('A'), undefined);
  let settled = false;
  void Promise.race(blocked).then(
    () => (settled = true),
    () => (settled = true),
  );
  await flush();
  assert.equal(settled, false);
});
