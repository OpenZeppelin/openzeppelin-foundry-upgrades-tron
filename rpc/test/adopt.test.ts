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
// The controller a proxy's admin/beacon answers with: a ProxyAdmin.owner() (transparent, --owner) and
// an UpgradeableBeacon.implementation() (beacon, --impl). Matches the default nodeStub eth_call return.
const CONTROLLER = `0x${'0c'.repeat(20)}`;
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
      // The H1 liveness cross-check: a ProxyAdmin.owner()/UpgradeableBeacon.implementation() call. By
      // default answer with a valid 32-byte address word so the live controller reads as responsive;
      // `overrides.call` (a value, a throwing thunk, or a per-target map) drives the fail-closed paths.
      if (method === 'eth_call') {
        const call = overrides.call;
        if (typeof call === 'function') return call(params);
        if (call !== undefined) return call;
        return slotWord(`0x${'0c'.repeat(20)}`);
      }
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

// A proxy delegates upgrade authority to a controller whose runtime code eth_getCode must project, so a
// transparent/beacon proxy can only be adopted after its ProxyAdmin/UpgradeableBeacon is. These helpers
// adopt that controller first (a distinct predicted/actual, a distinct provenance hash so its artifact
// snapshot does not collide with the proxy's), matching the deploy-path controller-first invariant.
const ADMIN_PREDICTED = `0x${'a9'.repeat(20)}`;
const BEACON_PREDICTED = `0x${'b9'.repeat(20)}`;
const CONTROLLER_PROVENANCE = `0x${'66'.repeat(32)}`;

async function adoptProxyAdmin(context: JsonAny): Promise<number> {
  return run(
    adoptArgs({ '--predicted': ADMIN_PREDICTED, '--actual': ADMIN, '--kind': 'proxy-admin', '--owner': CONTROLLER }),
    adoptOptions(context, { verification: { provenanceHash: CONTROLLER_PROVENANCE } }),
  );
}

