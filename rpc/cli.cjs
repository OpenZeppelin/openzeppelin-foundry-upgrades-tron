#!/usr/bin/env node
'use strict';

const { AddressMap } = require('./address-map.cjs');
const { normalizeAddress, toEvmAddress } = require('./address-codec.cjs');
const { parseConfig, parseStateConfig } = require('./config.cjs');
const { CreateReconciler } = require('./create-reconciler.cjs');
const { createRpcHandlers } = require('./handlers.cjs');
const { TransactionJournal } = require('./journal.cjs');
const { createRpcServer } = require('./server.cjs');
const { JsonStore } = require('./store.cjs');
const { TronClient } = require('./tron-client.cjs');
const { createUpstreamClient } = require('./upstream.cjs');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8_545;
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;
const USAGE = `Usage:
  openzeppelin-foundry-upgrades-tron start [--host HOST] [--port PORT] [--allow-non-loopback]
  openzeppelin-foundry-upgrades-tron resolve ADDRESS
  openzeppelin-foundry-upgrades-tron mappings

TRON endpoints, private keys, state paths, chain identity, and Foundry output are configured through the environment.
`;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsePort(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error('--port must be a canonical integer from 0 to 65535');
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('--port must be a canonical integer from 0 to 65535');
  }
  return port;
}

function loopbackHost(host) {
  if (host === 'localhost' || host === '::1') return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return match !== null && match.slice(1).every(part => Number(part) <= 255) && Number(match[1]) === 127;
}

