import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { keccak256, toBeHex } from 'ethers';

import { AddressMap } from '../../dist/rpc/address-map.js';
import { createRpcHandlers } from '../../dist/rpc/handlers.js';
import { TransactionJournal } from '../../dist/rpc/journal.js';
import { JsonStore, createStateFile } from '../../dist/rpc/store.js';
import { run } from '../../dist/rpc/cli.js';

// Fixtures for the adopt command are deliberately loosely shaped, mirroring the external,
// dynamically-shaped data the CLI and handlers validate at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonAny = any;

const CHAIN_ID = 728126428n;
const CHAIN = `tre:${CHAIN_ID}`;
const EXPECTED_SENDER = `0x${'11'.repeat(20)}`;
const PREDICTED = `0x${'a1'.repeat(20)}`;
const ACTUAL = `0x${'b2'.repeat(20)}`;
const IMPL = `0x${'c3'.repeat(20)}`;
const ADMIN = `0x${'d4'.repeat(20)}`;
const BEACON = `0x${'e5'.repeat(20)}`;
const RUNTIME_HEX = '0x60806040527f00';
const CREATION_HEX = '0x60806040523415';
const ABI: JsonAny[] = [
  { type: 'function', name: 'value', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256', name: '' }] },
  { type: 'function', name: 'setValue', stateMutability: 'nonpayable', inputs: [{ type: 'uint256', name: 'v' }], outputs: [] },
];
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';

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

function fixture(t: TestContext): JsonAny {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-tron-adopt-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'state.json');
  const foundryOut = path.join(directory, 'out');
  fs.mkdirSync(foundryOut);
  createStateFile(stateFile);
  const config = {
    network: 'tre',
    chainId: CHAIN_ID,
    chainIdentity: CHAIN,
    stateFile,
    foundryOut,
    jsonRpcEndpoint: 'http://127.0.0.1:9090/jsonrpc',
    expectedSender: EXPECTED_SENDER,
  };
  return { directory, stateFile, foundryOut, config };
}

function slotWord(address: string): string {
  return toBeHex(BigInt(address), 32);
}

// A node stub answering the reads adopt performs: chain-id assertion, runtime code, and TRC-1967
// slot values. Overrides replace individual responses to drive the mismatch paths.
function nodeStub(overrides: JsonAny = {}): JsonAny {
  const slots: JsonAny = {
    [IMPLEMENTATION_SLOT]: slotWord(IMPL),
    [ADMIN_SLOT]: slotWord(ADMIN),
    [BEACON_SLOT]: slotWord(BEACON),
    ...(overrides.slots ?? {}),
  };
  return {
    async request(method: string, params: JsonAny[]): Promise<JsonAny> {
      if (method === 'eth_chainId') return `0x${CHAIN_ID.toString(16)}`;
      if (method === 'eth_getCode') return overrides.code ?? RUNTIME_HEX;
      if (method === 'eth_getStorageAt') return slots[params[1]] ?? `0x${'00'.repeat(32)}`;
      throw new Error(`unexpected upstream method ${method}`);
    },
  };
}

function verification(overrides: JsonAny = {}): JsonAny {
  const sourceName = overrides.sourceName ?? 'contracts/Box.sol';
  const contractName = overrides.contractName ?? 'Box';
  return {
    artifact: {
      abi: overrides.abi ?? ABI,
      bytecode: { object: CREATION_HEX },
      deployedBytecode: {
        object: overrides.deployedBytecode ?? RUNTIME_HEX,
        ...(overrides.immutableReferences === undefined ? {} : { immutableReferences: overrides.immutableReferences }),
      },
    },
    artifactPath: `${sourceName}:${contractName}`,
    sourceName,
    contractName,
    fullyQualifiedName: `${sourceName}:${contractName}`,
    provenanceHash: overrides.provenanceHash ?? `0x${'77'.repeat(32)}`,
    creationBytecodeHash: overrides.creationBytecodeHash ?? `0x${'88'.repeat(32)}`,
  };
}

