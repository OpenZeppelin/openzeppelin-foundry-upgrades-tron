import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalStatePath } from './state-lock.js';

const STORE_VERSION = 1;
const CHAIN_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** One chain's durable state: an arbitrary JSON-serializable record owned by its callers. */
export type ChainState = Record<string, unknown>;

/** The on-disk state root persisted by {@link JsonStore}. */
export interface StoreState {
  version: number;
  chains: Record<string, ChainState>;
}

/** Options accepted by the {@link JsonStore} constructor. */
export interface JsonStoreOptions {
  fileSystem?: typeof fs;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return value === undefined ? (undefined as T) : structuredClone(value);
}

function validateChainIdentity(chainIdentity: unknown): string {
  if (
    typeof chainIdentity !== 'string' ||
    !CHAIN_IDENTITY_PATTERN.test(chainIdentity) ||
    FORBIDDEN_KEYS.has(chainIdentity)
  ) {
    throw new Error('Invalid chain identity');
  }
  return chainIdentity;
}

function validateState(state: unknown): StoreState {
  if (!isObject(state)) {
    throw new Error('Invalid state root');
  }
  if (state.version !== STORE_VERSION) {
    throw new Error(`Unsupported state version; expected ${STORE_VERSION}`);
  }
  if (!isObject(state.chains)) {
    throw new Error('Invalid state chains');
  }

  for (const [chainIdentity, chain] of Object.entries(state.chains)) {
    validateChainIdentity(chainIdentity);
    if (!isObject(chain)) {
      throw new Error(`Invalid state for chain identity ${chainIdentity}`);
    }
  }
  return state as unknown as StoreState;
}

class JsonStore {
  declare filePath: string;
  declare canonicalPath: string;
  declare fs: typeof fs;
  declare assertWritable: (() => void) | undefined;

  constructor(filePath: string, options: JsonStoreOptions = {}) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error('State file path is required');
    }
    if (!isObject(options)) {
      throw new Error('Invalid store options');
    }

    this.filePath = path.resolve(filePath);
    // Read and write the same canonicalized (realpath) target that the state lock hashes, so a
    // symlinked or otherwise-aliased state path cannot resolve to a different file than the lock
    // protects (which would let a second adapter believe it holds an exclusive lock while writing a
    // separate file, or replace the symlink with a fresh regular file on atomic rename).
    this.canonicalPath = canonicalStatePath(filePath);
    // `isObject` narrows `options` to `Record<string, unknown>`, which would otherwise
    // discard the specific `fileSystem` field type; re-assert the declared option shape here.
    this.fs = (options as JsonStoreOptions).fileSystem ?? fs;
    this.assertWritable = undefined;
    this._readState();
  }

  // Bind an assertion (typically the state-lock ownership check) that is re-evaluated before
  // every durable mutation, so a write cannot commit after the exclusive lock has been lost.
  bindLockAssertion(assertWritable: () => void): void {
    if (typeof assertWritable !== 'function') {
      throw new Error('State lock assertion must be a function');
    }
    this.assertWritable = assertWritable;
  }

  read(): StoreState {
    return clone(this._readState());
  }

  readChain(chainIdentity: string): ChainState | undefined {
    const key = validateChainIdentity(chainIdentity);
    const chain: ChainState | undefined = this._readState().chains[key];
    return clone(chain);
  }

  transaction<T>(chainIdentity: string, callback: (chainState: ChainState) => T): T {
    const key = validateChainIdentity(chainIdentity);
    if (typeof callback !== 'function') {
      throw new Error('State transaction callback is required');
    }

    const state = clone(this._readState());
    if (!Object.prototype.hasOwnProperty.call(state.chains, key)) {
      state.chains[key] = {};
    }

    const result = callback(state.chains[key]);
    if (
      result !== null &&
      (typeof result === 'object' || typeof result === 'function') &&
      typeof (result as { then?: unknown }).then === 'function'
    ) {
      Promise.resolve(result as unknown as Promise<unknown>).catch(() => {});
      throw new Error('State transaction callbacks must be synchronous');
    }
    const clonedResult = clone(result);
    validateState(state);
    // Re-assert lock ownership immediately before committing, so a mutation cannot land after the
    // exclusive state lock has been released, lost, or taken over by another adapter process.
    if (this.assertWritable !== undefined) {
      this.assertWritable();
    }
    this._writeState(state);
    return clonedResult;
  }

  private _readState(): StoreState {
    if (!this.fs.existsSync(this.canonicalPath)) {
      return { version: STORE_VERSION, chains: {} };
    }

    let state: unknown;
    try {
      state = JSON.parse(this.fs.readFileSync(this.canonicalPath, 'utf8'));
    } catch (error) {
      throw new Error(`Unable to parse state file: ${(error as Error).message}`, { cause: error });
    }
    return validateState(state);
  }

  private _writeState(state: StoreState): void {
    const directory = path.dirname(this.canonicalPath);
    const temporaryPath = path.join(
      directory,
      `.${path.basename(this.canonicalPath)}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`,
    );
    const contents = `${JSON.stringify(state, null, 2)}\n`;
    let descriptor: number | undefined;

    this.fs.mkdirSync(directory, { recursive: true });
    try {
      descriptor = this.fs.openSync(temporaryPath, 'wx', 0o600);
      this.fs.writeFileSync(descriptor, contents, 'utf8');
      this.fs.fsyncSync(descriptor);
      this.fs.closeSync(descriptor);
      descriptor = undefined;
      this.fs.renameSync(temporaryPath, this.canonicalPath);
      this._syncDirectory(directory);
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          this.fs.closeSync(descriptor);
        } catch {}
      }
      try {
        this.fs.rmSync(temporaryPath, { force: true });
      } catch {}
      throw error;
    }
  }

  private _syncDirectory(directory: string): void {
    let descriptor: number | undefined;
    try {
      descriptor = this.fs.openSync(directory, 'r');
      this.fs.fsyncSync(descriptor);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR') {
        throw error;
      }
    } finally {
      if (descriptor !== undefined) {
        this.fs.closeSync(descriptor);
      }
    }
  }
}

export { JsonStore, STORE_VERSION, validateChainIdentity };
