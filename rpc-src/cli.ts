#!/usr/bin/env node
import { AddressMap } from './address-map.js';
import type { AddressMapping, ContractMetadataRecord } from './address-map.js';
import { normalizeAddress, toEvmAddress } from './address-codec.js';
import { parseConfig, parseStateConfig } from './config.js';
import type { Config, StateConfig } from './config.js';
import { CreateReconciler } from './create-reconciler.js';
import { createRpcHandlers } from './handlers.js';
import { TransactionJournal } from './journal.js';
import { createRpcServer } from './server.js';
import type { RpcServer, RpcServerHandlers } from './server.js';
import { JsonStore, createStateFile } from './store.js';
import { TronClient } from './tron-client.js';
import { createUpstreamClient } from './upstream.js';
import type { UpstreamClient } from './upstream.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8_545;
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;
const USAGE = `Usage:
  openzeppelin-foundry-upgrades-tron init
  openzeppelin-foundry-upgrades-tron start [--host HOST] [--port PORT] [--allow-non-loopback]
  openzeppelin-foundry-upgrades-tron resolve ADDRESS
  openzeppelin-foundry-upgrades-tron mappings

Run init once to create the state file, then back it up like a keystore. Every
other command refuses to run against a missing state file rather than presenting
an empty deployment history.

TRON endpoints, private keys, state paths, chain identity, and Foundry output are configured through the environment.
`;

// The `parseConfig`/`runtimeFactory` composition seam accepts and returns a caller-supplied
// configuration and adapter runtime object whose exact shape tests replace with partial fakes; it
// has no canonical type in this codebase (mirrors the convention in rpc-src/receipts.ts). `any` is
// used deliberately here for that content, so this alias marks the deliberately untyped, pluggable
// seam; values are validated at the call sites before use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonAny = any;

/** The minimal writable-stream surface {@link run} writes CLI output to. */
export interface CliOutputStream {
  write(chunk: string): unknown;
}

/** The minimal signal-registration surface {@link run} uses to await shutdown signals. */
export interface CliSignalTarget {
  on(event: string, listener: () => void): unknown;
  off?(event: string, listener: () => void): unknown;
  removeListener?(event: string, listener: () => void): unknown;
}

/** Options accepted by {@link buildRuntime}. */
export interface BuildRuntimeOptions {
  host?: string;
  port?: number;
  fetch?: typeof fetch;
}

/** The composed adapter runtime returned by {@link buildRuntime}. */
export interface AdapterRuntime {
  store: JsonStore;
  addressMap: AddressMap;
  journal: TransactionJournal;
  reconciler: CreateReconciler;
  nativeClient: TronClient;
  upstream: UpstreamClient;
  handlers: RpcServerHandlers;
  server: RpcServer;
}

/** The JSON result shape returned by the `resolve` command and {@link resolveFromState}. */
export interface AddressResolution {
  predicted: string;
  actual: string;
  tronHex: string;
  base58: string;
  mapping: AddressMapping | null;
  metadata: ContractMetadataRecord | null;
}

/** The parsed `--help`/`help` invocation. */
export interface HelpArguments {
  command: 'help';
}

/** The parsed `init` invocation. */
export interface InitArguments {
  command: 'init';
}

/** The parsed `start` invocation. */
export interface StartArguments {
  command: 'start';
  host: string;
  port: number;
}

/** The parsed `resolve` invocation. */
export interface ResolveArguments {
  command: 'resolve';
  address: string;
}

/** The parsed `mappings` invocation. */
export interface MappingsArguments {
  command: 'mappings';
}

/** The result of {@link parseArguments}, discriminated by `command`. */
export type ParsedArguments =
  | HelpArguments
  | InitArguments
  | StartArguments
  | ResolveArguments
  | MappingsArguments;

/** Options accepted by {@link run}. */
export interface RunOptions {
  environment?: NodeJS.ProcessEnv;
  stdout?: CliOutputStream;
  stderr?: CliOutputStream;
  signalTarget?: CliSignalTarget;
  parseConfig?: (environment: NodeJS.ProcessEnv) => JsonAny;
  parseStateConfig?: (environment: NodeJS.ProcessEnv) => StateConfig;
  runtimeFactory?: (config: JsonAny, options: BuildRuntimeOptions) => unknown;
  fetch?: typeof fetch;
}

