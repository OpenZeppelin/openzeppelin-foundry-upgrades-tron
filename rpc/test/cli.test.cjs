'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AddressMap } = require('../address-map.cjs');
const { buildRuntime, run } = require('../cli.cjs');
const { parseConfig } = require('../config.cjs');
const { CreateReconciler } = require('../create-reconciler.cjs');
const { TransactionJournal } = require('../journal.cjs');
const { JsonStore } = require('../store.cjs');
const { TronClient } = require('../tron-client.cjs');

const PRIVATE_KEY = '11'.repeat(32);
const PREDICTED_A = `0x${'11'.repeat(20)}`;
const ACTUAL_A = `0x${'22'.repeat(20)}`;
const PREDICTED_B = `0x${'33'.repeat(20)}`;
const ACTUAL_B = `0x${'44'.repeat(20)}`;
const CREATOR = `0x${'55'.repeat(20)}`;
const SOURCE_A = `0x${'aa'.repeat(32)}`;
const SOURCE_B = `0x${'bb'.repeat(32)}`;

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-tron-cli-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  return directory;
}

function output() {
  let contents = '';
  return {
    stream: {
      write(chunk) {
        contents += String(chunk);
        return true;
      },
    },
    read: () => contents,
  };
}

function readOnlyEnvironment(stateFile) {
  return {
    TRON_NETWORK: 'nile',
    TRON_CHAIN_ID: '3448148188',
    TRON_STATE_FILE: stateFile,
  };
}

function seedMappings(stateFile) {
  const store = new JsonStore(stateFile);
  const addressMap = new AddressMap(store, 'nile:3448148188');
  for (const mapping of [
    {
      predicted: PREDICTED_B,
      actual: ACTUAL_B,
      creator: CREATOR,
      sender: CREATOR,
      sourceTransaction: SOURCE_B,
    },
    {
      predicted: PREDICTED_A,
      actual: ACTUAL_A,
      creator: CREATOR,
      sender: CREATOR,
      sourceTransaction: SOURCE_A,
    },
  ]) {
    addressMap.set(mapping);
  }
  addressMap.setContractMetadata({
    predicted: PREDICTED_A,
    contractKind: 'contract',
    artifactIdentity: {
      sourceName: 'src/Box.sol',
      contractName: 'Box',
      fullyQualifiedName: 'src/Box.sol:Box',
    },
    sourceTransaction: SOURCE_A,
  });
}

test('builds the complete recovery-enabled adapter runtime from validated configuration', t => {
  const directory = temporaryDirectory(t);
  const config = parseConfig({
    FOUNDRY_OUT: path.join(directory, 'out'),
    TRON_STATE_FILE: path.join(directory, 'state.json'),
    TRON_PRIVATE_KEY: PRIVATE_KEY,
  });
  const runtime = buildRuntime(config, {
    host: '127.0.0.1',
    port: 0,
    fetch: async () => {
      throw new Error('not called during composition');
    },
  });
  t.after(() => runtime.server.stop());

  assert.ok(runtime.store instanceof JsonStore);
  assert.ok(runtime.addressMap instanceof AddressMap);
  assert.ok(runtime.journal instanceof TransactionJournal);
  assert.equal(runtime.journal.allowRecovery, true);
  assert.ok(runtime.reconciler instanceof CreateReconciler);
  assert.ok(runtime.nativeClient instanceof TronClient);
  assert.equal(typeof runtime.upstream.request, 'function');
  assert.equal(typeof runtime.handlers.recoverStartup, 'function');
  assert.equal(runtime.server.address(), undefined);
});

