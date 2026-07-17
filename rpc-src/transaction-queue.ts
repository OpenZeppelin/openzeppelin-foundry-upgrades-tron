// A per-signer, nonce-ordered admission queue. Source transactions from one signer are released for
// processing strictly one at a time in ascending nonce order, so a dependent transaction can never
// build against a predecessor whose predicted->actual address mapping has not yet been published.
//
// A transaction is released only when its nonce equals the signer's next expected nonce. A
// transaction whose nonce is ahead of the expected nonce waits until the gap is filled by the
// missing predecessor or a configurable deadline elapses, which fails it deterministically instead
// of racing ahead. A transaction whose nonce is below the expected nonce (already consumed by a
// confirmed or reverted predecessor) is rejected deterministically. Signers are fully independent.

// The queued work and its resolved value are opaque to the queue: it only serializes the callbacks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonAny = any;

/** A pending, not-yet-released transaction held for one signer. */
interface QueueEntry {
  hash: string;
  nonce: bigint;
  run: () => Promise<JsonAny>;
  resolve: (value: JsonAny) => void;
  reject: (reason: unknown) => void;
}

/** The mutable per-signer coordination state. */
interface SignerState {
  pending: Map<string, QueueEntry>;
  cursor: bigint | undefined;
  active: boolean;
  deadlineHandle: JsonAny;
}

/** Options accepted by the {@link NonceOrderedQueue} constructor. */
export interface NonceOrderedQueueOptions {
  expectedNonce: (signer: string) => bigint;
  gapDeadlineMs: number;
  scheduleTimeout?: (callback: () => void, ms: number) => JsonAny;
  cancelTimeout?: (handle: JsonAny) => void;
}

function queueError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function minNonce(pending: Map<string, QueueEntry>): bigint | undefined {
  let smallest: bigint | undefined;
  for (const entry of pending.values()) {
    if (smallest === undefined || entry.nonce < smallest) smallest = entry.nonce;
  }
  return smallest;
}

class NonceOrderedQueue {
  declare private expectedNonce: (signer: string) => bigint;
  declare private gapDeadlineMs: number;
  declare private scheduleTimeout: (callback: () => void, ms: number) => JsonAny;
  declare private cancelTimeout: (handle: JsonAny) => void;
  declare private signers: Map<string, SignerState>;
  declare private byHash: Map<string, Promise<JsonAny>>;

  constructor(options: NonceOrderedQueueOptions) {
    if (
      options === null ||
      typeof options !== 'object' ||
      typeof options.expectedNonce !== 'function' ||
      !Number.isSafeInteger(options.gapDeadlineMs) ||
      options.gapDeadlineMs < 1
    ) {
      throw new Error('Invalid nonce-ordered queue options');
    }
    if (
      (options.scheduleTimeout !== undefined && typeof options.scheduleTimeout !== 'function') ||
      (options.cancelTimeout !== undefined && typeof options.cancelTimeout !== 'function')
    ) {
      throw new Error('Invalid nonce-ordered queue timer hooks');
    }
    this.expectedNonce = options.expectedNonce;
    this.gapDeadlineMs = options.gapDeadlineMs;
    this.scheduleTimeout =
      options.scheduleTimeout ??
      ((callback, ms) => {
        const handle = setTimeout(callback, ms);
        if (typeof (handle as JsonAny)?.unref === 'function') (handle as JsonAny).unref();
        return handle;
      });
    this.cancelTimeout = options.cancelTimeout ?? (handle => clearTimeout(handle as JsonAny));
    this.signers = new Map();
    this.byHash = new Map();
  }

  // The in-flight-or-waiting promise for a source hash, so a concurrent resend of an already-queued
  // transaction joins the same promise instead of enqueuing a duplicate or bypassing the ordering.
  get(hash: string): Promise<JsonAny> | undefined {
    return this.byHash.get(hash);
  }