function parseStartArguments(args) {
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  let allowNonLoopback = false;
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!['--host', '--port', '--allow-non-loopback'].includes(flag)) {
      throw new Error(flag.startsWith('--') ? `Unknown option ${flag}` : 'The start command does not accept operands');
    }
    if (seen.has(flag)) throw new Error(`Duplicate option ${flag}`);
    seen.add(flag);
    if (flag === '--allow-non-loopback') {
      allowNonLoopback = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    index += 1;
    if (flag === '--host') {
      if (value.length === 0 || value.includes('\0')) throw new Error('--host must be a nonempty host name or address');
      host = value;
    } else {
      port = parsePort(value);
    }
  }
  if (!loopbackHost(host) && !allowNonLoopback) {
    throw new Error('Binding to a non-loopback host requires --allow-non-loopback');
  }
  return { command: 'start', host, port };
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) throw new Error('Invalid CLI arguments');
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === 'help')) return { command: 'help' };
  const [command, ...args] = argv;
  if (command === 'start') return parseStartArguments(args);
  if (command === 'resolve') {
    if (args.length !== 1) throw new Error('The resolve command requires exactly one address');
    return { command, address: args[0] };
  }
  if (command === 'mappings') {
    if (args.length !== 0) throw new Error('The mappings command does not accept operands');
    return { command };
  }
  throw new Error(command === undefined ? 'A command is required' : `Unknown command ${command}`);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, stableValue(value[key])]),
  );
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(stableValue(value))}\n`);
}

function buildRuntime(config, options = {}) {
  if (!isObject(options)) throw new Error('Invalid adapter runtime options');
  const store = new JsonStore(config.stateFile);
  const addressMap = new AddressMap(store, config.chainIdentity);
  const journal = new TransactionJournal(store, config.chainIdentity, { allowRecovery: true });
  const reconciler = new CreateReconciler(journal, addressMap);
  const nativeClient = new TronClient({ config });
  const upstream = createUpstreamClient(config.jsonRpcEndpoint, {
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });
  const handlers = createRpcHandlers({ config, journal, addressMap, reconciler, nativeClient, upstream });
  const server = createRpcServer({
    handlers,
    host: options.host ?? DEFAULT_HOST,
    port: options.port ?? DEFAULT_PORT,
    statePath: config.stateFile,
  });
  return Object.freeze({ store, addressMap, journal, reconciler, nativeClient, upstream, handlers, server });
}

function resolveFromState(addressMap, value) {
  const normalized = toEvmAddress(value);
  const byPredicted = normalized === ZERO_ADDRESS ? undefined : addressMap.resolvePredicted(normalized);
  const byActual =
    normalized === ZERO_ADDRESS || byPredicted !== undefined ? undefined : addressMap.resolveActual(normalized);
  const mapping = byPredicted ?? byActual;
  if (normalized !== ZERO_ADDRESS && mapping === undefined) {
    throw new Error(`No address mapping found for ${normalized}`);
  }
  const predicted = mapping?.predicted ?? normalized;
  const actual = mapping?.actual ?? normalized;
  const encoded = normalizeAddress(actual);
  return {
    predicted,
    actual,
    tronHex: encoded.tronHex,
    base58: encoded.base58,
    mapping: mapping ?? null,
    metadata: normalized === ZERO_ADDRESS ? null : (addressMap.resolveContractMetadata(predicted) ?? null),
  };
}

function removeSignalListener(target, signal, listener) {
  if (typeof target.off === 'function') target.off(signal, listener);
  else if (typeof target.removeListener === 'function') target.removeListener(signal, listener);
}

async function startCommand(parsed, context) {
  const config = context.parseConfig(context.environment);
  const runtime = context.runtimeFactory(config, {
    host: parsed.host,
    port: parsed.port,
    ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
  });
  if (!isObject(runtime) || !isObject(runtime.server)) throw new Error('Adapter runtime did not provide a server');
  const { server } = runtime;
  if (typeof server.start !== 'function' || typeof server.stop !== 'function') {
    throw new Error('Adapter runtime server is invalid');
  }
  let resolveSignal;
  let shutdownRequested = false;
  let stopPromise;
  const signalPromise = new Promise(resolve => {
    resolveSignal = resolve;
  });
  const requestShutdown = () => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    resolveSignal();
  };
  const stopOnce = () => {
    stopPromise ??= Promise.resolve().then(() => server.stop());
    return stopPromise;
  };
  context.signalTarget.on('SIGINT', requestShutdown);
  context.signalTarget.on('SIGTERM', requestShutdown);
  try {
    const address = await server.start();
    if (!shutdownRequested) {
      writeJson(context.stdout, {
        status: 'ready',
        host: address.host,
        port: address.port,
        chainIdentity: config.chainIdentity,
        stateFile: config.stateFile,
        foundryOut: config.foundryOut,
      });
      await signalPromise;
    }
    await stopOnce();
  } catch (error) {
    try {
      await stopOnce();
    } catch (stopError) {
      throw new AggregateError([error, stopError], 'Adapter startup and shutdown both failed');
    }
    throw error;
  } finally {
    removeSignalListener(context.signalTarget, 'SIGINT', requestShutdown);
    removeSignalListener(context.signalTarget, 'SIGTERM', requestShutdown);
  }
}

function readOnlyMap(environment, parseReadOnlyConfig = parseStateConfig) {
  const config = parseReadOnlyConfig(environment);
  const store = new JsonStore(config.stateFile);
  return { config, addressMap: new AddressMap(store, config.chainIdentity) };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizedMessage(error, environment) {
  let message = typeof error?.message === 'string' && error.message.length > 0 ? error.message : 'Command failed';
  for (const key of ['TRON_PRIVATE_KEY', 'TRON_RPC_URL']) {
    const secret = environment?.[key];
    if (typeof secret === 'string' && secret.length > 0) {
      message = message.replace(new RegExp(escapeRegExp(secret), 'gi'), '[REDACTED]');
    }
  }
  return message;
}

async function run(argv = process.argv.slice(2), options = {}) {
  const context = {
    environment: options.environment ?? process.env,
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
    signalTarget: options.signalTarget ?? process,
    parseConfig: options.parseConfig ?? parseConfig,
    parseStateConfig: options.parseStateConfig ?? parseStateConfig,
    runtimeFactory: options.runtimeFactory ?? buildRuntime,
    fetch: options.fetch,
  };
  try {
    const parsed = parseArguments(argv);
    if (parsed.command === 'help') {
      context.stdout.write(USAGE);
    } else if (parsed.command === 'start') {
      await startCommand(parsed, context);
    } else {
      const { addressMap } = readOnlyMap(context.environment, context.parseStateConfig);
      if (parsed.command === 'resolve') writeJson(context.stdout, resolveFromState(addressMap, parsed.address));
      else writeJson(context.stdout, addressMap.list());
    }
    return 0;
  } catch (error) {
    context.stderr.write(`Error: ${sanitizedMessage(error, context.environment)}\n`);
    return 1;
  }
}

if (require.main === module) {
  run().then(exitCode => {
    process.exitCode = exitCode;
  });
}

module.exports = {
  USAGE,
  buildRuntime,
  parseArguments,
  run,
};
