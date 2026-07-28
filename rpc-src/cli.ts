#!/usr/bin/env node
import { keccak256, toUtf8Bytes } from 'ethers';

import { AddressMap } from './address-map.js';
import type { AddressMapping, ContractMetadataRecord } from './address-map.js';
import {
  setArtifactSnapshotInChain,
  setContractMetadataInChain,
  setDeploymentDescriptorInChain,
  setMappingInChain,
  setNonceBaselineInChain,
} from './address-map.js';
import { normalizeAddress, toEvmAddress } from './address-codec.js';
import { derivedTronProxyAdminIdentity } from './artifact-identities.js';
import { findArtifactPaths, matchDeploymentArtifact, verifyArtifactProvenance } from './artifacts.js';
import type { DeploymentMatchResult, MatchDeploymentArtifactOptions } from './artifacts.js';
import {
  buildDescriptorsFromRanges,
  buildImmutableDescriptors,
  codeMatchesRuntimeTemplate,
  extractImmutableReferences,
  hasAddressWidthRange,
  immutableRangeLow20,
  immutableRanges,
  runtimeBytecodeTemplateHash,
} from './immutable-projection.js';
import type { ImmutableRange, ImmutableSource } from './immutable-projection.js';
import { parseConfig, parseStateConfig } from './config.js';
import type { Config, StateConfig } from './config.js';
import { CreateReconciler } from './create-reconciler.js';
import { createRpcHandlers } from './handlers.js';
import { TransactionJournal } from './journal.js';
import { createRpcServer } from './server.js';
import type { RpcServer, RpcServerHandlers } from './server.js';
import { acquireStateLock, assertStateLockHeld } from './state-lock.js';
import type { StateLockCapability } from './state-lock.js';
import { JsonStore, createStateFile } from './store.js';
import { decodeLegacyTransaction } from './transactions.js';
import type { DecodeLegacyTransactionOptions, DecodedLegacyTransaction } from './transactions.js';
import { TronClient } from './tron-client.js';
import { createUpstreamClient } from './upstream.js';
import type { UpstreamClient } from './upstream.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8_545;
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;
// The hash of zero-length code, shared by an artifact with no runtime bytecode (abstract contract
// or interface) and a codeless on-chain address; adoption must refuse both explicitly rather than
// let them compare equal to each other.
const EMPTY_RUNTIME_CODE_HASH = keccak256('0x');
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const ADOPTABLE_KINDS = new Set([
  'contract',
  'uups-proxy',
  'transparent-proxy',
  'beacon-proxy',
  'upgradeable-beacon',
  'proxy-admin',
]);
// The TRC-1967 storage slot each proxy kind must expose consistently with its declared references.
const PROXY_SLOTS = new Map<string, { slot: string; flag: keyof AdoptReferences; label: string }>([
  ['uups-proxy', { slot: IMPLEMENTATION_SLOT, flag: 'impl', label: 'implementation' }],
  ['transparent-proxy', { slot: ADMIN_SLOT, flag: 'admin', label: 'admin' }],
  ['beacon-proxy', { slot: BEACON_SLOT, flag: 'beacon', label: 'beacon' }],
]);
const OWNER_SELECTOR = '0x8da5cb5b';
const IMPLEMENTATION_SELECTOR = '0x5c60da1b';
// A live value cross-check the adoption performs on the controller a proxy delegates upgrade authority
// to: a transparent proxy's ProxyAdmin must answer owner() with the operator-declared --owner, a beacon
// proxy's UpgradeableBeacon must answer implementation() with the operator-declared --impl. The call
// targets the proxy's declared controller (its actual, on-chain address in `calleeFlag`, already proven
// to equal the proxy's TRC-1967 slot by assertProxyReferences); the returned value is compared, in
// actual space, against the reference in `expectFlag`. A UUPS proxy points its implementation slot at
// the logic contract itself, which exposes no such controller selector, so it has no controller entry.
const PROXY_CONTROLLER = new Map<
  string,
  { calleeFlag: keyof AdoptReferences; selector: string; expectFlag: keyof AdoptReferences; label: string }
