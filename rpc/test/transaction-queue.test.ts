import assert from 'node:assert/strict';
import test from 'node:test';

import { NonceOrderedQueue } from '../../dist/rpc/transaction-queue.js';

// The queue is signer/nonce-agnostic coordination over opaque work; test doubles for the released
// work, timers, and expected-nonce oracle are deliberately loosely shaped, mirroring the runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonAny = any;

function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

function harness(overrides: JsonAny = {}) {
  const nextExpected = new Map<string, bigint>();
  const timers: JsonAny[] = [];
  const order: JsonAny[] = [];
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
  // Release a transaction: record its nonce and, on success, advance the signer's expected nonce so
  // the queue treats the nonce as durably consumed on the next pump.
  const run = (signer: string, nonce: bigint, options: JsonAny = {}) => {
    order.push(nonce);
    if (options.fail) throw Object.assign(new Error('processing failed'), { code: 'PROCESSING_FAILED' });
    nextExpected.set(signer, nonce + 1n);
    return nonce;
  };
  const fireDeadline = () => {
    const timer = [...timers].reverse().find(candidate => !candidate.cancelled && !candidate.fired);
    assert.ok(timer !== undefined, 'expected an armed deadline timer');
    timer.fired = true;
    timer.callback();
  };
  return { queue, nextExpected, timers, order, run, fireDeadline };
}

test('releases a signer batch strictly in ascending nonce order despite reversed enqueue', async () => {
  const { queue, order, run } = harness();
  const results = [
    queue.enqueue('A', 2n, '0xa2', async () => run('A', 2n)),
    queue.enqueue('A', 0n, '0xa0', async () => run('A', 0n)),
    queue.enqueue('A', 1n, '0xa1', async () => run('A', 1n)),
  ];
  assert.deepEqual(await Promise.all(results), [2n, 0n, 1n]);
  assert.deepEqual(order, [0n, 1n, 2n]);
});

test('waits at the durable expected nonce for a lower nonce arriving a full event-loop turn later', async () => {
  // Reproduces the cross-tick race: the durable expected nonce is 0, nonce 1 is enqueued first, an
  // entire macrotask elapses, then nonce 0 arrives. The cursor must stay pinned to the durable
  // expectation (0) so nonce 1 waits rather than releasing early and rejecting nonce 0 as too low.
  const { queue, order, run } = harness();
  const one = queue.enqueue('A', 1n, '0xa1', async () => run('A', 1n));
  await flush();
  const zero = queue.enqueue('A', 0n, '0xa0', async () => run('A', 0n));
  assert.deepEqual(await Promise.all([zero, one]), [0n, 1n]);
  assert.deepEqual(order, [0n, 1n]);
});

test('holds a lone future nonce for the gap deadline instead of releasing ahead of the durable expectation', async () => {
  // A single transaction whose nonce sits above the signer's durable expected nonce is a gap, not a
  // releasable head: it must wait for the missing predecessors (or the gap deadline) rather than
  // release immediately, which was the cross-tick defect's cousin.
  const { queue, order, fireDeadline, timers } = harness();
  const future = queue.enqueue('A', 5n, '0xa5', async () => 5n);
  await flush();
  assert.deepEqual(order, []);
  assert.equal(timers.some((timer: JsonAny) => !timer.cancelled), true);
  fireDeadline();
  await assert.rejects(future, (error: JsonAny) => error.code === 'NONCE_GAP_TIMEOUT');
});

test('serializes one transaction per signer at a time', async () => {
  const { queue, order, nextExpected } = harness();
  const first = deferred();
  const started: JsonAny[] = [];
  const p0 = queue.enqueue('A', 0n, '0xa0', async () => {
    started.push(0n);
    await first.promise;
    order.push(0n);
    nextExpected.set('A', 1n);
    return 0n;
  });
  const p1 = queue.enqueue('A', 1n, '0xa1', async () => {
    started.push(1n);
    order.push(1n);
    nextExpected.set('A', 2n);
    return 1n;
  });
  await flush();
  // The second transaction must not start until the first has settled.
  assert.deepEqual(started, [0n]);
  first.resolve();
  assert.deepEqual(await Promise.all([p0, p1]), [0n, 1n]);
  assert.deepEqual(order, [0n, 1n]);
});

test('processes independent signers concurrently without cross-blocking', async () => {
  const { queue, nextExpected } = harness();
  const held = deferred();
  const slow = queue.enqueue('A', 0n, '0xa0', async () => {
    await held.promise;
    nextExpected.set('A', 1n);
    return 'A0';
  });
  const fast = queue.enqueue('B', 0n, '0xb0', async () => {
    nextExpected.set('B', 1n);
    return 'B0';
  });
  // Signer B completes while signer A is still blocked.
  assert.equal(await fast, 'B0');
  held.resolve();
  assert.equal(await slow, 'A0');
});