function adoptOptions(context: JsonAny, overrides: JsonAny = {}): JsonAny {
  return {
    environment: {},
    stdout: overrides.stdout ?? output().stream,
    stderr: overrides.stderr ?? output().stream,
    parseConfig: () => context.config,
    upstreamClient: overrides.upstream ?? nodeStub(overrides.node ?? {}),
    findArtifactPaths: overrides.findArtifactPaths ?? ((_out: string, _reference: string) => ['/out/Box.sol/Box.json']),
    verifyArtifactProvenance: overrides.verifyArtifactProvenance ?? (() => verification(overrides.verification ?? {})),
  };
}

function adoptArgs(overrides: JsonAny = {}): string[] {
  const flags = {
    '--predicted': PREDICTED,
    '--actual': ACTUAL,
    '--artifact': 'contracts/Box.sol:Box',
    '--kind': 'contract',
    ...overrides,
  };
  return ['adopt', ...Object.entries(flags).flatMap(([flag, value]) => [flag, String(value)])];
}

function freshMap(stateFile: string): AddressMap {
  return new AddressMap(new JsonStore(stateFile, { createIfMissing: false }), CHAIN);
}

test('adopts a verified bare implementation deployment into gateway state', async t => {
  const context = fixture(t);
  const stdout = output();
  const exitCode = await run(adoptArgs(), adoptOptions(context, { stdout: stdout.stream }));
  assert.equal(exitCode, 0);

  const map = freshMap(context.stateFile);
  const mapping = map.resolvePredicted(PREDICTED);
  assert.equal(mapping?.actual, ACTUAL);
  const metadata = map.resolveContractMetadata(PREDICTED);
  assert.equal(metadata?.contractKind, 'contract');
  assert.equal(metadata?.artifactIdentity.fullyQualifiedName, 'contracts/Box.sol:Box');
  assert.equal(metadata?.provenanceHash, `0x${'77'.repeat(32)}`);
  const snapshot = map.resolveArtifactSnapshot(`0x${'77'.repeat(32)}`);
  assert.deepEqual(snapshot?.abi, ABI);
  assert.equal(snapshot?.runtimeBytecodeHash, keccak256(RUNTIME_HEX));

  const reported = JSON.parse(stdout.read());
  assert.equal(reported.status, 'adopted');
  assert.equal(reported.predicted, PREDICTED);
  assert.equal(reported.actual, ACTUAL);
});

test('adopts each proxy kind only when its TRC-1967 slot matches the declared address', async t => {
  const cases: Array<[string, string, string]> = [
    ['uups-proxy', '--impl', IMPL],
    ['transparent-proxy', '--admin', ADMIN],
    ['beacon-proxy', '--beacon', BEACON],
  ];
  for (const [kind, flag, value] of cases) {
    const context = fixture(t);
    const exitCode = await run(adoptArgs({ '--kind': kind, [flag]: value }), adoptOptions(context));
    assert.equal(exitCode, 0, kind);
    const metadata = freshMap(context.stateFile).resolveContractMetadata(PREDICTED);
    assert.equal(metadata?.contractKind, kind, kind);
  }
});

// A transparent-proxy-style runtime whose only immutable is the constructor-set ProxyAdmin address:
// the artifact template carries a zeroed 32-byte immutable word (bytes 2..33), while the live code
// carries the admin in that word's low 20 bytes. An exact hash comparison could never match them.
const PROXY_IMMUTABLE_REFERENCES = { '77': [{ start: 2, length: 32 }] };
const PROXY_TEMPLATE = `0x6080${'00'.repeat(32)}6000`;
const PROXY_ONCHAIN = `0x6080${'00'.repeat(12)}${'d4'.repeat(20)}6000`;

test('adopts a proxy whose constructor-set immutable admin is baked into the runtime code', async t => {
  const context = fixture(t);
  const exitCode = await run(
    adoptArgs({ '--kind': 'transparent-proxy', '--admin': ADMIN }),
    adoptOptions(context, {
      node: { code: PROXY_ONCHAIN },
      verification: { deployedBytecode: PROXY_TEMPLATE, immutableReferences: PROXY_IMMUTABLE_REFERENCES },
    }),
  );
  assert.equal(exitCode, 0);
  const metadata = freshMap(context.stateFile).resolveContractMetadata(PREDICTED);
  assert.equal(metadata?.contractKind, 'transparent-proxy');
});