async function adoptBeaconController(context: JsonAny): Promise<number> {
  return run(
    adoptArgs({ '--predicted': BEACON_PREDICTED, '--actual': BEACON, '--kind': 'upgradeable-beacon', '--impl': CONTROLLER }),
    adoptOptions(context, { verification: { provenanceHash: CONTROLLER_PROVENANCE } }),
  );
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
  // Each proxy kind's required flags: uups needs its impl slot; a transparent proxy needs its admin
  // slot plus the ProxyAdmin owner it answers with (--owner); a beacon proxy needs its beacon slot plus
  // the implementation the beacon answers with (--impl).
  const cases: Array<[string, Record<string, string>]> = [
    ['uups-proxy', { '--impl': IMPL }],
    ['transparent-proxy', { '--admin': ADMIN, '--owner': CONTROLLER }],
    ['beacon-proxy', { '--beacon': BEACON, '--impl': CONTROLLER }],
  ];
  for (const [kind, flags] of cases) {
    const context = fixture(t);
    // A transparent/beacon proxy requires its controller adopted first, and a canonical proxy artifact
    // always embeds that controller as a runtime immutable — model both so adoption can bind it.
    if (kind === 'transparent-proxy') assert.equal(await adoptProxyAdmin(context), 0, `${kind} controller`);
    if (kind === 'beacon-proxy') assert.equal(await adoptBeaconController(context), 0, `${kind} controller`);
    const options =
      kind === 'uups-proxy'
        ? adoptOptions(context)
        : adoptOptions(context, {
            node: { code: proxyOnchainCode(kind === 'transparent-proxy' ? ADMIN : BEACON) },
            verification: { deployedBytecode: PROXY_TEMPLATE, immutableReferences: PROXY_IMMUTABLE_REFERENCES },
          });
    const exitCode = await run(adoptArgs({ '--kind': kind, ...flags }), options);
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
// The live runtime code with a controller address baked into the immutable word's low 20 bytes.
function proxyOnchainCode(controller: string): string {
  return `0x6080${'00'.repeat(12)}${controller.slice(2)}6000`;
}
const PROXY_ONCHAIN = proxyOnchainCode(ADMIN);

test('adopts a proxy whose constructor-set immutable admin is baked into the runtime code', async t => {
  const context = fixture(t);
  assert.equal(await adoptProxyAdmin(context), 0);
  const exitCode = await run(
    adoptArgs({ '--kind': 'transparent-proxy', '--admin': ADMIN, '--owner': CONTROLLER }),
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
    adoptArgs({ '--kind': 'transparent-proxy', '--admin': wrongAdmin, '--owner': CONTROLLER }),
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

// H1: a transparent proxy's ProxyAdmin must answer owner() with the operator-declared --owner, and a
// beacon proxy's UpgradeableBeacon must answer implementation() with the operator-declared --impl. A
// reverting/empty controller, a value mismatch, or a missing flag is refused.
test('refuses a transparent-proxy adoption when the ProxyAdmin owner() call reverts', async t => {
  const context = fixture(t);
  const stderr = output();
  const exitCode = await run(
    adoptArgs({ '--kind': 'transparent-proxy', '--admin': ADMIN, '--owner': CONTROLLER }),
    adoptOptions(context, {
      stderr: stderr.stream,
      node: {
        call: () => {
          throw new Error('execution reverted');
        },
      },
    }),
  );
  assert.equal(exitCode, 1);
  assert.match(stderr.read(), /controller/i);
  assert.equal(freshMap(context.stateFile).resolvePredicted(PREDICTED), undefined);
});

test('refuses a beacon-proxy adoption when the beacon implementation() returns no data', async t => {
  const context = fixture(t);
  const stderr = output();
  const exitCode = await run(
    adoptArgs({ '--kind': 'beacon-proxy', '--beacon': BEACON, '--impl': CONTROLLER }),
    adoptOptions(context, { stderr: stderr.stream, node: { call: '0x' } }),
  );
  assert.equal(exitCode, 1);
  assert.match(stderr.read(), /controller/i);
  assert.equal(freshMap(context.stateFile).resolvePredicted(PREDICTED), undefined);
});

// H1 value check: the transparent-proxy ProxyAdmin owner() must EQUAL --owner (compared in actual
// space). A correct value adopts; a wrong value or a missing --owner is refused.
test('refuses a proxy-kind adoption whose artifact declares no controller immutable', async t => {
  // An artifact with no immutableReferences cannot yield the admin/beacon role descriptor, so a later
  // eth_getCode read would fail closed forever while adopt reported success. Refuse the adoption
  // instead — before any state is written.
  const transparent = fixture(t);
  assert.equal(await adoptProxyAdmin(transparent), 0);
  const transparentErr = output();
  assert.equal(
    await run(
      adoptArgs({ '--kind': 'transparent-proxy', '--admin': ADMIN, '--owner': CONTROLLER }),
      // The default verification carries no immutableReferences: the degenerate proxy artifact.
      adoptOptions(transparent, { stderr: transparentErr.stream, node: { call: slotWord(CONTROLLER) } }),
    ),
    1,
  );
  assert.match(transparentErr.read(), /declares no admin address immutable.*not adoptable/i);
  assert.equal(freshMap(transparent.stateFile).resolvePredicted(PREDICTED), undefined);

  const beacon = fixture(t);
  assert.equal(await adoptBeaconController(beacon), 0);
  const beaconErr = output();
  assert.equal(
    await run(
      adoptArgs({ '--kind': 'beacon-proxy', '--beacon': BEACON, '--impl': CONTROLLER }),
      adoptOptions(beacon, { stderr: beaconErr.stream, node: { call: slotWord(CONTROLLER) } }),
    ),
    1,
  );
  assert.match(beaconErr.read(), /declares no beacon address immutable.*not adoptable/i);
  assert.equal(freshMap(beacon.stateFile).resolvePredicted(PREDICTED), undefined);
});

test('adopts a transparent proxy only when ProxyAdmin owner() equals --owner', async t => {
  const ok = fixture(t);
  assert.equal(await adoptProxyAdmin(ok), 0);
  assert.equal(
    await run(
      adoptArgs({ '--kind': 'transparent-proxy', '--admin': ADMIN, '--owner': CONTROLLER }),
      adoptOptions(ok, {
        node: { call: slotWord(CONTROLLER), code: PROXY_ONCHAIN },
        verification: { deployedBytecode: PROXY_TEMPLATE, immutableReferences: PROXY_IMMUTABLE_REFERENCES },
      }),
    ),
    0,
  );
  assert.equal(freshMap(ok.stateFile).resolveContractMetadata(PREDICTED)?.contractKind, 'transparent-proxy');

  const wrong = fixture(t);
  const wrongErr = output();
  assert.equal(
    await run(
      adoptArgs({ '--kind': 'transparent-proxy', '--admin': ADMIN, '--owner': CONTROLLER }),
      adoptOptions(wrong, { stderr: wrongErr.stream, node: { call: slotWord(`0x${'19'.repeat(20)}`) } }),
    ),
    1,
  );
  assert.match(wrongErr.read(), /owner\(\) does not match --owner/i);
  assert.equal(freshMap(wrong.stateFile).resolvePredicted(PREDICTED), undefined);

  const missing = fixture(t);
  const missingErr = output();
  assert.equal(
    await run(
      adoptArgs({ '--kind': 'transparent-proxy', '--admin': ADMIN }),
      adoptOptions(missing, { stderr: missingErr.stream }),
    ),
    1,
  );
  assert.match(missingErr.read(), /requires --owner/i);
  assert.equal(freshMap(missing.stateFile).resolvePredicted(PREDICTED), undefined);
});

// H1 value check: the beacon-proxy UpgradeableBeacon implementation() must EQUAL --impl. A correct
// value adopts; a wrong value or a missing --impl is refused.
test('adopts a beacon proxy only when the beacon implementation() equals --impl', async t => {
  const ok = fixture(t);
  assert.equal(await adoptBeaconController(ok), 0);
  assert.equal(
    await run(
      adoptArgs({ '--kind': 'beacon-proxy', '--beacon': BEACON, '--impl': CONTROLLER }),
      adoptOptions(ok, {
        node: { call: slotWord(CONTROLLER), code: proxyOnchainCode(BEACON) },
        verification: { deployedBytecode: PROXY_TEMPLATE, immutableReferences: PROXY_IMMUTABLE_REFERENCES },
      }),
    ),
    0,
  );
  assert.equal(freshMap(ok.stateFile).resolveContractMetadata(PREDICTED)?.contractKind, 'beacon-proxy');

  const wrong = fixture(t);
  const wrongErr = output();
  assert.equal(
    await run(
      adoptArgs({ '--kind': 'beacon-proxy', '--beacon': BEACON, '--impl': CONTROLLER }),
      adoptOptions(wrong, { stderr: wrongErr.stream, node: { call: slotWord(`0x${'19'.repeat(20)}`) } }),
    ),
    1,
  );
  assert.match(wrongErr.read(), /implementation\(\) does not match --impl/i);
  assert.equal(freshMap(wrong.stateFile).resolvePredicted(PREDICTED), undefined);

  const missing = fixture(t);
  const missingErr = output();
  assert.equal(
    await run(
      adoptArgs({ '--kind': 'beacon-proxy', '--beacon': BEACON }),
      adoptOptions(missing, { stderr: missingErr.stream }),
    ),
    1,
  );
  assert.match(missingErr.read(), /requires --impl/i);
  assert.equal(freshMap(missing.stateFile).resolvePredicted(PREDICTED), undefined);
});

// A UUPS proxy's implementation slot points at the logic contract itself, which exposes no controller
// selector, so adoption performs no controller call — a throwing eth_call stub is never reached.
test('adopts a uups-proxy without a controller call', async t => {
  const context = fixture(t);
  const exitCode = await run(
    adoptArgs({ '--kind': 'uups-proxy', '--impl': IMPL }),
    adoptOptions(context, {
      node: {
        call: () => {
          throw new Error('no controller call expected for uups-proxy');
        },
      },
    }),
  );
  assert.equal(exitCode, 0);
  assert.equal(freshMap(context.stateFile).resolveContractMetadata(PREDICTED)?.contractKind, 'uups-proxy');
});

// (c) A proxy delegates upgrade authority to a controller whose runtime code eth_getCode must project;
// that projection needs the controller mapped. Adopting a transparent/beacon proxy before its
// controller fails closed with a naming error, before any state is written.
test('refuses a transparent proxy adoption whose ProxyAdmin is not adopted first', async t => {
  const context = fixture(t);
  const stderr = output();
  const exitCode = await run(
    adoptArgs({ '--kind': 'transparent-proxy', '--admin': ADMIN, '--owner': CONTROLLER }),
    adoptOptions(context, { stderr: stderr.stream }),
  );
  assert.equal(exitCode, 1);
  assert.match(stderr.read(), /Adopt the ProxyAdmin at .* before adopting this transparent proxy/i);
  assert.equal(freshMap(context.stateFile).resolvePredicted(PREDICTED), undefined);
});

test('refuses a beacon proxy adoption whose UpgradeableBeacon is not adopted first', async t => {
  const context = fixture(t);
  const stderr = output();
  const exitCode = await run(
    adoptArgs({ '--kind': 'beacon-proxy', '--beacon': BEACON, '--impl': CONTROLLER }),
    adoptOptions(context, { stderr: stderr.stream }),
  );
  assert.equal(exitCode, 1);
  assert.match(stderr.read(), /Adopt the UpgradeableBeacon at .* before adopting this beacon proxy/i);
  assert.equal(freshMap(context.stateFile).resolvePredicted(PREDICTED), undefined);
});

// (c) Standalone controller adoptions cross-check their control value: a ProxyAdmin's owner() must
// equal --owner, an UpgradeableBeacon's implementation() must equal --impl. A wrong or missing value is
// refused; the correct value adopts (and needs no controller-first, being a controller itself).
test('adopts a standalone proxy-admin only when owner() equals --owner', async t => {
  const ok = fixture(t);
  assert.equal(await run(adoptArgs({ '--kind': 'proxy-admin', '--owner': CONTROLLER }), adoptOptions(ok)), 0);
  assert.equal(freshMap(ok.stateFile).resolveContractMetadata(PREDICTED)?.contractKind, 'proxy-admin');

  const wrong = fixture(t);
  const wrongErr = output();
  assert.equal(
    await run(
      adoptArgs({ '--kind': 'proxy-admin', '--owner': `0x${'19'.repeat(20)}` }),
      adoptOptions(wrong, { stderr: wrongErr.stream, node: { call: slotWord(CONTROLLER) } }),
    ),
    1,
  );
  assert.match(wrongErr.read(), /owner\(\) does not match --owner/i);
  assert.equal(freshMap(wrong.stateFile).resolvePredicted(PREDICTED), undefined);

  const missing = fixture(t);
  const missingErr = output();
  assert.equal(await run(adoptArgs({ '--kind': 'proxy-admin' }), adoptOptions(missing, { stderr: missingErr.stream })), 1);
  assert.match(missingErr.read(), /requires --owner/i);
});

test('adopts a standalone upgradeable-beacon only when implementation() equals --impl', async t => {
  const ok = fixture(t);
  assert.equal(await run(adoptArgs({ '--kind': 'upgradeable-beacon', '--impl': CONTROLLER }), adoptOptions(ok)), 0);
  assert.equal(freshMap(ok.stateFile).resolveContractMetadata(PREDICTED)?.contractKind, 'upgradeable-beacon');

  const wrong = fixture(t);
  const wrongErr = output();
  assert.equal(
    await run(
      adoptArgs({ '--kind': 'upgradeable-beacon', '--impl': `0x${'19'.repeat(20)}` }),
      adoptOptions(wrong, { stderr: wrongErr.stream, node: { call: slotWord(CONTROLLER) } }),
    ),
    1,
  );
  assert.match(wrongErr.read(), /implementation\(\) does not match --impl/i);
  assert.equal(freshMap(wrong.stateFile).resolvePredicted(PREDICTED), undefined);

  const missing = fixture(t);
  const missingErr = output();
  assert.equal(
    await run(adoptArgs({ '--kind': 'upgradeable-beacon' }), adoptOptions(missing, { stderr: missingErr.stream })),
    1,
  );
  assert.match(missingErr.read(), /requires --impl/i);
});

// The adopted proxy persists the artifact-scoped offsets on its snapshot and the per-deployment role
// descriptor in the deployment-descriptor index, so a later eth_getCode read can project its
// constructor-set admin into the predicted world. The admin descriptor's committed value is the admin
// embedded in the live runtime code (ADMIN, baked into PROXY_ONCHAIN).
test('persists immutable references and a complete deployment descriptor for an adopted proxy', async t => {
  const context = fixture(t);
  assert.equal(await adoptProxyAdmin(context), 0);
  const exitCode = await run(
    adoptArgs({ '--kind': 'transparent-proxy', '--admin': ADMIN, '--owner': CONTROLLER }),
    adoptOptions(context, {
      node: { code: PROXY_ONCHAIN },
      verification: { deployedBytecode: PROXY_TEMPLATE, immutableReferences: PROXY_IMMUTABLE_REFERENCES },
    }),
  );
  assert.equal(exitCode, 0);
  const map = freshMap(context.stateFile);
  const snapshot = map.resolveArtifactSnapshot(`0x${'77'.repeat(32)}`);
  assert.deepEqual(snapshot?.immutableReferences, [{ start: 2, length: 32 }]);
  assert.deepEqual(map.resolveDeploymentDescriptor(PREDICTED), {
    predicted: PREDICTED,
    status: 'complete',
    descriptors: [{ role: 'admin', start: 2, length: 32, expectedActual: ADMIN }],
  });
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
