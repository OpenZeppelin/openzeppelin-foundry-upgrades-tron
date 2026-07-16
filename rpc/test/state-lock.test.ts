import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { acquireStateLock, assertStateLockHeld, type StateLockCapability } from '../../dist/rpc/state-lock.js';

const STATE_LOCK_PATH = path.resolve(__dirname, '../../dist/rpc/state-lock.js');

function temporaryDirectory(t: TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-tron-state-lock-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  return directory;
}

async function listen(server: net.Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port }, () => resolve());
  });
  return (server.address() as net.AddressInfo).port;
}

async function close(server: net.Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close(error => (error === undefined ? resolve() : reject(error)));
  });
}

async function freeCandidatePorts(count = 8): Promise<number[]> {
  const servers = Array.from({ length: count }, () => net.createServer());
  const ports: number[] = [];
  try {
    for (const server of servers) {
      ports.push(await listen(server));
    }
  } finally {
    await Promise.all(servers.map(close));
  }
  return ports;
}

async function waitForLine(stream: NodeJS.ReadableStream, timeoutMs = 2_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => finish(new Error('Timed out waiting for child lock')), timeoutMs);

    function finish(error: Error | undefined, line?: string) {
      clearTimeout(timer);
      stream.off('data', onData);
      error === undefined ? resolve(line as string) : reject(error);
    }

    function onData(chunk: Buffer | string) {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline !== -1) {
        finish(undefined, buffer.slice(0, newline));
      }
    }

    stream.on('data', onData);
  });
}

async function eventuallyAcquire(statePath: string, timeoutMs = 2_000): Promise<StateLockCapability> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await acquireStateLock(statePath);
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}

test('holds one kernel-backed lock per canonical state path', async t => {
  const statePath = path.join(temporaryDirectory(t), 'adapter-state.json');
  const lock = await acquireStateLock(statePath);
  t.after(() => lock.release());

  assert.match(lock.ownerId, /^[0-9a-f]{64}$/);
  assert.ok(lock.port >= 49_152 && lock.port <= 65_535);
  assert.equal(lock.assertHeld(), lock);
  assert.equal(assertStateLockHeld(lock), lock);
  await assert.rejects(acquireStateLock(statePath), /state is already locked/i);
});

test('canonicalizes relative and symlinked aliases before locking', async t => {
  const directory = temporaryDirectory(t);
  const realDirectory = path.join(directory, 'real');
  const aliasDirectory = path.join(directory, 'alias');
  fs.mkdirSync(realDirectory);
  fs.symlinkSync(realDirectory, aliasDirectory, process.platform === 'win32' ? 'junction' : 'dir');

  const statePath = path.join(realDirectory, 'nested', 'adapter-state.json');
  const relativePath = path.relative(process.cwd(), statePath);
  const symlinkPath = path.join(aliasDirectory, 'nested', 'adapter-state.json');
  const lock = await acquireStateLock(statePath);
  t.after(() => lock.release());

  await assert.rejects(acquireStateLock(relativePath), /state is already locked/i);
  await assert.rejects(acquireStateLock(symlinkPath), /state is already locked/i);
});

test('uses the next candidate when different states deterministically collide', async t => {
  const directory = temporaryDirectory(t);
  const ports = await freeCandidatePorts(15);
  const firstCandidates = ports.slice(0, 8);
  const secondCandidates = [ports[0], ...ports.slice(8)];
  const first = await acquireStateLock(path.join(directory, 'first.json'), { candidatePorts: firstCandidates });
  const second = await acquireStateLock(path.join(directory, 'second.json'), { candidatePorts: secondCandidates });
  t.after(() => Promise.all([first.release(), second.release()]));

  assert.deepEqual(first.ports, firstCandidates);
  assert.deepEqual(second.ports, secondCandidates.slice(1));
  assert.equal(first.port, firstCandidates[0]);
  assert.equal(second.port, secondCandidates[1]);
  assertStateLockHeld(first);
  assertStateLockHeld(second);
});

test('refuses a duplicate after changing foreign occupancy exposes an earlier candidate', async t => {
  const statePath = path.join(temporaryDirectory(t), 'adapter-state.json');
  const candidatePorts = await freeCandidatePorts();
  const foreignSockets = new Set<net.Socket>();
  const foreign = net.createServer(socket => {
    foreignSockets.add(socket);
    socket.on('close', () => foreignSockets.delete(socket));
    socket.end('foreign-listener\n');
  });
  await listen(foreign, candidatePorts[0]);

  const first = await acquireStateLock(statePath, { candidatePorts, probeTimeoutMs: 50 });
  assert.equal(first.port, candidatePorts[1]);
  for (const socket of foreignSockets) {
    socket.destroy();
  }
  await close(foreign);

  await assert.rejects(acquireStateLock(statePath, { candidatePorts, probeTimeoutMs: 50 }), /state is already locked/i);

  await first.release();
  const reacquired = await acquireStateLock(statePath, { candidatePorts, probeTimeoutMs: 50 });
  t.after(() => reacquired.release());
  assert.equal(reacquired.port, candidatePorts[0]);
});