test('refuses adoption when the on-chain immutable admin does not match --admin', async t => {
  const context = fixture(t);
  const stderr = output();
  const wrongAdmin = `0x${'ee'.repeat(20)}`;
  // Point the admin slot at the mismatched flag so the slot check would pass; the on-chain immutable
  // (ADMIN) still disagrees with --admin, isolating the immutable-value verification.
  const exitCode = await run(
    adoptArgs({ '--kind': 'transparent-proxy', '--admin': wrongAdmin }),
    adoptOptions(context, {
      stderr: stderr.stream,
      node: { code: PROXY_ONCHAIN, slots: { [ADMIN_SLOT]: slotWord(wrongAdmin) } },
      verification: { deployedBytecode: PROXY_TEMPLATE, immutableReferences: PROXY_IMMUTABLE_REFERENCES },
    }),
  );
  assert.equal(exitCode, 1);
  assert.match(stderr.read(), /immutable/i);
  assert.equal(freshMap(context.stateFile).resolvePredicted(PREDICTED), undefined);
});

test('refuses adoption when on-chain runtime code does not match the artifact', async t => {
  const context = fixture(t);
  const stderr = output();
  const exitCode = await run(
    adoptArgs(),
    adoptOptions(context, { stderr: stderr.stream, node: { code: "0xdeadbeef" } }),
  );
  assert.equal(exitCode, 1);
  assert.match(stderr.read(), /runtime code/i);
  assert.equal(freshMap(context.stateFile).resolvePredicted(PREDICTED), undefined);
});

test('refuses adoption when the artifact has no runtime bytecode', async t => {
  const context = fixture(t);
  const stderr = output();
  const exitCode = await run(
    adoptArgs(),
    adoptOptions(context, { stderr: stderr.stream, node: { code: '0x' }, verification: { deployedBytecode: '0x' } }),
  );
  assert.equal(exitCode, 1);
  const message = stderr.read();
  assert.match(message, /has no runtime bytecode/i);
  assert.ok(message.includes('contracts/Box.sol:Box'), message);
  assert.equal(freshMap(context.stateFile).resolvePredicted(PREDICTED), undefined);
});

test('refuses adoption when the on-chain address has no code', async t => {
  const context = fixture(t);
  const stderr = output();
  const exitCode = await run(adoptArgs(), adoptOptions(context, { stderr: stderr.stream, node: { code: '0x' } }));
  assert.equal(exitCode, 1);
  const message = stderr.read();
  assert.match(message, /no on-chain code found/i);
  assert.ok(message.includes(ACTUAL), message);
  assert.equal(freshMap(context.stateFile).resolvePredicted(PREDICTED), undefined);
});

test('refuses each proxy kind when its TRC-1967 slot disagrees with the declared address', async t => {
  const wrong = `0x${'99'.repeat(20)}`;
  const cases: Array<[string, string, string]> = [
    ['uups-proxy', '--impl', IMPLEMENTATION_SLOT],
    ['transparent-proxy', '--admin', ADMIN_SLOT],
    ['beacon-proxy', '--beacon', BEACON_SLOT],
  ];
  for (const [kind, flag, slot] of cases) {
    const context = fixture(t);
    const stderr = output();
    const value = flag === '--impl' ? IMPL : flag === '--admin' ? ADMIN : BEACON;
    const exitCode = await run(
      adoptArgs({ '--kind': kind, [flag]: value }),
      adoptOptions(context, { stderr: stderr.stream, node: { slots: { [slot]: slotWord(wrong) } } }),
    );
    assert.equal(exitCode, 1, kind);
    assert.match(stderr.read(), /slot/i, kind);
    assert.equal(freshMap(context.stateFile).resolvePredicted(PREDICTED), undefined, kind);
  }
});

test('refuses a reference flag that belongs to a different proxy kind', async t => {
  const context = fixture(t);
  const stderr = output();
  // --admin describes the transparent-proxy admin slot; it is irrelevant to a uups-proxy adoption
  // and must be refused rather than silently ignored.
  const exitCode = await run(
    adoptArgs({ '--kind': 'uups-proxy', '--admin': ADMIN }),
    adoptOptions(context, { stderr: stderr.stream }),
  );
  assert.equal(exitCode, 1);
  assert.match(stderr.read(), /--admin is not valid for a uups-proxy adoption/i);
  assert.equal(freshMap(context.stateFile).resolvePredicted(PREDICTED), undefined);
});