  enqueue(signer: string, nonce: bigint, hash: string, run: () => Promise<JsonAny>): Promise<JsonAny> {
    const existing = this.byHash.get(hash);
    if (existing !== undefined) return existing;
    const state = this._signer(signer);
    const key = nonce.toString();
    const conflicting = state.pending.get(key);
    if (conflicting !== undefined && conflicting.hash !== hash) {
      return Promise.reject(
        queueError('NONCE_ALREADY_QUEUED', 'A different transaction is already queued at this nonce'),
      );
    }
    let resolve!: (value: JsonAny) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<JsonAny>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    state.pending.set(key, { hash, nonce, run, resolve, reject });
    this.byHash.set(hash, promise);
    // Defer the first release to a microtask so a synchronous batch of sibling sends is fully
    // enqueued before the signer's next-nonce release decision is taken; without this a
    // reversed-arrival sibling that has not yet been enqueued would be skipped.
    queueMicrotask(() => this._pump(signer));
    return promise;
  }

  private _signer(signer: string): SignerState {
    let state = this.signers.get(signer);
    if (state === undefined) {
      state = { pending: new Map(), cursor: undefined, active: false, deadlineHandle: undefined };
      this.signers.set(signer, state);
    }
    return state;
  }

  private _settle(state: SignerState, entry: QueueEntry, ok: boolean, value: unknown): void {
    this.byHash.delete(entry.hash);
    if (ok) entry.resolve(value);
    else entry.reject(value);
  }

  private _clearDeadline(state: SignerState): void {
    if (state.deadlineHandle !== undefined) {
      this.cancelTimeout(state.deadlineHandle);
      state.deadlineHandle = undefined;
    }
  }

  private _pump(signer: string): void {
    const state = this.signers.get(signer);
    if (state === undefined || state.active) return;

    if (state.cursor === undefined) {
      const smallest = minNonce(state.pending);
      if (smallest === undefined) {
        this._clearDeadline(state);
        this.signers.delete(signer);
        return;
      }
      state.cursor = smallest;
    }
    // Advance the cursor to the durable next expected nonce so consumed nonces (confirmed, or
    // reverted-with-receipt) are never re-released and their now-stale duplicates are rejected.
    const expected = this.expectedNonce(signer);
    if (expected > state.cursor) state.cursor = expected;

    for (const [key, entry] of [...state.pending]) {
      if (entry.nonce < state.cursor) {
        state.pending.delete(key);
        this._settle(state, entry, false, queueError('NONCE_TOO_LOW', 'Transaction nonce is below the next expected nonce'));
      }
    }

    const ready = state.pending.get(state.cursor.toString());
    if (ready !== undefined) {
      this._clearDeadline(state);
      state.pending.delete(state.cursor.toString());
      state.active = true;
      Promise.resolve()
        .then(ready.run)
        .then(
          value => this._afterRun(signer, ready, true, value),
          reason => this._afterRun(signer, ready, false, reason),
        );
      return;
    }

    if (state.pending.size === 0) {
      this._clearDeadline(state);
      this.signers.delete(signer);
      return;
    }
    // A strictly-higher nonce is pending with no releasable predecessor: arm the gap deadline so a
    // permanently-missing predecessor fails the waiters deterministically rather than hanging.
    this._armDeadline(signer, state);
  }

  private _afterRun(signer: string, entry: QueueEntry, ok: boolean, value: unknown): void {
    const state = this.signers.get(signer);
    if (state !== undefined) state.active = false;
    // Settle after clearing active so the resend of a just-settled hash observes a consistent queue.
    if (state !== undefined) this._settle(state, entry, ok, value);
    else this._settle({ pending: new Map(), cursor: undefined, active: false, deadlineHandle: undefined }, entry, ok, value);
    this._pump(signer);
  }

  private _armDeadline(signer: string, state: SignerState): void {
    if (state.deadlineHandle !== undefined) return;
    state.deadlineHandle = this.scheduleTimeout(() => {
      const current = this.signers.get(signer);
      if (current === undefined) return;
      current.deadlineHandle = undefined;
      if (current.active) return;
      const expected = this.expectedNonce(signer);
      if (current.cursor !== undefined && expected > current.cursor) current.cursor = expected;
      if (current.cursor !== undefined && current.pending.has(current.cursor.toString())) {
        this._pump(signer);
        return;
      }
      for (const [key, entry] of [...current.pending]) {
        current.pending.delete(key);
        this._settle(
          current,
          entry,
          false,
          queueError('NONCE_GAP_TIMEOUT', 'Timed out waiting for the preceding transaction nonce'),
        );
      }
      if (current.pending.size === 0) this.signers.delete(signer);
    }, this.gapDeadlineMs);
  }
}

export { NonceOrderedQueue };