test('starts on loopback, reports only sanitized readiness data, and stops once for repeated signals', async () => {
  const events = [];
  const signals = new EventEmitter();
  const stdout = output();
  const stderr = output();
  const config = {
    chainIdentity: 'tre:728126428',
    foundryOut: '/absolute/out',
    stateFile: '/absolute/state.json',
  };
  const server = {
    async start() {
      events.push('start');
      return { host: '127.0.0.1', port: 18545 };
    },
    async stop() {
      events.push('stop');
    },
  };
  const originalWrite = stdout.stream.write;
  stdout.stream.write = chunk => {
    const result = originalWrite(chunk);
    signals.emit('SIGINT');
    signals.emit('SIGTERM');
    return result;
  };

  const exitCode = await run(['start'], {
    environment: { TRON_PRIVATE_KEY: PRIVATE_KEY },
    stdout: stdout.stream,
    stderr: stderr.stream,
    signalTarget: signals,
    parseConfig: () => config,
    runtimeFactory(receivedConfig, options) {
      assert.equal(receivedConfig, config);
      assert.equal(options.host, '127.0.0.1');
      assert.equal(options.port, 8545);
      events.push('compose');
      return { server };
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(events, ['compose', 'start', 'stop']);
  assert.equal(stderr.read(), '');
  assert.deepEqual(JSON.parse(stdout.read()), {
    chainIdentity: 'tre:728126428',
    foundryOut: '/absolute/out',
    host: '127.0.0.1',
    port: 18545,
    stateFile: '/absolute/state.json',
    status: 'ready',
  });
  assert.doesNotMatch(stdout.read(), new RegExp(PRIVATE_KEY));
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('requires explicit opt-in before binding to a non-loopback host', async () => {
  const stderr = output();
  let starts = 0;
  const options = {
    environment: {},
    stdout: output().stream,
    stderr: stderr.stream,
    parseConfig: () => ({ chainIdentity: 'tre:1', foundryOut: '/out', stateFile: '/state' }),
    runtimeFactory: () => {
      starts += 1;
      return { server: {} };
    },
  };

  assert.equal(await run(['start', '--host', '0.0.0.0'], options), 1);
  assert.match(stderr.read(), /--allow-non-loopback/);
  assert.equal(starts, 0);
});

test('accepts explicit non-loopback opt-in and strict canonical ports', async () => {
  const signals = new EventEmitter();
  const stdout = output();
  const seen = [];
  stdout.stream.write = chunk => {
    seen.push(String(chunk));
    signals.emit('SIGTERM');
    return true;
  };
  const server = {
    start: async () => ({ host: '0.0.0.0', port: 9545 }),
    stop: async () => {},
  };

  const exitCode = await run(['start', '--host', '0.0.0.0', '--port', '9545', '--allow-non-loopback'], {
    environment: {},
    stdout: stdout.stream,
    stderr: output().stream,
    signalTarget: signals,
    parseConfig: () => ({ chainIdentity: 'tre:1', foundryOut: '/out', stateFile: '/state' }),
    runtimeFactory: (_config, options) => {
      assert.deepEqual({ host: options.host, port: options.port }, { host: '0.0.0.0', port: 9545 });
      return { server };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(seen.length, 1);
});

test('rejects unknown commands, flags, duplicate flags, operands, and CLI secrets', async () => {
  for (const argv of [
    [],
    ['unknown'],
    ['start', '--unknown'],
    ['start', '--host', '127.0.0.1', '--host', 'localhost'],
    ['start', '--port', '08545'],
    ['start', '--port', '65536'],
    ['start', 'operand'],
    ['resolve'],
    ['resolve', PREDICTED_A, 'extra'],
    ['mappings', 'extra'],
    ['start', '--private-key', PRIVATE_KEY],
    ['start', '--rpc-url', 'https://secret.example.test'],
  ]) {
    const stderr = output();
    const exitCode = await run(argv, { environment: {}, stdout: output().stream, stderr: stderr.stream });
    assert.equal(exitCode, 1, argv.join(' '));
    assert.notEqual(stderr.read(), '', argv.join(' '));
    assert.doesNotMatch(stderr.read(), new RegExp(PRIVATE_KEY), argv.join(' '));
    assert.doesNotMatch(stderr.read(), /secret\.example\.test/, argv.join(' '));
  }
});

test('redacts environment credentials from startup failures', async () => {
  const stderr = output();
  const exitCode = await run(['start'], {
    environment: { TRON_PRIVATE_KEY: PRIVATE_KEY },
    stdout: output().stream,
    stderr: stderr.stream,
    parseConfig: () => {
      throw new Error(`cannot load ${PRIVATE_KEY}`);
    },
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.read(), /cannot load \[REDACTED\]/);
  assert.doesNotMatch(stderr.read(), new RegExp(PRIVATE_KEY));
});

test('resolve is read-only, credential-free, and stable for predicted and actual inputs', async t => {
  const directory = temporaryDirectory(t);
  const stateFile = path.join(directory, 'state.json');
  seedMappings(stateFile);

  for (const input of [PREDICTED_A, ACTUAL_A]) {
    const stdout = output();
    const stderr = output();
    const exitCode = await run(['resolve', input], {
      environment: readOnlyEnvironment(stateFile),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    assert.equal(exitCode, 0);
    assert.equal(stderr.read(), '');
    assert.equal(
      stdout.read(),
      `${JSON.stringify({
        actual: ACTUAL_A,
        base58: 'TD5gsCwxykWsLN9aPrq2TAfNjByuZKYp4E',
        mapping: {
          actual: ACTUAL_A,
          creator: CREATOR,
          predicted: PREDICTED_A,
          sender: CREATOR,
          sourceTransaction: SOURCE_A,
        },
        metadata: {
          artifactIdentity: {
            contractName: 'Box',
            fullyQualifiedName: 'src/Box.sol:Box',
            sourceName: 'src/Box.sol',
          },
          contractKind: 'contract',
          predicted: PREDICTED_A,
          sourceTransaction: SOURCE_A,
        },
        predicted: PREDICTED_A,
        tronHex: `41${ACTUAL_A.slice(2)}`,
      })}\n`,
    );
  }
});

test('mappings returns predicted-address-sorted stable JSON without private key or network access', async t => {
  const directory = temporaryDirectory(t);
  const stateFile = path.join(directory, 'state.json');
  seedMappings(stateFile);
  const stdout = output();
  const stderr = output();

  const exitCode = await run(['mappings'], {
    environment: readOnlyEnvironment(stateFile),
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), '');
  const mappings = JSON.parse(stdout.read());
  assert.deepEqual(
    mappings.map(mapping => mapping.predicted),
    [PREDICTED_A, PREDICTED_B],
  );
  assert.equal(Object.keys(mappings[0]).join(','), 'actual,creator,predicted,sender,sourceTransaction');
  assert.equal(stdout.read(), `${JSON.stringify(mappings)}\n`);
});