test('fails a transaction whose predecessor nonce never arrives after the gap deadline', async () => {
  const { queue, order, run, fireDeadline, timers } = harness();
  const zero = queue.enqueue('A', 0n, '0xa0', async () => run('A', 0n));
  const two = queue.enqueue('A', 2n, '0xa2', async () => run('A', 2n));
  assert.equal(await zero, 0n);
  await flush();
  // Nonce 1 is missing, so nonce 2 is held and a deadline is armed rather than racing ahead.
  assert.equal(order.length, 1);
  assert.equal(timers.some((timer: JsonAny) => !timer.cancelled), true);
  fireDeadline();
  await assert.rejects(two, (error: JsonAny) => error.code === 'NONCE_GAP_TIMEOUT');
  assert.deepEqual(order, [0n]);
});

test('releases a held transaction once the missing predecessor fills the gap before the deadline', async () => {
  const { queue, order, run, timers } = harness();
  const zero = queue.enqueue('A', 0n, '0xa0', async () => run('A', 0n));
  const two = queue.enqueue('A', 2n, '0xa2', async () => run('A', 2n));
  assert.equal(await zero, 0n);
  await flush();
  const one = queue.enqueue('A', 1n, '0xa1', async () => run('A', 1n));
  assert.deepEqual(await Promise.all([one, two]), [1n, 2n]);
  assert.deepEqual(order, [0n, 1n, 2n]);
  // The gap deadline that was armed for the missing nonce must have been cancelled.
  assert.equal(
    timers.every((timer: JsonAny) => timer.cancelled || timer.fired === undefined || !timer.fired),
    true,
  );
});

test('joins a concurrent resend of an already-queued hash to the same promise', async () => {
  const { queue, order, run } = harness();
  const first = queue.enqueue('A', 0n, '0xa0', async () => run('A', 0n));
  const rejoined = queue.enqueue('A', 0n, '0xa0', async () => run('A', 0n));
  assert.equal(first, rejoined);
  assert.equal(await first, 0n);
  // The duplicate resend never triggers a second release.
  assert.deepEqual(order, [0n]);
});

test('rejects a different payload competing for an already-queued nonce', async () => {
  const { queue } = harness();
  const first = queue.enqueue('A', 0n, '0xa0-first', async () => 'first');
  const conflicting = queue.enqueue('A', 0n, '0xa0-second', async () => 'second');
  await assert.rejects(conflicting, (error: JsonAny) => error.code === 'NONCE_ALREADY_QUEUED');
  assert.equal(await first, 'first');
});

test('rejects a nonce already consumed by the signer as too low', async () => {
  const { queue, nextExpected } = harness();
  nextExpected.set('A', 5n);
  const stale = queue.enqueue('A', 3n, '0xa3', async () => 'stale');
  await assert.rejects(stale, (error: JsonAny) => error.code === 'NONCE_TOO_LOW');
});

test('does not advance past a failed transaction and times out its dependents', async () => {
  const { queue, order, run, fireDeadline } = harness();
  const zero = queue.enqueue('A', 0n, '0xa0', async () => run('A', 0n, { fail: true }));
  const one = queue.enqueue('A', 1n, '0xa1', async () => run('A', 1n));
  await assert.rejects(zero, (error: JsonAny) => error.code === 'PROCESSING_FAILED');
  await flush();
  // A failed nonce 0 is not consumed, so nonce 1 is held and eventually times out on the gap.
  fireDeadline();
  await assert.rejects(one, (error: JsonAny) => error.code === 'NONCE_GAP_TIMEOUT');
  assert.deepEqual(order, [0n]);
});

test('re-releases a signer after its queue fully drains', async () => {
  const { queue, order, run } = harness();
  assert.equal(await queue.enqueue('A', 0n, '0xa0', async () => run('A', 0n)), 0n);
  // A later transaction for the same signer, arriving after the queue drained, still releases.
  assert.equal(await queue.enqueue('A', 1n, '0xa1', async () => run('A', 1n)), 1n);
  assert.deepEqual(order, [0n, 1n]);
});

test('rejects invalid construction options', () => {
  assert.throws(() => new NonceOrderedQueue({} as JsonAny), /Invalid nonce-ordered queue options/);
  assert.throws(
    () => new NonceOrderedQueue({ expectedNonce: () => 0n, gapDeadlineMs: 0 } as JsonAny),
    /Invalid nonce-ordered queue options/,
  );
  assert.throws(
    () =>
      new NonceOrderedQueue({
        expectedNonce: () => 0n,
        gapDeadlineMs: 1_000,
        scheduleTimeout: 'nope',
      } as JsonAny),
    /Invalid nonce-ordered queue timer hooks/,
  );
});