>([
  ['transparent-proxy', { calleeFlag: 'admin', selector: OWNER_SELECTOR, expectFlag: 'owner', label: 'ProxyAdmin owner()' }],
  [
    'beacon-proxy',
    { calleeFlag: 'beacon', selector: IMPLEMENTATION_SELECTOR, expectFlag: 'impl', label: 'UpgradeableBeacon implementation()' },
  ],
]);
// A live value cross-check adoption performs on a STANDALONE controller (a proxy-admin or an
// upgradeable-beacon adopted in its own right, not via a proxy). The call targets the adopted
// contract's own on-chain address (the callee is `actual`, not a reference flag), and the returned
// value is compared, in actual space, against the operator-declared reference: a ProxyAdmin must
// answer owner() with --owner, an UpgradeableBeacon must answer implementation() with --impl.
const SELF_CONTROLLER = new Map<string, { selector: string; expectFlag: keyof AdoptReferences; label: string }>([
  ['proxy-admin', { selector: OWNER_SELECTOR, expectFlag: 'owner', label: 'ProxyAdmin owner()' }],
  ['upgradeable-beacon', { selector: IMPLEMENTATION_SELECTOR, expectFlag: 'impl', label: 'UpgradeableBeacon implementation()' }],
]);
// The reference flags each adoptable kind accepts. A proxy kind's TRC-1967 slot reference and its
// controller-value reference are both required (enforced by assertProxyReferences / assertProxyController);
// a standalone controller kind requires only its own controller-value reference; any flag not listed
// for the kind is refused rather than silently ignored.
const KIND_REFERENCE_FLAGS = new Map<string, ReadonlyArray<keyof AdoptReferences>>([
  ['uups-proxy', ['impl']],
  ['transparent-proxy', ['admin', 'owner']],
  ['beacon-proxy', ['beacon', 'impl']],
  ['proxy-admin', ['owner']],
  ['upgradeable-beacon', ['impl']],
]);
const REFERENCE_FLAGS: ReadonlyArray<keyof AdoptReferences> = ['admin', 'beacon', 'impl', 'owner'];
const ADOPT_FLAGS = [
  '--predicted',
  '--actual',
  '--artifact',
  '--kind',
  '--admin',
  '--beacon',
  '--impl',
  '--owner',
  '--nonce-baseline',
];
const USAGE = `Usage:
  openzeppelin-foundry-upgrades-tron init
  openzeppelin-foundry-upgrades-tron start [--host HOST] [--port PORT] [--allow-non-loopback]
  openzeppelin-foundry-upgrades-tron resolve ADDRESS
  openzeppelin-foundry-upgrades-tron mappings
  openzeppelin-foundry-upgrades-tron adopt --predicted EVM --actual TRON --artifact FQN --kind KIND
                                           [--impl ADDR] [--admin ADDR] [--beacon ADDR] [--owner ADDR]
                                           [--nonce-baseline N]
  openzeppelin-foundry-upgrades-tron repair

Run init once to create the state file, then back it up like a keystore. Every
other command refuses to run against a missing state file rather than presenting
an empty deployment history.

adopt re-registers a verified on-chain deployment into gateway state after a lost
state file, so it can be operated ABI-aware again. It verifies the artifact
provenance, the on-chain runtime code, and the proxy storage slots before writing
anything. It does not reconstruct historical nonces or receipts.

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

/** A one-line diagnostic sink for the adapter's non-fatal (swallowed) failures; never throws upward. */
export type ErrorReporter = (context: string, error: unknown) => void;

/** Options accepted by {@link buildRuntime}. */
export interface BuildRuntimeOptions {
  host?: string;
  port?: number;
  fetch?: typeof fetch;
  reportError?: ErrorReporter;
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

/** The parsed `repair` invocation. */
export interface RepairArguments {
  command: 'repair';
}

/** The optional proxy reference addresses accepted by the `adopt` command. */
export interface AdoptReferences {
  admin?: string;
  beacon?: string;
  impl?: string;
  owner?: string;
}

/** The parsed `adopt` invocation. */
export interface AdoptArguments extends AdoptReferences {
  command: 'adopt';
  predicted: string;
  actual: string;
  artifact: string;
  kind: string;
  nonceBaseline?: string;
}

/** The result of {@link parseArguments}, discriminated by `command`. */
export type ParsedArguments =
  | HelpArguments
  | InitArguments
  | StartArguments
  | ResolveArguments
  | MappingsArguments
  | RepairArguments
  | AdoptArguments;

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
  verifyArtifactProvenance?: (options: { outputDirectory: string; artifactPath: string }) => JsonAny;
  findArtifactPaths?: (outputDirectory: string, reference: string) => string[];
  decodeLegacyTransaction?: (raw: string, options?: DecodeLegacyTransactionOptions) => DecodedLegacyTransaction;
  matchDeploymentArtifact?: (options: MatchDeploymentArtifactOptions) => DeploymentMatchResult;
  upstreamClient?: UpstreamClient;
  acquireStateLock?: (statePath: string) => Promise<StateLockCapability>;
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
  verifyArtifactProvenance: (options: { outputDirectory: string; artifactPath: string }) => JsonAny;
  findArtifactPaths: (outputDirectory: string, reference: string) => string[];
  decodeLegacyTransaction: (raw: string, options?: DecodeLegacyTransactionOptions) => DecodedLegacyTransaction;
  matchDeploymentArtifact: (options: MatchDeploymentArtifactOptions) => DeploymentMatchResult;
  adoptUpstream: (config: JsonAny) => UpstreamClient;
  acquireStateLock: (statePath: string) => Promise<StateLockCapability>;
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

function parseAdoptArguments(args: string[]): AdoptArguments {
  const values: Record<string, string> = {};
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!ADOPT_FLAGS.includes(flag)) {
      throw new Error(flag.startsWith('--') ? `Unknown option ${flag}` : 'The adopt command only accepts options');
    }
    if (seen.has(flag)) throw new Error(`Duplicate option ${flag}`);
    seen.add(flag);
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    index += 1;
    values[flag] = value;
  }
  for (const required of ['--predicted', '--actual', '--artifact', '--kind']) {
    if (values[required] === undefined) throw new Error(`The adopt command requires ${required}`);
  }
  return {
    command: 'adopt',
    predicted: values['--predicted'],
    actual: values['--actual'],
    artifact: values['--artifact'],
    kind: values['--kind'],
    ...(values['--admin'] === undefined ? {} : { admin: values['--admin'] }),
    ...(values['--beacon'] === undefined ? {} : { beacon: values['--beacon'] }),
    ...(values['--impl'] === undefined ? {} : { impl: values['--impl'] }),
    ...(values['--owner'] === undefined ? {} : { owner: values['--owner'] }),
    ...(values['--nonce-baseline'] === undefined ? {} : { nonceBaseline: values['--nonce-baseline'] }),
  };
}

function parseArguments(argv: string[]): ParsedArguments {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) throw new Error('Invalid CLI arguments');
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === 'help')) return { command: 'help' };
  const [command, ...args] = argv;
  if (command === 'init') {
    if (args.length !== 0) throw new Error('The init command does not accept operands');
    return { command };
  }
  if (command === 'adopt') return parseAdoptArguments(args);
  if (command === 'start') return parseStartArguments(args);
  if (command === 'resolve') {
    if (args.length !== 1) throw new Error('The resolve command requires exactly one address');
    return { command, address: args[0] };
  }
  if (command === 'mappings') {
    if (args.length !== 0) throw new Error('The mappings command does not accept operands');
    return { command };
  }
  if (command === 'repair') {
    if (args.length !== 0) throw new Error('The repair command does not accept operands');
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
  const handlers = createRpcHandlers({
    config,
    journal,
    addressMap,
    reconciler,
    nativeClient,
    upstream,
    ...(resolvedOptions.reportError === undefined ? {} : { reportError: resolvedOptions.reportError }),
  });
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
    // The sink reuses the CLI's fatal-error redaction (TRON_PRIVATE_KEY / TRON_RPC_URL values) and
    // emits the error's `.message` only — never a stack, cause chain, or serialized error object.
    reportError: (label, error) => {
      context.stderr.write(`Warning: ${label}: ${sanitizedMessage(error, context.environment)}\n`);
    },
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

function requireNonzeroEvmAddress(value: JsonAny, label: string): string {
  let normalized;
  try {
    normalized = toEvmAddress(value);
  } catch (error) {
    throw new Error(`Invalid ${label} address`, { cause: error });
  }
  if (normalized === ZERO_ADDRESS) throw new Error(`Invalid ${label} address`);
  return normalized;
}

function requireAdoptableKind(kind: JsonAny): string {
  if (typeof kind !== 'string' || !ADOPTABLE_KINDS.has(kind)) {
    throw new Error(`Unsupported contract kind ${typeof kind === 'string' ? kind : ''}`.trim());
  }
  return kind;
}

function parseNonceBaseline(value: JsonAny): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error('--nonce-baseline must be a canonical non-negative integer');
  }
  return BigInt(value);
}

function bytecodeHexHash(value: JsonAny, label: string): string {
  const hex = typeof value === 'string' ? value : value?.object;
  if (typeof hex !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(hex)) {
    throw new Error(`Verified artifact ${label} is unavailable`);
  }
  return keccak256(hex.toLowerCase());
}

// The 0x-stripped, lowercased runtime hex of a verified artifact's deployed bytecode.
function runtimeBytecodeHex(value: JsonAny): string {
  const hex = typeof value === 'string' ? value : value?.object;
  if (typeof hex !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(hex)) {
    throw new Error('Verified artifact runtime bytecode is unavailable');
  }
  return hex.slice(2).toLowerCase();
}

// Zero the immutable byte ranges in a 0x-stripped hex string so constructor-set values do not defeat
// a runtime-code comparison. Each byte occupies two hex characters.
function maskImmutables(codeHex: string, ranges: ImmutableRange[]): string {
  const characters = codeHex.split('');
  for (const { start, length } of ranges) {
    const to = (start + length) * 2;
    if (to > characters.length) throw new Error('Verified artifact immutable reference is out of range');
    for (let i = start * 2; i < to; i += 1) characters[i] = '0';
  }
  return characters.join('');
}

// The address stored in an immutable word, taken from its low 20 bytes as Solidity right-aligns it.
function immutableRangeAddress(codeHex: string, range: ImmutableRange): string {
  return toEvmAddress(`0x${immutableRangeLow20(codeHex, range)}`);
}

// When a masked immutable range corresponds to a declared proxy relationship (--admin/--beacon), the
// on-chain immutable value must equal that flag, so masking the range for the code comparison cannot
// let a proxy pointing at a different admin or beacon be adopted.
function assertImmutableRelationship(
  kind: string,
  actual: string,
  references: AdoptReferences,
  onchainHex: string,
  ranges: ImmutableRange[],
): void {
  const requirement = PROXY_SLOTS.get(kind);
  if (requirement === undefined) return;
  const declared = references[requirement.flag];
  if (declared === undefined) return;
  const expected = requireNonzeroEvmAddress(declared, requirement.label);
  for (const range of ranges) {
    // Only a full 32-byte word can carry an address immutable; narrower immutables hold other data.
    if (range.length < 20) continue;
    if (immutableRangeAddress(onchainHex, range) !== expected) {
      throw new Error(`The ${kind} ${requirement.label} immutable at ${actual} does not match --${requirement.flag}`);
    }
  }
}

async function readSlotAddress(upstream: UpstreamClient, target: string, slot: string): Promise<string> {
  const value = await upstream.request('eth_getStorageAt', [target, slot, 'latest']);
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) {
    throw new Error('TRON node returned invalid slot storage');
  }
  try {
    return toEvmAddress(`0x${value.slice(-40)}`);
  } catch (error) {
    throw new Error('TRON node returned an invalid slot address', { cause: error });
  }
}

// Refuse any reference flag not valid for the adopted kind rather than silently ignoring it: each
// kind's slot reference and controller-value reference are the only flags it accepts, and a plain
// contract or a beacon/proxy-admin kind accepts none.
function assertReferenceFlagsValid(kind: string, references: AdoptReferences): void {
  const allowed = KIND_REFERENCE_FLAGS.get(kind) ?? [];
  for (const flag of REFERENCE_FLAGS) {
    if (references[flag] !== undefined && !allowed.includes(flag)) {
      throw new Error(`--${flag} is not valid for a ${kind} adoption`);
    }
  }
}

async function assertProxyReferences(
  upstream: UpstreamClient,
  kind: string,
  actual: string,
  references: AdoptReferences,
): Promise<void> {
  const requirement = PROXY_SLOTS.get(kind);
  if (requirement === undefined) return;
  const declared = references[requirement.flag];
  if (declared === undefined) throw new Error(`A ${kind} adoption requires --${requirement.flag}`);
  const expected = requireNonzeroEvmAddress(declared, requirement.label);
  const stored = await readSlotAddress(upstream, actual, requirement.slot);
  if (stored !== expected) {
    throw new Error(`The ${kind} ${requirement.label} slot at ${actual} does not match --${requirement.flag}`);
  }
}

// Verify, against live on-chain state, that the controller a proxy delegates upgrade authority to
// answers with the operator-declared controlling address: a transparent proxy's ProxyAdmin owner()
// must equal --owner, a beacon proxy's UpgradeableBeacon implementation() must equal --impl. The call
// targets the declared controller (its on-chain address, proven equal to the proxy's slot by
// assertProxyReferences); --owner/--impl are actual on-chain addresses, so the returned value is
// compared in actual space. A missing reference, a transport failure, a non-address (including an
// empty) return, or a mismatch fails the adoption closed rather than binding a proxy to a controller
// that cannot perform the upgrade the reverse-mapped world will route to it.
async function assertProxyController(
  upstream: UpstreamClient,
  kind: string,
  references: AdoptReferences,
): Promise<void> {
  const controller = PROXY_CONTROLLER.get(kind);
  if (controller === undefined) return;
  const calleeDeclared = references[controller.calleeFlag];
  // assertProxyReferences already requires the callee flag for these kinds; this guard keeps the check
  // resilient to unusual adopt orderings rather than assuming the reference is present.
  if (calleeDeclared === undefined) return;
  const callee = requireNonzeroEvmAddress(calleeDeclared, controller.label);
  const expectedDeclared = references[controller.expectFlag];
  if (expectedDeclared === undefined) throw new Error(`A ${kind} adoption requires --${controller.expectFlag}`);
  const expected = requireNonzeroEvmAddress(expectedDeclared, controller.label);
  let result: JsonAny;
  try {
    result = await upstream.request('eth_call', [{ to: callee, data: controller.selector }, 'latest']);
  } catch (error) {
    throw new Error(`The ${kind} ${controller.label} controller check at ${callee} failed`, { cause: error });
  }
  if (typeof result !== 'string' || !/^0x[0-9a-f]{64}$/i.test(result)) {
    throw new Error(`The ${kind} ${controller.label} controller check at ${callee} returned no address`);
  }
  let controllerValue: string;
  try {
    controllerValue = toEvmAddress(`0x${result.slice(-40)}`);
  } catch (error) {
    throw new Error(`The ${kind} ${controller.label} controller check at ${callee} returned no address`, {
      cause: error,
    });
  }
  if (controllerValue !== expected) {
    throw new Error(`The ${kind} ${controller.label} does not match --${controller.expectFlag}`);
  }
}

// Verify, against live on-chain state, that a STANDALONE controller answers its own control selector
// with the operator-declared value: a proxy-admin's owner() must equal --owner, an upgradeable-beacon's
// implementation() must equal --impl. The call targets the adopted contract's own on-chain address. A
// missing reference, a transport failure, a non-address (including empty) return, or a mismatch fails
// the adoption closed, exactly as the proxy controller check does for its delegated controller.
async function assertSelfController(
  upstream: UpstreamClient,
  kind: string,
  actual: string,
  references: AdoptReferences,
): Promise<void> {
  const controller = SELF_CONTROLLER.get(kind);
  if (controller === undefined) return;
  const expectedDeclared = references[controller.expectFlag];
  if (expectedDeclared === undefined) throw new Error(`A ${kind} adoption requires --${controller.expectFlag}`);
  const expected = requireNonzeroEvmAddress(expectedDeclared, controller.label);
  let result: JsonAny;
  try {
    result = await upstream.request('eth_call', [{ to: actual, data: controller.selector }, 'latest']);
  } catch (error) {
    throw new Error(`The ${kind} ${controller.label} controller check at ${actual} failed`, { cause: error });
  }
  if (typeof result !== 'string' || !/^0x[0-9a-f]{64}$/i.test(result)) {
    throw new Error(`The ${kind} ${controller.label} controller check at ${actual} returned no address`);
  }
  let controllerValue: string;
  try {
    controllerValue = toEvmAddress(`0x${result.slice(-40)}`);
  } catch (error) {
    throw new Error(`The ${kind} ${controller.label} controller check at ${actual} returned no address`, {
      cause: error,
    });
  }
  if (controllerValue !== expected) {
    throw new Error(`The ${kind} ${controller.label} does not match --${controller.expectFlag}`);
  }
}

async function adoptCommand(parsed: AdoptArguments, context: ResolvedRunContext): Promise<void> {
  const config = context.parseConfig(context.environment);
  const predicted = requireNonzeroEvmAddress(parsed.predicted, 'predicted');
  const actual = requireNonzeroEvmAddress(parsed.actual, 'actual');
  const kind = requireAdoptableKind(parsed.kind);
  const nonceBaseline = parsed.nonceBaseline === undefined ? undefined : parseNonceBaseline(parsed.nonceBaseline);
  const references: AdoptReferences = {
    ...(parsed.admin === undefined ? {} : { admin: parsed.admin }),
    ...(parsed.beacon === undefined ? {} : { beacon: parsed.beacon }),
    ...(parsed.impl === undefined ? {} : { impl: parsed.impl }),
    ...(parsed.owner === undefined ? {} : { owner: parsed.owner }),
  };
  assertReferenceFlagsValid(kind, references);

  // Open durable state in refuse-on-missing mode, so adoption also fails loudly on a lost state path.
  const store = new JsonStore(config.stateFile, { createIfMissing: false });
  const upstream = context.adoptUpstream(config);

  // Hold the exclusive state lock across every verification and the single durable write, so
  // adoption can never race a live gateway that owns the same canonical state path.
  const lock = await context.acquireStateLock(config.stateFile);
  try {
    store.bindLockAssertion(() => assertStateLockHeld(lock, config.stateFile));
    await assertUpstreamChainId(upstream, config.chainId);

    const matches = context.findArtifactPaths(config.foundryOut, parsed.artifact);
    if (matches.length !== 1) {
      throw new Error(`Expected one artifact for ${parsed.artifact}, found ${matches.length}`);
    }
    const verified = context.verifyArtifactProvenance({ outputDirectory: config.foundryOut, artifactPath: matches[0] });
    const artifactIdentity = {
      sourceName: verified.sourceName,
      contractName: verified.contractName,
      fullyQualifiedName: verified.fullyQualifiedName,
    };
    const runtimeBytecodeHash = bytecodeHexHash(verified.artifact?.deployedBytecode, 'runtime bytecode');
    // An abstract contract or interface artifact has no runtime bytecode; it can never be the code
    // running at a live address, so refuse it by name rather than let its empty hash go on to compare
    // equal to a codeless address below.
    if (runtimeBytecodeHash === EMPTY_RUNTIME_CODE_HASH) {
      throw new Error(`Artifact ${verified.fullyQualifiedName} has no runtime bytecode and cannot be adopted`);
    }
    const creationBytecodeHash = bytecodeHexHash(verified.artifact?.bytecode, 'creation bytecode');

    const onchainCode = await upstream.request('eth_getCode', [actual, 'latest']);
    if (typeof onchainCode !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(onchainCode)) {
      throw new Error(`On-chain runtime code at ${actual} does not match artifact ${verified.fullyQualifiedName}`);
    }
    const onchainCodeHash = keccak256(onchainCode.toLowerCase());
    // A codeless address (nothing deployed there, or the wrong address) must be refused by name
    // rather than adopted as a match, which the empty-artifact check above guarantees can no longer
    // happen by coincidental equality of two empty hashes.
    if (onchainCodeHash === EMPTY_RUNTIME_CODE_HASH) {
      throw new Error(`No on-chain code found at ${actual}`);
    }
    // Standard OZ v5 proxies bake constructor-set values (a TransparentUpgradeableProxy's ProxyAdmin,
    // a BeaconProxy's beacon) into immutable byte ranges of their runtime code, so the live code can
    // never hash-equal the artifact template. Mask those ranges on both sides before comparing; with
    // no immutable references the comparison stays byte-exact.
    const immutableReferences = extractImmutableReferences(verified.artifact?.deployedBytecode);
    const ranges = immutableRanges(immutableReferences);
    if (ranges.length === 0) {
      if (onchainCodeHash !== runtimeBytecodeHash) {
        throw new Error(`On-chain runtime code at ${actual} does not match artifact ${verified.fullyQualifiedName}`);
      }
    } else {
      const template = runtimeBytecodeHex(verified.artifact?.deployedBytecode);
      const onchainHex = onchainCode.slice(2).toLowerCase();
      if (
        onchainHex.length !== template.length ||
        keccak256(`0x${maskImmutables(onchainHex, ranges)}`) !== keccak256(`0x${maskImmutables(template, ranges)}`)
      ) {
        throw new Error(`On-chain runtime code at ${actual} does not match artifact ${verified.fullyQualifiedName}`);
      }
      assertImmutableRelationship(kind, actual, references, onchainHex, ranges);
    }

    await assertProxyReferences(upstream, kind, actual, references);
    await assertProxyController(upstream, kind, references);
    await assertSelfController(upstream, kind, actual, references);

    // A proxy delegates upgrade authority to a controller (a transparent proxy to its ProxyAdmin, a
    // beacon proxy to its UpgradeableBeacon) whose runtime code eth_getCode must project into the
    // predicted world; that projection needs the controller's own predicted->actual mapping. Require
    // the controller be adopted first, matching the deploy-path invariant (the ProxyAdmin is mapped
    // before its proxy resolves) and failing closed here — before any state is written — rather than
    // adopting a proxy that would fail closed on every eth_getCode read. (A uups-proxy carries no role
    // immutable and needs no such controller.)
    const addressMap = new AddressMap(store, config.chainIdentity);
    if (kind === 'transparent-proxy') {
      const adminActual = requireNonzeroEvmAddress(references.admin as string, 'admin');
      if (addressMap.resolveActual(adminActual) === undefined) {
        throw new Error(`Adopt the ProxyAdmin at ${adminActual} (kind proxy-admin) before adopting this transparent proxy`);
      }
    } else if (kind === 'beacon-proxy') {
      const beaconActual = requireNonzeroEvmAddress(references.beacon as string, 'beacon');
      if (addressMap.resolveActual(beaconActual) === undefined) {
        throw new Error(`Adopt the UpgradeableBeacon at ${beaconActual} (kind upgradeable-beacon) before adopting this beacon proxy`);
      }
    }

    // Bind the deployment's upgrade-critical role immutables to the actual addresses embedded in the
    // live runtime code just verified, so a later eth_getCode read can project only these role words
    // into the predicted world. Empty for a plain contract with no role immutable.
    const descriptors = buildImmutableDescriptors(kind, actual, onchainCode, immutableReferences);
    // A transparent or beacon proxy must yield its controller role descriptor here: adopting one
    // without it would report success and then fail every eth_getCode read closed, since the proxy's
    // authorization immutable could never be projected. Canonical proxies always embed it; an artifact
    // that does not is not adoptable as a proxy kind.
    const requiredRole = kind === 'transparent-proxy' ? 'admin' : kind === 'beacon-proxy' ? 'beacon' : undefined;
    if (requiredRole !== undefined && !descriptors.some(descriptor => descriptor.role === requiredRole)) {
      throw new Error(
        `The ${kind} artifact declares no ${requiredRole} address immutable, so its code cannot be projected; it is not adoptable as ${kind}`,
      );
    }
    const referenceRanges = immutableRanges(immutableReferences);

    const sourceTransaction = keccak256(toUtf8Bytes(`adopt:${config.chainIdentity}:${predicted}:${actual}`));
    const provenanceHash = verified.provenanceHash;
    store.transaction(config.chainIdentity, chain => {
      setMappingInChain(chain, {
        predicted,
        actual,
        creator: config.expectedSender,
        sender: config.expectedSender,
        sourceTransaction,
      });
      setContractMetadataInChain(chain, {
        predicted,
        contractKind: kind,
        artifactIdentity,
        sourceTransaction,
        provenanceHash,
      });
      setArtifactSnapshotInChain(chain, {
        provenanceHash,
        artifactIdentity,
        contractKind: kind,
        abi: verified.artifact?.abi,
        creationBytecodeHash,
        runtimeBytecodeHash,
        // Persist the artifact-scoped immutable offsets so a later eth_getCode read can rebuild role
        // bindings from a fresh on-chain read even when the on-disk artifact is gone. Empty for an
        // artifact with no immutables.
        immutableReferences: referenceRanges,
      });
      // Persist the per-deployment role-immutable descriptors (keyed by predicted address) so a later
      // eth_getCode read of this adopted deployment can project only its role words into the predicted
      // world. Complete because they were bound from the live runtime code just verified above. The
      // mapping written above satisfies setDeploymentDescriptor's mapping precondition.
      setDeploymentDescriptorInChain(chain, { predicted, status: 'complete', descriptors });
      if (nonceBaseline !== undefined) {
        setNonceBaselineInChain(chain, { sender: config.expectedSender, nonce: nonceBaseline });
      }
    });

    writeJson(context.stdout, {
      status: 'adopted',
      predicted,
      actual,
      kind,
      artifact: verified.fullyQualifiedName,
      provenanceHash,
      ...(nonceBaseline === undefined ? {} : { nonceBaseline: nonceBaseline.toString() }),
    });
  } finally {
    await lock.release();
  }
}

// Resolve the artifact-scoped immutable source for a mapped deployment, used only to rebuild role
// descriptors during repair. Returns an AUTHORITATIVE source — empty ranges mean the artifact
// genuinely declares no immutables, and the paired runtime-template hash lets the zero-immutable
// branch verify on-chain code — or undefined when no trustworthy source resolves, so the caller
// leaves the record pending instead of durably asserting "nothing to project". The durable snapshot offsets are
// preferred (disk-independent); the on-disk artifact is the fallback for a legacy snapshot captured
// before the offsets field existed, honored only when its provenance still equals the provenance
// recorded for THIS deployment — a replaced-in-place (recompiled) artifact's offsets describe
// different runtime code and binding them would durably commit garbage descriptor words.
//
// The snapshot's provenance key is carried differently by the two deployment shapes, exactly as the
// eth_getCode read path resolves it: an adopted deployment records `metadata.provenanceHash` directly,
// while a normal (gateway-deployed) deployment omits it and instead points at the transaction-journal
// record via `metadata.sourceTransaction`, whose `operationContext.provenanceHash` is the key. Missing
// the journal branch would leave every normal proxy stuck pending even with valid snapshot offsets.
// An internally-created ProxyAdmin's metadata points at the PARENT proxy deployment (and provenance),
// whose offsets do not describe ProxyAdmin code: the derived child resolves its own artifact instead.
function repairImmutableRanges(
  context: ResolvedRunContext,
  config: JsonAny,
  addressMap: AddressMap,
  journal: TransactionJournal,
  metadata: ContractMetadataRecord,
): ImmutableSource | undefined {
  function ownDiskSource(expectedProvenance?: string): (ImmutableSource & { verified: JsonAny }) | undefined {
    try {
      const matches = context.findArtifactPaths(config.foundryOut, metadata.artifactIdentity.fullyQualifiedName);
      if (matches.length !== 1) return undefined;
      const verified = context.verifyArtifactProvenance({ outputDirectory: config.foundryOut, artifactPath: matches[0] });
      if (expectedProvenance !== undefined && verified.provenanceHash?.toLowerCase() !== expectedProvenance.toLowerCase()) {
        return undefined;
      }
      return {
        ranges: immutableRanges(extractImmutableReferences(verified.artifact?.deployedBytecode)),
        runtimeTemplateHash: runtimeBytecodeTemplateHash(verified.artifact?.deployedBytecode, 'runtime bytecode'),
        verified,
      };
    } catch {
      return undefined;
    }
  }
  let recordedProvenance;
  if (metadata.provenanceHash !== undefined) {
    recordedProvenance = metadata.provenanceHash;
  } else {
    const operation = journal.get(metadata.sourceTransaction)?.operationContext;
    recordedProvenance = operation?.provenanceHash ?? undefined;
    const derived = operation === undefined ? undefined : derivedTronProxyAdminIdentity(operation.artifactIdentity);
    if (
      metadata.contractKind === 'proxy-admin' &&
      derived !== undefined &&
      metadata.artifactIdentity?.fullyQualifiedName === derived.fullyQualifiedName
    ) {
      // The derived child has no recorded provenance of its own; its artifact binds by verified
      // identity, exactly as the eth_getCode metadata resolution accepts it.
      return ownDiskSource();
    }
  }
  if (recordedProvenance === undefined || recordedProvenance === null) return undefined;
  const snapshot = addressMap.resolveArtifactSnapshot(recordedProvenance);
  if (snapshot?.immutableReferences !== undefined) {
    return { ranges: snapshot.immutableReferences, runtimeTemplateHash: snapshot.runtimeBytecodeHash };
  }
  const disk = ownDiskSource(String(recordedProvenance));
  if (disk === undefined) return undefined;
  // Disk-resolved offsets must not stay disk-dependent, or a later read after the artifact is cleaned
  // away would fail the completed proxy closed forever. Persist them into the legacy snapshot (an
  // offsets-only enrichment the snapshot store reconciles in place), then treat the source as resolved
  // ONLY if that persistence is durable — no snapshot to enrich, or a write refusal, leaves the record
  // pending (retryable) rather than completing it from a value that cannot survive artifact removal.
  if (snapshot === undefined) {
    // The confirm flow writes mapping/metadata and the artifact snapshot in two separate durable
    // transactions; a crash between them leaves a confirmed deployment with no snapshot that no read
    // path recovers once the artifact drifts. Rebuild the full envelope exactly as the deploy path
    // derives it (the creation hash covers the linked prefix recovered from the journaled initcode).
    // Scoped to journal-provenance deployments: an adopted record commits its snapshot with its mapping.
    if (metadata.provenanceHash !== undefined) return undefined;
    const record = journal.get(metadata.sourceTransaction);
    const operation = record?.operationContext;
    if (
      record?.state !== 'confirmed' ||
      operation?.kind !== 'deployment' ||
      operation.predictedContractAddress !== metadata.predicted ||
      operation.artifactIdentity?.fullyQualifiedName !== metadata.artifactIdentity?.fullyQualifiedName
    ) {
      return undefined;
    }
    try {
      const decoded = context.decodeLegacyTransaction(record.signedEthereumTransaction, {
        expectedSender: config.expectedSender,
        expectedChainId: config.chainId,
      });
      if (decoded.kind !== 'deployment') return undefined;
      const match = context.matchDeploymentArtifact({ outputDirectory: config.foundryOut, initcode: decoded.data });
      if (
        match.fullyQualifiedName !== metadata.artifactIdentity.fullyQualifiedName ||
        match.provenanceHash?.toLowerCase() !== String(recordedProvenance).toLowerCase()
      ) {
        return undefined;
      }
      addressMap.setArtifactSnapshot({
        provenanceHash: recordedProvenance,
        artifactIdentity: metadata.artifactIdentity,
        contractKind: operation.contractKind,
        abi: disk.verified.artifact?.abi,
        creationBytecodeHash: bytecodeHexHash(match.creationBytecode, 'creation bytecode'),
        runtimeBytecodeHash: disk.runtimeTemplateHash,
        immutableReferences: disk.ranges,
      });
    } catch {
      // A decode, rematch, or write failure leaves the deployment snapshot-less exactly as before,
      // repairable once the matching artifact (or a writable snapshot slot) is back.
      return undefined;
    }
    return disk;
  }
  try {
    addressMap.setArtifactSnapshot({ ...snapshot, immutableReferences: disk.ranges });
  } catch {
    return undefined;
  }
  return disk;
}

// Durably backfill missing or pending deployment descriptors, holding the exclusive state lock like
// adopt. For every mapped deployment lacking a completed descriptor it rebuilds the role immutables
// from a fresh on-chain read against the artifact-scoped offsets, writing `complete` only when the read
// yields the required role (for a proxy) and `pending` otherwise, so a stuck pending from a past
// transient failure is retried and cleared. Idempotent: a deployment already `complete` is skipped.
async function repairCommand(context: ResolvedRunContext): Promise<void> {
  const config = context.parseConfig(context.environment);
  const store = new JsonStore(config.stateFile, { createIfMissing: false });
  const upstream = context.adoptUpstream(config);
  const lock = await context.acquireStateLock(config.stateFile);
  try {
    store.bindLockAssertion(() => assertStateLockHeld(lock, config.stateFile));
    await assertUpstreamChainId(upstream, config.chainId);
    const addressMap = new AddressMap(store, config.chainIdentity);
    const journal = new TransactionJournal(store, config.chainIdentity, { allowRecovery: true });
    let completed = 0;
    let pending = 0;
    for (const mapping of addressMap.list()) {
      const predicted = mapping.predicted;
      const metadata = addressMap.resolveContractMetadata(predicted);
      if (metadata === undefined) continue;
      if (addressMap.resolveDeploymentDescriptor(predicted)?.status === 'complete') continue;
      const kind = metadata.contractKind;
      const proxyKind = kind === 'transparent-proxy' || kind === 'beacon-proxy';
      const source = repairImmutableRanges(context, config, addressMap, journal, metadata);
      // UNRESOLVABLE offsets (legacy snapshot without the field, no provenance-matched disk artifact)
      // are not "no immutables": completing empty would durably assert nothing-to-project for a
      // deployment whose immutables are simply unknown. The record stays pending for a later repair.
      if (source === undefined) {
        try {
          addressMap.setDeploymentDescriptor({ predicted, status: 'pending', descriptors: [] });
          pending += 1;
        } catch {
          // A transition refusal leaves the record unchanged.
        }
        continue;
      }
      // An artifact with no address-width immutable has nothing to project: complete it empty. A plain
      // contract needs no upstream read (it never fails closed). A proxy kind (a zero-immutable proxy
      // keeps its admin/beacon only in the ERC-1967 storage slots) must first prove the on-chain code
      // equals the artifact's runtime template — provenance does not bind the reference map, so empty
      // ranges alone cannot prove the code embeds no live role address; an unverifiable read stays
      // pending, mirroring the eth_getCode zero-immutable gate.
      if (!hasAddressWidthRange(source.ranges)) {
        let verified = !proxyKind;
        if (proxyKind) {
          try {
            const code = await upstream.request('eth_getCode', [mapping.actual, 'latest']);
            verified = codeMatchesRuntimeTemplate(code, source);
          } catch {
            // An unreadable code body cannot prove template equality; the record stays pending.
          }
        }
        try {
          addressMap.setDeploymentDescriptor({ predicted, status: verified ? 'complete' : 'pending', descriptors: [] });
          if (verified) completed += 1;
          else pending += 1;
        } catch {
          // A transition refusal leaves the record unchanged.
        }
        continue;
      }
      const ranges = source.ranges;
      let status: 'pending' | 'complete' = 'pending';
      let descriptors: ReturnType<typeof buildDescriptorsFromRanges> = [];
      try {
        const code = await upstream.request('eth_getCode', [mapping.actual, 'latest']);
        if (typeof code === 'string' && /^0x(?:[0-9a-f]{2})+$/i.test(code)) {
          const built = buildDescriptorsFromRanges(kind, mapping.actual, code, ranges);
          const requiredRole = kind === 'transparent-proxy' ? 'admin' : kind === 'beacon-proxy' ? 'beacon' : undefined;
          if (requiredRole === undefined || built.some(descriptor => descriptor.role === requiredRole)) {
            status = 'complete';
            descriptors = built;
          }
        }
      } catch {
        // A read failure leaves the record pending, to be retried by a later repair.
      }
      try {
        addressMap.setDeploymentDescriptor({ predicted, status, descriptors });
        if (status === 'complete') completed += 1;
        else pending += 1;
      } catch {
        // A transition refusal (e.g. a record that raced to complete) leaves it unchanged.
      }
    }
    writeJson(context.stdout, { status: 'repaired', completed, pending });
  } finally {
    await lock.release();
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
    verifyArtifactProvenance: options.verifyArtifactProvenance ?? verifyArtifactProvenance,
    findArtifactPaths: options.findArtifactPaths ?? findArtifactPaths,
    decodeLegacyTransaction: options.decodeLegacyTransaction ?? decodeLegacyTransaction,
    matchDeploymentArtifact: options.matchDeploymentArtifact ?? matchDeploymentArtifact,
    acquireStateLock: options.acquireStateLock ?? acquireStateLock,
    adoptUpstream:
      options.upstreamClient !== undefined
        ? () => options.upstreamClient as UpstreamClient
        : (config: JsonAny) =>
            createUpstreamClient(config.jsonRpcEndpoint, options.fetch === undefined ? {} : { fetch: options.fetch }),
  };
  try {
    const parsed = parseArguments(argv);
    if (parsed.command === 'help') {
      context.stdout.write(USAGE);
    } else if (parsed.command === 'init') {
      const config = context.parseStateConfig(context.environment);
      const stateFile = createStateFile(config.stateFile);
      writeJson(context.stdout, { status: 'initialized', chainIdentity: config.chainIdentity, stateFile });
    } else if (parsed.command === 'adopt') {
      await adoptCommand(parsed, context);
    } else if (parsed.command === 'repair') {
      await repairCommand(context);
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