/** The fully-resolved options {@link run} threads through the CLI's dispatch. */
interface ResolvedRunContext {
  environment: NodeJS.ProcessEnv;
  stdout: CliOutputStream;
  stderr: CliOutputStream;
  signalTarget: CliSignalTarget;
  parseConfig: (environment: NodeJS.ProcessEnv) => JsonAny;
  parseStateConfig: (environment: NodeJS.ProcessEnv) => StateConfig;
  runtimeFactory: (config: JsonAny, options: BuildRuntimeOptions) => unknown;
  fetch: typeof fetch | undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsePort(value: string): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error('--port must be a canonical integer from 0 to 65535');
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('--port must be a canonical integer from 0 to 65535');
  }
  return port;
}

function loopbackHost(host: string): boolean {
  if (host === 'localhost' || host === '::1') return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return match !== null && match.slice(1).every(part => Number(part) <= 255) && Number(match[1]) === 127;
}

function parseStartArguments(args: string[]): StartArguments {
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  let allowNonLoopback = false;
  const seen = new Set<string>();
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

function parseArguments(argv: string[]): ParsedArguments {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) throw new Error('Invalid CLI arguments');
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === 'help')) return { command: 'help' };
  const [command, ...args] = argv;
  if (command === 'init') {
    if (args.length !== 0) throw new Error('The init command does not accept operands');
    return { command };
  }
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

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, stableValue(value[key])]),
  );
}

function writeJson(stream: CliOutputStream, value: unknown): void {
  stream.write(`${JSON.stringify(stableValue(value))}\n`);
}

function buildRuntime(config: Config, options: BuildRuntimeOptions = {}): AdapterRuntime {
  if (!isObject(options)) throw new Error('Invalid adapter runtime options');
  // `isObject` narrows `options` to `Record<string, unknown>`, which would otherwise discard the
  // specific `host`/`port`/`fetch` field types; re-assert the declared option shape here.
  const resolvedOptions = options as BuildRuntimeOptions;
  // Every CLI entry opens durable state in refuse-on-missing mode, so a lost or mispointed state
  // path fails loudly here instead of silently starting from an empty deployment history.
  const store = new JsonStore(config.stateFile, { createIfMissing: false });
  const addressMap = new AddressMap(store, config.chainIdentity);
  const journal = new TransactionJournal(store, config.chainIdentity, { allowRecovery: true });
  const reconciler = new CreateReconciler(journal, addressMap);
  const nativeClient = new TronClient({ config });
  const upstream = createUpstreamClient(config.jsonRpcEndpoint, {
    ...(resolvedOptions.fetch !== undefined ? { fetch: resolvedOptions.fetch } : {}),
  });
  const handlers = createRpcHandlers({ config, journal, addressMap, reconciler, nativeClient, upstream });
  const server = createRpcServer({
    handlers,
    host: resolvedOptions.host ?? DEFAULT_HOST,
    port: resolvedOptions.port ?? DEFAULT_PORT,
    statePath: config.stateFile,
  });
  return Object.freeze({ store, addressMap, journal, reconciler, nativeClient, upstream, handlers, server });
}

function resolveFromState(addressMap: AddressMap, value: string): AddressResolution {
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

function removeSignalListener(target: CliSignalTarget, signal: string, listener: () => void): void {
  if (typeof target.off === 'function') target.off(signal, listener);
  else if (typeof target.removeListener === 'function') target.removeListener(signal, listener);
}

async function assertUpstreamChainId(upstream: unknown, expectedChainId: bigint): Promise<void> {
  if (!isObject(upstream) || typeof upstream.request !== 'function') {
    throw new Error('Adapter runtime cannot verify the upstream chain ID');
  }
  // `isObject` only proves `upstream.request` is present, not the concrete client shape
  // `createUpstreamClient` always returns in production; the double cast documents that gap. The
  // upstream client is a pluggable, duck-typed dependency by design — tests inject partial fakes —
  // so its shape is validated at the call sites rather than enforced by the type.
  const client = upstream as unknown as UpstreamClient;
  const value = await client.request('eth_chainId', []);
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) {
    throw new Error('TRON node returned an invalid chain ID');
  }
  if (BigInt(value) !== expectedChainId) {
    throw new Error(`TRON node chain ID does not match configured TRON_CHAIN_ID ${expectedChainId}`);
  }
}

