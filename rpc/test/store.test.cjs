const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { acquireStateLock, assertStateLockHeld } = require('../state-lock.cjs');
const { JsonStore, STORE_VERSION } = require('../store.cjs');

function temporaryState(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-tron-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'state.json');
}

test('commits state through a same-directory atomic rename', t => {
  const statePath = temporaryState(t);
  const renames = [];
  const fileSystem = {
    ...fs,
    renameSync(source, destination) {
      renames.push([source, destination]);
      return fs.renameSync(source, destination);
    },
  };
  const store = new JsonStore(statePath, { fileSystem });

  store.transaction('chain-a', chain => {
    chain.value = 17;
  });

  // Writes target the canonicalized (realpath) state path the state lock also hashes.
  const canonicalPath = path.join(fs.realpathSync(path.dirname(statePath)), 'state.json');
  assert.equal(renames.length, 1);
  assert.equal(path.dirname(renames[0][0]), path.dirname(canonicalPath));
  assert.match(path.basename(renames[0][0]), /^\.state\.json\..+\.tmp$/);
  assert.equal(renames[0][1], canonicalPath);
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), {
    version: STORE_VERSION,
    chains: { 'chain-a': { value: 17 } },
  });
  assert.deepEqual(fs.readdirSync(path.dirname(statePath)), ['state.json']);
});

test('refuses corrupt, truncated, and unsupported state instead of resetting it', t => {
  const cases = [
    ['{', /parse/i],
    [JSON.stringify({ version: STORE_VERSION + 1, chains: {} }), /version/i],
    [JSON.stringify({ version: STORE_VERSION, chains: [] }), /chains/i],
  ];

  for (const [contents, expected] of cases) {
    const statePath = temporaryState(t);
    fs.writeFileSync(statePath, contents);
    assert.throws(() => new JsonStore(statePath), expected);
    assert.equal(fs.readFileSync(statePath, 'utf8'), contents);
  }
});

test('isolates chain state and returns defensive copies', t => {
  const store = new JsonStore(temporaryState(t));
  store.transaction('chain-a', chain => {
    chain.marker = 'a';
  });
  store.transaction('chain-b', chain => {
    chain.marker = 'b';
  });

  const first = store.readChain('chain-a');
  first.marker = 'mutated';
  assert.deepEqual(store.readChain('chain-a'), { marker: 'a' });
  assert.deepEqual(store.readChain('chain-b'), { marker: 'b' });
  assert.equal(store.readChain('chain-c'), undefined);
});

test('reloads disk state for transactions made by a second instance', t => {
  const statePath = temporaryState(t);
  const first = new JsonStore(statePath);
  const second = new JsonStore(statePath);

  first.transaction('chain-a', chain => {
    chain.first = true;
  });
  second.transaction('chain-a', chain => {
    chain.second = true;
  });

  assert.deepEqual(new JsonStore(statePath).readChain('chain-a'), { first: true, second: true });
});

test('does not commit a transaction whose callback throws', t => {
  const statePath = temporaryState(t);
  const store = new JsonStore(statePath);
  store.transaction('chain-a', chain => {
    chain.stable = true;
  });

  assert.throws(
    () =>
      store.transaction('chain-a', chain => {
        chain.stable = false;
        throw new Error('stop');
      }),
    /stop/,
  );
  assert.deepEqual(new JsonStore(statePath).readChain('chain-a'), { stable: true });
});

test('does not commit before validating and cloning the callback result', t => {
  const statePath = temporaryState(t);
  const store = new JsonStore(statePath);
  store.transaction('chain-a', chain => {
    chain.stable = true;
  });

  assert.throws(() =>
    store.transaction('chain-a', chain => {
      chain.uncloneable = true;
      return () => {};
    }),
  );
  assert.deepEqual(new JsonStore(statePath).readChain('chain-a'), { stable: true });
});

test('rejects asynchronous transaction callbacks without committing their draft', t => {
  const statePath = temporaryState(t);
  const store = new JsonStore(statePath);
  store.transaction('chain-a', chain => {
    chain.stable = true;
  });

  assert.throws(
    () =>
      store.transaction('chain-a', chain => {
        chain.asynchronous = true;
        return Promise.resolve('result');
      }),
    /synchronous/i,
  );
  assert.deepEqual(new JsonStore(statePath).readChain('chain-a'), { stable: true });
});

test('writes through a symlinked state path to the canonical target the lock hashes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-tron-store-symlink-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const realPath = path.join(directory, 'real-state.json');
  const aliasPath = path.join(directory, 'alias-state.json');

  const real = new JsonStore(realPath);
  real.transaction('chain-a', chain => {
    chain.value = 1;
  });
  fs.symlinkSync(realPath, aliasPath);

  // A store opened through the symlink reads and writes the same canonical file, and the write
  // does not replace the symlink with a fresh regular file.
  const alias = new JsonStore(aliasPath);
  assert.deepEqual(alias.readChain('chain-a'), { value: 1 });
  alias.transaction('chain-a', chain => {
    chain.value = 2;
  });
  assert.deepEqual(new JsonStore(realPath).readChain('chain-a'), { value: 2 });
  assert.equal(fs.lstatSync(aliasPath).isSymbolicLink(), true);

  // The lock hashes the same canonical path, so a second adapter via the alias is refused.
  const lock = await acquireStateLock(realPath);
  t.after(() => lock.release());
  await assert.rejects(acquireStateLock(aliasPath), /state is already locked/i);
});

test('re-asserts the state lock on every mutation and refuses to write once it is lost', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-tron-store-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, 'state.json');

  const lock = await acquireStateLock(statePath);
  const store = new JsonStore(statePath);
  store.bindLockAssertion(() => assertStateLockHeld(lock, statePath));

  // A mutation while the lock is held commits normally.
  store.transaction('chain-a', chain => {
    chain.value = 1;
  });
  assert.deepEqual(new JsonStore(statePath).readChain('chain-a'), { value: 1 });

  // After the lock is released, every subsequent mutation is refused before it can write.
  await lock.release();
  assert.throws(
    () =>
      store.transaction('chain-a', chain => {
        chain.value = 2;
      }),
    /no longer held/i,
  );
  assert.deepEqual(new JsonStore(statePath).readChain('chain-a'), { value: 1 });
});

test('rejects unsafe chain identities', t => {
  const store = new JsonStore(temporaryState(t));
  for (const chain of ['', ' chain', '__proto__', 'constructor']) {
    assert.throws(() => store.transaction(chain, () => {}), /chain identity/i);
  }
});
