import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { AddressMap } from '../../dist/rpc/address-map.js';
import { buildRuntime, run } from '../../dist/rpc/cli.js';
import { parseConfig } from '../../dist/rpc/config.js';
import { CreateReconciler } from '../../dist/rpc/create-reconciler.js';
import { TransactionJournal } from '../../dist/rpc/journal.js';
import { JsonStore, createStateFile } from '../../dist/rpc/store.js';
import { TronClient } from '../../dist/rpc/tron-client.js';

const PRIVATE_KEY = '11'.repeat(32);
const PREDICTED_A = `0x${'11'.repeat(20)}`;
const ACTUAL_A = `0x${'22'.repeat(20)}`;
const PREDICTED_B = `0x${'33'.repeat(20)}`;
const ACTUAL_B = `0x${'44'.repeat(20)}`;
const CREATOR = `0x${'55'.repeat(20)}`;
const SOURCE_A = `0x${'aa'.repeat(32)}`;
const SOURCE_B = `0x${'bb'.repeat(32)}`;

function temporaryDirectory(t: TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-tron-cli-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  return directory;
}

function output(): { stream: { write(chunk: string): boolean }; read: () => string } {
  let contents = '';
  return {
    stream: {
      write(chunk: string): boolean {
        contents += String(chunk);
        return true;
      },
    },
    read: () => contents,
  };
}

function matchingUpstream(chainId: bigint, events?: string[]) {
  return {
    async request(method: string, params: unknown[]): Promise<string> {
      assert.equal(method, 'eth_chainId');
      assert.deepEqual(params, []);
      events?.push('chain');
      return `0x${chainId.toString(16)}`;
    },
  };
}

function readOnlyEnvironment(stateFile: string): NodeJS.ProcessEnv {
  return {
    TRON_NETWORK: 'nile',
    TRON_CHAIN_ID: '3448148188',
    TRON_STATE_FILE: stateFile,
  };
}