test('refuses adoption when artifact provenance verification fails', async t => {
  const context = fixture(t);
  const stderr = output();
  const exitCode = await run(
    adoptArgs(),
    adoptOptions(context, {
      stderr: stderr.stream,
      verifyArtifactProvenance: () => {
        throw Object.assign(new Error('Artifact provenance failed (BYTECODE_MISMATCH)'), { code: 'BYTECODE_MISMATCH' });
      },
    }),
  );
  assert.equal(exitCode, 1);
  assert.match(stderr.read(), /provenance/i);
  assert.equal(freshMap(context.stateFile).resolvePredicted(PREDICTED), undefined);
});

test('stores an explicit nonce baseline when provided', async t => {
  const context = fixture(t);
  const exitCode = await run(adoptArgs({ '--nonce-baseline': '7' }), adoptOptions(context));
  assert.equal(exitCode, 0);
  assert.equal(freshMap(context.stateFile).resolveNonceBaseline(EXPECTED_SENDER), 7n);
});

test('accepts an identical re-adoption but refuses a conflicting one', async t => {
  const context = fixture(t);
  assert.equal(await run(adoptArgs(), adoptOptions(context)), 0);
  // Identical inputs are idempotent.
  assert.equal(await run(adoptArgs(), adoptOptions(context)), 0);

  // A different on-chain address for the same predicted address is a conflict.
  const stderr = output();
  const conflicting = await run(
    adoptArgs({ '--actual': `0x${'cc'.repeat(20)}` }),
    adoptOptions(context, { stderr: stderr.stream, node: { code: RUNTIME_HEX } }),
  );
  assert.equal(conflicting, 1);
  assert.match(stderr.read(), /conflict/i);
  assert.equal(freshMap(context.stateFile).resolvePredicted(PREDICTED)?.actual, ACTUAL);
});

test('an adopted deployment resolves through the CLI and drives an ABI-aware handler call', async t => {
  const context = fixture(t);
  assert.equal(await run(adoptArgs(), adoptOptions(context)), 0);

  // resolve/mappings surface the adopted deployment.
  const resolved = output();
  assert.equal(
    await run(['resolve', PREDICTED], {
      environment: { TRON_STATE_FILE: context.stateFile },
      stdout: resolved.stream,
      stderr: output().stream,
      parseStateConfig: () => ({ network: 'tre', chainId: CHAIN_ID, chainIdentity: CHAIN, stateFile: context.stateFile }),
    }),
    0,
  );
  const resolution = JSON.parse(resolved.read());
  assert.equal(resolution.metadata.provenanceHash, `0x${'77'.repeat(32)}`);

  // A call through the handlers resolves the adopted contract's ABI from the snapshot.
  const store = new JsonStore(context.stateFile, { createIfMissing: false });
  const addressMap = new AddressMap(store, CHAIN);
  const journal = new TransactionJournal(store, CHAIN, { ownerId: 'boot-adopt', allowRecovery: false });
  let seenAbi: JsonAny;
  const handlers = createRpcHandlers({
    config: {
      chainId: CHAIN_ID,
      chainIdentity: CHAIN,
      expectedSender: EXPECTED_SENDER,
      foundryOut: context.foundryOut,
      stateFile: context.stateFile,
    },
    journal,
    addressMap,
    reconciler: { recordPreparedNative: () => ({}), reconcile: () => ({}) },
    nativeClient: {
      assertSimulationReady: async () => 'exact-signed',
      buildCreate: async () => ({}),
      buildCall: async () => ({}),
      simulateSigned: async () => ({}),
      broadcastSigned: async () => ({}),
      getTransaction: async () => null,
      waitForReceipt: async () => ({}),
    },
    upstream: { async request() {
      return `0x${'00'.repeat(32)}`;
    } },
    rewriteCall: async (transaction: JsonAny, callContext: JsonAny) => {
      seenAbi = callContext.abi;
      return { to: transaction.to, data: transaction.data };
    },
  });

  await handlers.dispatch('eth_call', [{ to: PREDICTED, data: '0x3fa4f245' }, 'latest']);
  assert.deepEqual(seenAbi, ABI);
});