async function startCommand(parsed: StartArguments, context: ResolvedRunContext): Promise<void> {
  const config = context.parseConfig(context.environment);
  const runtime = context.runtimeFactory(config, {
    host: parsed.host,
    port: parsed.port,
    ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
  });
  if (!isObject(runtime) || !isObject(runtime.server) || !isObject(runtime.nativeClient)) {
    throw new Error('Adapter runtime did not provide a server and native client');
  }
  // `isObject` narrows `runtime` to `Record<string, unknown>`; the `server`/`nativeClient` fields
  // are runtime-checked for their required methods immediately below, so a loose cast here is safe.
  // The adapter runtime is a pluggable, duck-typed dependency by design — tests inject partial
  // fakes — so its shape is validated at those call sites rather than enforced by the type.
  const { server, nativeClient } = runtime as { server: JsonAny; nativeClient: JsonAny };
  if (typeof server.start !== 'function' || typeof server.stop !== 'function') {
    throw new Error('Adapter runtime server is invalid');
  }
  if (typeof nativeClient.assertSimulationReady !== 'function') {
    throw new Error('Adapter runtime native client cannot prove simulation readiness');
  }
  let resolveSignal: () => void;
  let shutdownRequested = false;
  let stopPromise: Promise<void> | undefined;
  const signalPromise = new Promise<void>(resolve => {
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
    await assertUpstreamChainId(runtime.upstream, config.chainId);
    const simulationMode = await nativeClient.assertSimulationReady();
    const address = await server.start();
    if (!shutdownRequested) {
      writeJson(context.stdout, {
        status: 'ready',
        host: address.host,
        port: address.port,
        chainIdentity: config.chainIdentity,
        stateFile: config.stateFile,
        foundryOut: config.foundryOut,
        simulationMode,
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

function readOnlyMap(
  environment: NodeJS.ProcessEnv,
  parseReadOnlyConfig: (environment: NodeJS.ProcessEnv) => StateConfig = parseStateConfig,
): { config: StateConfig; addressMap: AddressMap } {
  const config = parseReadOnlyConfig(environment);
  const store = new JsonStore(config.stateFile, { createIfMissing: false });
  return { config, addressMap: new AddressMap(store, config.chainIdentity) };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizedMessage(error: unknown, environment: NodeJS.ProcessEnv): string {
  // `isObject` would exclude arrays and functions, but a thrown value can be any non-null/
  // undefined type — arrays and functions can carry a `.message` property too. Casting instead of
  // narrowing reads `.message` off *any* such value, so exotic thrown values still surface their
  // message; a plain `isObject` narrowing helper would silently drop them.
  const candidate = (error as { message?: unknown } | null | undefined)?.message;
  let message = typeof candidate === 'string' && candidate.length > 0 ? candidate : 'Command failed';
  for (const key of ['TRON_PRIVATE_KEY', 'TRON_RPC_URL']) {
    const secret = environment?.[key];
    if (typeof secret === 'string' && secret.length > 0) {
      message = message.replace(new RegExp(escapeRegExp(secret), 'gi'), '[REDACTED]');
    }
  }
  return message;
}

async function run(argv: string[] = process.argv.slice(2), options: RunOptions = {}): Promise<number> {
  const context: ResolvedRunContext = {
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
    } else if (parsed.command === 'init') {
      const config = context.parseStateConfig(context.environment);
      const stateFile = createStateFile(config.stateFile);
      writeJson(context.stdout, { status: 'initialized', chainIdentity: config.chainIdentity, stateFile });
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

export { USAGE, buildRuntime, parseArguments, run };