function seedMappings(stateFile: string): void {
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
  createStateFile(config.stateFile);
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
  const events: string[] = [];
  const signals = new EventEmitter();
  const stdout = output();
  const stderr = output();
  const config = {
    chainId: 728126428n,
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
  const nativeClient = {
    async assertSimulationReady() {
      events.push('probe');
      return 'constant-create';
    },
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
      return { server, nativeClient, upstream: matchingUpstream(config.chainId, events) };
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(events, ['compose', 'chain', 'probe', 'start', 'stop']);
  assert.equal(stderr.read(), '');
  assert.deepEqual(JSON.parse(stdout.read()), {
    chainIdentity: 'tre:728126428',
    foundryOut: '/absolute/out',
    host: '127.0.0.1',
    port: 18545,
    simulationMode: 'constant-create',
    stateFile: '/absolute/state.json',
    status: 'ready',
  });
  assert.doesNotMatch(stdout.read(), new RegExp(PRIVATE_KEY));
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

// The runtime's diagnostic reporter must reach handlers through composition, and everything it emits
// must pass the CLI's secret redaction — never a stack, never the raw key or endpoint.
test('threads a sanitized error reporter into runtime composition', async () => {
  const signals = new EventEmitter();
  const stdout = output();
  const stderr = output();
  const rpcUrl = 'https://secret.example.test';
  const config = {
    chainId: 728126428n,
    chainIdentity: 'tre:728126428',
    foundryOut: '/absolute/out',
    stateFile: '/absolute/state.json',
  };
  const server = {
    async start() {
      return { host: '127.0.0.1', port: 18545 };
    },
    async stop() {},
  };
  const originalWrite = stdout.stream.write;
  stdout.stream.write = chunk => {
    const result = originalWrite(chunk);
    signals.emit('SIGINT');
    return result;
  };
  const nativeClient = {
    async assertSimulationReady() {
      return 'constant-create';
    },
  };

  const exitCode = await run(['start'], {
    environment: { TRON_PRIVATE_KEY: PRIVATE_KEY, TRON_RPC_URL: rpcUrl },
    stdout: stdout.stream,
    stderr: stderr.stream,
    signalTarget: signals,
    parseConfig: () => config,
    runtimeFactory(_receivedConfig, options) {
      assert.equal(typeof options.reportError, 'function');
      options.reportError?.(
        `descriptor capture failed for deployment ${PREDICTED_A}`,
        Object.assign(new Error(`write failed for ${PRIVATE_KEY} via ${rpcUrl}`), {
          stack: `must-not-emit ${PRIVATE_KEY}`,
        }),
      );
      return { server, nativeClient, upstream: matchingUpstream(config.chainId, []) };
    },
  });

  assert.equal(exitCode, 0);
  const diagnostics = stderr.read();
  assert.match(diagnostics, /descriptor capture failed for deployment/);
  assert.match(diagnostics, /write failed for \[REDACTED\] via \[REDACTED\]/);
  assert.doesNotMatch(diagnostics, new RegExp(PRIVATE_KEY));
  assert.doesNotMatch(diagnostics, /secret\.example\.test|must-not-emit/);
});

test('keeps both signal handlers installed throughout draining and still stops only once', async () => {
  const signals = new EventEmitter();
  const stdout = output();
  let stopCalls = 0;
  let finishStop: () => void;
  const draining = new Promise<void>(resolve => {
    finishStop = resolve;
  });
  const server = {
    start: async () => ({ host: '127.0.0.1', port: 18545 }),
    async stop() {
      stopCalls += 1;
      await draining;
    },
  };
  stdout.stream.write = () => {
    signals.emit('SIGINT');
    return true;
  };

  const running = run(['start'], {
    environment: {},
    stdout: stdout.stream,
    stderr: output().stream,
    signalTarget: signals,
    parseConfig: () => ({ chainId: 1n, chainIdentity: 'tre:1', foundryOut: '/out', stateFile: '/state' }),
    runtimeFactory: () => ({
      server,
      nativeClient: { assertSimulationReady: async () => 'exact-signed' },
      upstream: matchingUpstream(1n),
    }),
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(stopCalls, 1);
  assert.equal(signals.listenerCount('SIGINT'), 1);
  assert.equal(signals.listenerCount('SIGTERM'), 1);
  signals.emit('SIGINT');
  signals.emit('SIGTERM');
  signals.emit('SIGTERM');
  assert.equal(stopCalls, 1);
  finishStop!();

  assert.equal(await running, 0);
  assert.equal(stopCalls, 1);
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
    parseConfig: () => ({ chainId: 1n, chainIdentity: 'tre:1', foundryOut: '/out', stateFile: '/state' }),
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
  const seen: string[] = [];
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
    parseConfig: () => ({ chainId: 1n, chainIdentity: 'tre:1', foundryOut: '/out', stateFile: '/state' }),
    runtimeFactory: (_config, options) => {
      assert.deepEqual({ host: options.host, port: options.port }, { host: '0.0.0.0', port: 9545 });
      return {
        server,
        nativeClient: { assertSimulationReady: async () => 'constant-create' },
        upstream: matchingUpstream(1n),
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(seen.length, 1);
});

test('does not open the listener when the bounded simulation readiness probe fails', async () => {
  const stderr = output();
  let starts = 0;
  let stops = 0;
  const exitCode = await run(['start'], {
    environment: {},
    stdout: output().stream,
    stderr: stderr.stream,
    parseConfig: () => ({ chainId: 1n, chainIdentity: 'tre:1', foundryOut: '/out', stateFile: '/state' }),
    runtimeFactory: () => ({
      nativeClient: {
        async assertSimulationReady() {
          throw new Error('ordered successful and rejected CREATE attempts unavailable');
        },
      },
      upstream: matchingUpstream(1n),
      server: {
        async start() {
          starts += 1;
        },
        async stop() {
          stops += 1;
        },
      },
    }),
  });

  assert.equal(exitCode, 1);
  assert.equal(starts, 0);
  assert.equal(stops, 1);
  assert.match(stderr.read(), /ordered successful and rejected CREATE/i);
});

test('does not probe simulation or open the listener when the upstream chain ID differs', async () => {
  const stderr = output();
  let probes = 0;
  let starts = 0;
  let stops = 0;
  const exitCode = await run(['start'], {
    environment: {},
    stdout: output().stream,
    stderr: stderr.stream,
    parseConfig: () => ({ chainId: 1n, chainIdentity: 'tre:1', foundryOut: '/out', stateFile: '/state' }),
    runtimeFactory: () => ({
      nativeClient: {
        async assertSimulationReady() {
          probes += 1;
        },
      },
      upstream: matchingUpstream(2n),
      server: {
        async start() {
          starts += 1;
        },
        async stop() {
          stops += 1;
        },
      },
    }),
  });

  assert.equal(exitCode, 1);
  assert.equal(probes, 0);
  assert.equal(starts, 0);
  assert.equal(stops, 1);
  assert.match(stderr.read(), /chain ID does not match/i);
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

test('init creates the state file explicitly and refuses to overwrite an existing one', async t => {
  const directory = temporaryDirectory(t);
  const stateFile = path.join(directory, 'nested', 'state.json');
  const environment = readOnlyEnvironment(stateFile);

  const first = output();
  assert.equal(await run(['init'], { environment, stdout: first.stream, stderr: output().stream }), 0);
  assert.equal(fs.existsSync(stateFile), true);
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  const initialized = JSON.parse(first.read());
  assert.equal(initialized.stateFile, stateFile);

  // The freshly initialized file is immediately usable by the read-only commands.
  assert.equal(await run(['mappings'], { environment, stdout: output().stream, stderr: output().stream }), 0);

  const second = output();
  assert.equal(await run(['init'], { environment, stdout: output().stream, stderr: second.stream }), 1);
  assert.match(second.read(), /already exists/i);
});

test('start, resolve, and mappings fail loudly when the state file has not been initialized', async t => {
  const directory = temporaryDirectory(t);
  const stateFile = path.join(directory, 'state.json');
  // A TRE environment resolves a full configuration from defaults, so the missing state file is the
  // only failure the start path can hit before it would otherwise open a listener.
  const environment = { TRON_STATE_FILE: stateFile };

  for (const argv of [['start'], ['resolve', PREDICTED_A], ['mappings']]) {
    const stderr = output();
    const exitCode = await run(argv, { environment, stdout: output().stream, stderr: stderr.stream });
    assert.equal(exitCode, 1, argv.join(' '));
    assert.match(stderr.read(), /not found/i, argv.join(' '));
    assert.ok(stderr.read().includes(stateFile), argv.join(' '));
    assert.match(stderr.read(), /init/i, argv.join(' '));
  }
  assert.equal(fs.existsSync(stateFile), false);
});

test('resolve fails clearly for an unknown nonzero address but permits the zero-address identity', async t => {
  const directory = temporaryDirectory(t);
  const stateFile = path.join(directory, 'state.json');
  const environment = readOnlyEnvironment(stateFile);
  assert.equal(await run(['init'], { environment, stdout: output().stream, stderr: output().stream }), 0);
  const unknown = output();

  assert.equal(
    await run(['resolve', `0x${'99'.repeat(20)}`], {
      environment,
      stdout: output().stream,
      stderr: unknown.stream,
    }),
    1,
  );
  assert.match(unknown.read(), /no address mapping found/i);

  const zero = output();
  assert.equal(
    await run(['resolve', `0x${'00'.repeat(20)}`], {
      environment,
      stdout: zero.stream,
      stderr: output().stream,
    }),
    0,
  );
  const resolved = JSON.parse(zero.read());
  assert.equal(resolved.predicted, `0x${'00'.repeat(20)}`);
  assert.equal(resolved.actual, `0x${'00'.repeat(20)}`);
  assert.equal(resolved.mapping, null);
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
    mappings.map((mapping: { predicted: string }) => mapping.predicted),
    [PREDICTED_A, PREDICTED_B],
  );
  assert.equal(Object.keys(mappings[0]).join(','), 'actual,creator,predicted,sender,sourceTransaction');
  assert.equal(stdout.read(), `${JSON.stringify(mappings)}\n`);
});