test('grants exactly one capability to simultaneous same-state contenders', async t => {
  const statePath = path.join(temporaryDirectory(t), 'adapter-state.json');
  const candidatePorts = await freeCandidatePorts();
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () => acquireStateLock(statePath, { candidatePorts, probeTimeoutMs: 50 })),
  );
  const acquired = results.filter(result => result.status === 'fulfilled').map(result => result.value);
  const refused = results.filter(result => result.status === 'rejected');
  t.after(() => Promise.all(acquired.map(lock => lock.release())));

  assert.equal(acquired.length, 1);
  assert.equal(refused.length, 5);
  for (const result of refused) {
    assert.match(result.reason.message, /state is already locked/i);
  }
  assertStateLockHeld(acquired[0]);
});

test('release invalidates the authentic capability and permits reacquisition', async t => {
  const statePath = path.join(temporaryDirectory(t), 'adapter-state.json');
  const lock = await acquireStateLock(statePath);

  assert.throws(
    () => assertStateLockHeld({ ownerId: lock.ownerId, port: lock.port, assertHeld() {}, release() {} }),
    /authentic state lock capability/i,
  );

  await lock.release();
  assert.throws(() => lock.assertHeld(), /state lock is no longer held/i);
  assert.throws(() => assertStateLockHeld(lock), /state lock is no longer held/i);

  const reacquired = await acquireStateLock(statePath);
  t.after(() => reacquired.release());
  assert.notEqual(reacquired.ownerId, lock.ownerId);
  assertStateLockHeld(reacquired);
});

test('the kernel releases the lock when its owner process crashes', async t => {
  const statePath = path.join(temporaryDirectory(t), 'adapter-state.json');
  const childScript = `
    const { acquireStateLock } = require(${JSON.stringify(STATE_LOCK_PATH)});
    acquireStateLock(process.argv[1]).then(lock => {
      process.stdout.write(JSON.stringify({ ownerId: lock.ownerId, port: lock.port }) + '\\n');
      setInterval(() => {}, 1_000);
    }).catch(error => {
      process.stderr.write(error.stack + '\\n');
      process.exit(1);
    });
  `;
  const child = spawn(process.execPath, ['-e', childScript, statePath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  });

  const ready = JSON.parse(await waitForLine(child.stdout as NodeJS.ReadableStream));
  assert.match(ready.ownerId, /^[0-9a-f]{64}$/);
  assert.ok(Number.isInteger(ready.port));

  child.kill('SIGKILL');
  await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });

  const lock = await eventuallyAcquire(statePath);
  t.after(() => lock.release());
  assertStateLockHeld(lock);
});

test('skips a responsive foreign listener without disclosing the state path', async t => {
  const statePath = path.join(temporaryDirectory(t), 'secret-adapter-state.json');
  const candidatePorts = await freeCandidatePorts();
  let probe = '';
  const foreign = net.createServer(socket => {
    socket.on('data', chunk => {
      probe += chunk.toString('utf8');
      socket.end('not-the-private-state-proof\n');
    });
  });
  await listen(foreign, candidatePorts[0]);
  t.after(() => close(foreign));

  const lock = await acquireStateLock(statePath, { candidatePorts, probeTimeoutMs: 50 });
  t.after(() => lock.release());

  assert.equal(lock.port, candidatePorts[1]);
  assert.match(probe, /^OPENZEPPELIN_FOUNDRY_TRON_STATE_LOCK_V1 PROBE [0-9a-f]{64}\n$/);
  assert.equal(probe.includes(statePath), false);
  assert.equal(probe.includes(path.basename(statePath)), false);
});

test('bounds an unresponsive foreign probe and advances to the next candidate', async t => {
  const statePath = path.join(temporaryDirectory(t), 'adapter-state.json');
  const candidatePorts = await freeCandidatePorts();
  const sockets = new Set<net.Socket>();
  const foreign = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await listen(foreign, candidatePorts[0]);
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await close(foreign);
  });

  const started = Date.now();
  const lock = await acquireStateLock(statePath, { candidatePorts, probeTimeoutMs: 40 });
  t.after(() => lock.release());

  assert.equal(lock.port, candidatePorts[1]);
  assert.ok(Date.now() - started < 1_000);
});
