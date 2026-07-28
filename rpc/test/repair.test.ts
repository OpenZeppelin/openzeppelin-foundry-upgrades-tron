import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { keccak256, toUtf8Bytes } from 'ethers';

import { AddressMap } from '../../dist/rpc/address-map.js';
import { TransactionJournal } from '../../dist/rpc/journal.js';
import { JsonStore, createStateFile } from '../../dist/rpc/store.js';
import { run } from '../../dist/rpc/cli.js';

// Fixtures for the repair command are deliberately loosely shaped, mirroring the external,
// dynamically-shaped data the CLI validates at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonAny = any;

const CHAIN_ID = 728126428n;
const CHAIN = `tre:${CHAIN_ID}`;
const SENDER = `0x${'11'.repeat(20)}`;
const PREDICTED = `0x${'a1'.repeat(20)}`;
const ACTUAL = `0x${'a2'.repeat(20)}`;
const ADMIN_ACTUAL = `0x${'a3'.repeat(20)}`;
const PROVENANCE = `0x${'77'.repeat(32)}`;
const IDENTITY = {
  sourceName: 'contracts/T.sol',
  contractName: 'T',
  fullyQualifiedName: 'contracts/T.sol:T',
};
const SOURCE_TX = `0x${'ab'.repeat(32)}`;
// A durable native transaction pair, shaped for the journal's native-built record.
const NATIVE_BYTES = `0a02${'42'.repeat(80)}`;
const NATIVE_TXID = 'cd'.repeat(32);

// A 32-byte immutable word at byte offset 2 (chars 4..67): 12 zero bytes then the address low 20.
function proxyRuntimeCode(embedded: string): string {
  return `0x6080${'00'.repeat(12)}${embedded.slice(2)}6000`;
}

function output(): { stream: { write(chunk: string): boolean }; read: () => string } {
  let contents = '';
  return { stream: { write(chunk: string): boolean { contents += String(chunk); return true; } }, read: () => contents };
}

function fixture(t: TestContext): JsonAny {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-tron-repair-'));
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
    expectedSender: SENDER,
  };
  return { directory, stateFile, foundryOut, config };
}

// A node stub answering repair's reads: the chain-id assertion and eth_getCode by actual address.
function nodeStub(code: Record<string, string> = {}): JsonAny {
  return {
    async request(method: string, params: JsonAny[]): Promise<JsonAny> {
      if (method === 'eth_chainId') return `0x${CHAIN_ID.toString(16)}`;
      if (method === 'eth_getCode') return code[params[0]] ?? '0x';
      throw new Error(`unexpected upstream method ${method}`);
    },
  };
}

function repairOptions(context: JsonAny, overrides: JsonAny = {}): JsonAny {
  return {
    environment: {},
    stdout: overrides.stdout ?? output().stream,
    stderr: overrides.stderr ?? output().stream,
    parseConfig: () => context.config,
    upstreamClient: overrides.upstream ?? nodeStub(overrides.code ?? {}),
    findArtifactPaths: overrides.findArtifactPaths ?? (() => []),
    verifyArtifactProvenance:
      overrides.verifyArtifactProvenance ??
      (() => {
        throw new Error('no on-disk artifact');
      }),
    ...(overrides.decodeLegacyTransaction === undefined
      ? {}
      : { decodeLegacyTransaction: overrides.decodeLegacyTransaction }),
    ...(overrides.matchDeploymentArtifact === undefined
      ? {}
      : { matchDeploymentArtifact: overrides.matchDeploymentArtifact }),
  };
}

function freshMap(stateFile: string): AddressMap {
  return new AddressMap(new JsonStore(stateFile, { createIfMissing: false }), CHAIN);
}

function seedProxy(
  map: AddressMap,
  {
    withReferences = true,
    references = [{ start: 2, length: 32 }],
    kind = 'transparent-proxy',
    runtimeBytecodeHash = `0x${'99'.repeat(32)}`,
    descriptor,
  }: { withReferences?: boolean; references?: JsonAny; kind?: string; runtimeBytecodeHash?: string; descriptor?: JsonAny } = {},
): void {
  map.set({ predicted: PREDICTED, actual: ACTUAL, creator: SENDER, sender: SENDER, sourceTransaction: SOURCE_TX });
  map.setContractMetadata({
    predicted: PREDICTED,
    contractKind: kind,
    artifactIdentity: IDENTITY,
    sourceTransaction: SOURCE_TX,
    provenanceHash: PROVENANCE,
  });
  map.setArtifactSnapshot({
    provenanceHash: PROVENANCE,
    artifactIdentity: IDENTITY,
    contractKind: kind,
    abi: [],
    creationBytecodeHash: `0x${'88'.repeat(32)}`,
    runtimeBytecodeHash,
    ...(withReferences ? { immutableReferences: references } : {}),
  });
  if (descriptor !== undefined) map.setDeploymentDescriptor(descriptor);
}

// A NORMAL (gateway-deployed) proxy: its ContractMetadataRecord omits provenanceHash and instead
// points at a confirmed transaction-journal record whose operationContext carries the provenance hash
// (exactly how a gateway deployment records provenance). The artifact snapshot is keyed by that
// journaled provenance and holds the immutable offsets. Returns the journal record hash so callers can
// key the mapping and metadata at the same source transaction the journal is keyed by.
function seedNormalProxy(
  stateFile: string,
  {
    withReferences = true,
    withSnapshot = true,
    confirm = false,
  }: { withReferences?: boolean; withSnapshot?: boolean; confirm?: boolean } = {},
): string {
  const store = new JsonStore(stateFile, { createIfMissing: false });
  const journal = new TransactionJournal(store, CHAIN, { ownerId: 'seed-owner', allowRecovery: false });
  const raw = `0x02${'42'.repeat(80)}`;
  const sourceHash = keccak256(raw);
  const operationContext = {
    kind: 'deployment',
    from: SENDER,
    to: null,
    nonce: '12',
    predictedContractAddress: PREDICTED,
    actualTarget: ACTUAL,
    contractKind: 'transparent-proxy',
    artifactIdentity: IDENTITY,
    provenanceHash: PROVENANCE,
  };
  journal.receive(raw);
  journal.recordNativeBuilt(
    sourceHash,
    { signedNativeTransaction: NATIVE_BYTES, nativeTransactionId: NATIVE_TXID },
    {
      operationContext,
      childCreatePlan: {
        version: 1,
        mode: 'exact-signed',
        sender: SENDER,
        simulationRootAddress: ACTUAL,
        attempts: [],
        counterBases: {},
        counterFinals: {},
      },
    },
  );
  if (confirm) {
    journal.recordBroadcast(sourceHash);
    journal.recordConfirmed(sourceHash, { status: '0x1' });
  }

  const map = new AddressMap(store, CHAIN);
  map.set({ predicted: PREDICTED, actual: ACTUAL, creator: SENDER, sender: SENDER, sourceTransaction: sourceHash });
  map.setContractMetadata({
    predicted: PREDICTED,
    contractKind: 'transparent-proxy',
    artifactIdentity: IDENTITY,
    sourceTransaction: sourceHash,
  });
  if (withSnapshot) {
    map.setArtifactSnapshot({
      provenanceHash: PROVENANCE,
      artifactIdentity: IDENTITY,
      contractKind: 'transparent-proxy',
      abi: [],
      creationBytecodeHash: `0x${'88'.repeat(32)}`,
      runtimeBytecodeHash: `0x${'99'.repeat(32)}`,
      ...(withReferences ? { immutableReferences: [{ start: 2, length: 32 }] } : {}),
    });
  }
  return sourceHash;
}

// (b) A pending descriptor (a capture whose post-confirmation read failed) is durably completed by a
// later verified read: repair reads the on-chain code, binds the admin role, and transitions the record
// pending -> complete. A second run is idempotent (the completed record is skipped).
test('repair completes a pending proxy descriptor from a verified read', async t => {
  const context = fixture(t);
  seedProxy(freshMap(context.stateFile), { descriptor: { predicted: PREDICTED, status: 'pending', descriptors: [] } });

  const out = output();
  assert.equal(
    await run(['repair'], repairOptions(context, { stdout: out.stream, code: { [ACTUAL]: proxyRuntimeCode(ADMIN_ACTUAL) } })),
    0,
  );
  assert.deepEqual(freshMap(context.stateFile).resolveDeploymentDescriptor(PREDICTED), {
    predicted: PREDICTED,
    status: 'complete',
    descriptors: [{ role: 'admin', start: 2, length: 32, expectedActual: ADMIN_ACTUAL }],
  });
  assert.deepEqual(JSON.parse(out.read()), { status: 'repaired', completed: 1, pending: 0 });

  // Idempotent: the completed record is skipped on a second run.
  const again = output();
  assert.equal(
    await run(['repair'], repairOptions(context, { stdout: again.stream, code: { [ACTUAL]: proxyRuntimeCode(ADMIN_ACTUAL) } })),
    0,
  );
  assert.deepEqual(JSON.parse(again.read()), { status: 'repaired', completed: 0, pending: 0 });
});

// (d) Legacy backfill: a proxy with a snapshot carrying offsets but NO descriptor record at all is
// completed by repair from those offsets.
test('repair backfills a legacy proxy with no descriptor record from snapshot offsets', async t => {
  const context = fixture(t);
  seedProxy(freshMap(context.stateFile));
  assert.equal(freshMap(context.stateFile).resolveDeploymentDescriptor(PREDICTED), undefined);

  assert.equal(
    await run(['repair'], repairOptions(context, { code: { [ACTUAL]: proxyRuntimeCode(ADMIN_ACTUAL) } })),
    0,
  );
  assert.equal(freshMap(context.stateFile).resolveDeploymentDescriptor(PREDICTED)?.status, 'complete');
});

// (d) When the snapshot predates the offsets field, repair falls back to the on-disk artifact's
// immutable references.
test('repair falls back to on-disk artifact offsets when the snapshot has none', async t => {
  const context = fixture(t);
  seedProxy(freshMap(context.stateFile), { withReferences: false });

  const verifyArtifactProvenance = () => ({
    artifact: {
      abi: [],
      bytecode: { object: '0x6000' },
      deployedBytecode: { object: '0x6001', immutableReferences: { '1': [{ start: 2, length: 32 }] } },
    },
    ...IDENTITY,
    artifactPath: '/out/T.sol/T.json',
    provenanceHash: PROVENANCE,
  });
  assert.equal(
    await run(
      ['repair'],
      repairOptions(context, {
        code: { [ACTUAL]: proxyRuntimeCode(ADMIN_ACTUAL) },
        findArtifactPaths: () => ['/out/T.sol/T.json'],
        verifyArtifactProvenance,
      }),
    ),
    0,
  );
  assert.deepEqual(freshMap(context.stateFile).resolveDeploymentDescriptor(PREDICTED), {
    predicted: PREDICTED,
    status: 'complete',
    descriptors: [{ role: 'admin', start: 2, length: 32, expectedActual: ADMIN_ACTUAL }],
  });
});

// (d) With neither snapshot offsets nor an on-disk artifact, a proxy cannot be completed and repair
// records it pending (safe: eth_getCode fails such a proxy closed) rather than binding a bad descriptor.
test('repair leaves a proxy pending when neither snapshot offsets nor disk are available', async t => {
  const context = fixture(t);
  seedProxy(freshMap(context.stateFile), { withReferences: false });

  const out = output();
  assert.equal(
    await run(['repair'], repairOptions(context, { stdout: out.stream, code: { [ACTUAL]: proxyRuntimeCode(ADMIN_ACTUAL) } })),
    0,
  );
  assert.equal(freshMap(context.stateFile).resolveDeploymentDescriptor(PREDICTED)?.status, 'pending');
  assert.deepEqual(JSON.parse(out.read()), { status: 'repaired', completed: 0, pending: 1 });
});

// The on-disk fallback binds a deployment to whatever artifact currently sits at its fully-qualified
// name; if that artifact was recompiled since the deployment (different provenance), its offsets do not
// describe the deployed runtime code and binding them would durably commit garbage descriptor words.
// The fallback must compare the verified artifact's provenance against the provenance recorded for the
// deployment and refuse a mismatch, leaving the record pending.
test('repair does not bind on-disk offsets whose provenance differs from the deployment record', async t => {
  const context = fixture(t);
  seedProxy(freshMap(context.stateFile), { withReferences: false });

  // Same FQN on disk, but recompiled: provenance differs from the deployment's recorded PROVENANCE.
  const verifyArtifactProvenance = () => ({
    artifact: {
      abi: [],
      bytecode: { object: '0x6000' },
      deployedBytecode: { object: '0x6001', immutableReferences: { '1': [{ start: 2, length: 32 }] } },
    },
    ...IDENTITY,
    artifactPath: '/out/T.sol/T.json',
    provenanceHash: `0x${'88'.repeat(32)}`,
  });
  const out = output();
  assert.equal(
    await run(
      ['repair'],
      repairOptions(context, {
        stdout: out.stream,
        code: { [ACTUAL]: proxyRuntimeCode(ADMIN_ACTUAL) },
        findArtifactPaths: () => ['/out/T.sol/T.json'],
        verifyArtifactProvenance,
      }),
    ),
    0,
  );
  assert.equal(freshMap(context.stateFile).resolveDeploymentDescriptor(PREDICTED)?.status, 'pending');
  assert.deepEqual(freshMap(context.stateFile).resolveDeploymentDescriptor(PREDICTED)?.descriptors, []);
  assert.deepEqual(JSON.parse(out.read()), { status: 'repaired', completed: 0, pending: 1 });
});

// A proxy artifact that declares no immutables (admin/beacon only in ERC-1967 storage slots, as in the
// OpenZeppelin v4 proxies) has nothing to project: repair verifies the on-chain code equals the
// artifact's runtime template (the provenance hash does not bind the immutable-reference map, so an
// empty range list alone is not proof) and completes the record with an empty descriptor list.
test('repair completes a zero-immutable proxy empty after verifying its on-chain code', async t => {
  const context = fixture(t);
  const code = '0x60016002';
  seedProxy(freshMap(context.stateFile), { references: [], runtimeBytecodeHash: keccak256(code) });

  const out = output();
  assert.equal(await run(['repair'], repairOptions(context, { stdout: out.stream, code: { [ACTUAL]: code } })), 0);
  assert.deepEqual(freshMap(context.stateFile).resolveDeploymentDescriptor(PREDICTED), {
    predicted: PREDICTED,
    status: 'complete',
    descriptors: [],
  });
  assert.deepEqual(JSON.parse(out.read()), { status: 'repaired', completed: 1, pending: 0 });
});

// The same zero-immutable proxy whose on-chain code does NOT equal the runtime template (a live
// address where the template has zeros — the shape of a proxy whose immutable references were
// stripped) must stay pending: completing empty would let eth_getCode consider raw serving.
test('repair leaves a zero-immutable proxy pending when its on-chain code does not match the template', async t => {
  const context = fixture(t);
  seedProxy(freshMap(context.stateFile), { references: [], runtimeBytecodeHash: keccak256('0x60016002') });

  const out = output();
  assert.equal(
    await run(['repair'], repairOptions(context, { stdout: out.stream, code: { [ACTUAL]: proxyRuntimeCode(ADMIN_ACTUAL) } })),
    0,
  );
  assert.equal(freshMap(context.stateFile).resolveDeploymentDescriptor(PREDICTED)?.status, 'pending');
  assert.deepEqual(JSON.parse(out.read()), { status: 'repaired', completed: 0, pending: 1 });
});

// Disk-resolved offsets must not stay disk-dependent: once the provenance-matched on-disk artifact
// supplied the ranges, repair persists them into the deployment's snapshot so a later eth_getCode (or
// repair) still resolves them after the artifact is cleaned or rebuilt away.
test('repair persists disk-resolved offsets into the snapshot', async t => {
  const context = fixture(t);
  seedProxy(freshMap(context.stateFile), { withReferences: false });

  const verifyArtifactProvenance = () => ({
    artifact: {
      abi: [],
      bytecode: { object: '0x6000' },
      deployedBytecode: { object: '0x6001', immutableReferences: { '1': [{ start: 2, length: 32 }] } },
    },
    ...IDENTITY,
    artifactPath: '/out/T.sol/T.json',
    provenanceHash: PROVENANCE,
  });
  assert.equal(
    await run(
      ['repair'],
      repairOptions(context, {
        code: { [ACTUAL]: proxyRuntimeCode(ADMIN_ACTUAL) },
        findArtifactPaths: () => ['/out/T.sol/T.json'],
        verifyArtifactProvenance,
      }),
    ),
    0,
  );
  assert.deepEqual(freshMap(context.stateFile).resolveArtifactSnapshot(PROVENANCE)?.immutableReferences, [
    { start: 2, length: 32 },
  ]);
});

// UNRESOLVABLE offsets (legacy snapshot without the field, nothing usable on disk) are not the same as
// an artifact that declares NO immutables: completing empty would durably assert "nothing to project"
// for a deployment whose immutables are simply unknown. The record stays pending for a later repair
// with better sources — for a plain contract exactly as for a proxy.
test('repair leaves a contract pending when its immutable offsets are unresolvable', async t => {
  const context = fixture(t);
  seedProxy(freshMap(context.stateFile), { kind: 'contract', withReferences: false });

  const out = output();
  assert.equal(await run(['repair'], repairOptions(context, { stdout: out.stream })), 0);
  assert.equal(freshMap(context.stateFile).resolveDeploymentDescriptor(PREDICTED)?.status, 'pending');
  assert.deepEqual(JSON.parse(out.read()), { status: 'repaired', completed: 0, pending: 1 });
});

// An internally-created ProxyAdmin's metadata points at the PARENT transparent-proxy deployment (its
// sourceTransaction) and carries no provenance of its own. Resolving the parent's snapshot would apply
// the PROXY's immutable offsets to ProxyAdmin runtime code — offsets that may not even be in range.
// The derived child must resolve its OWN artifact's (empty) immutable references instead and complete
// empty without an upstream read.
test('repair resolves a derived ProxyAdmin against its own artifact, not the parent proxy offsets', async t => {
  const context = fixture(t);
  const PARENT_IDENTITY = {
    sourceName: 'openzeppelin-tron-solidity/contracts/proxy/transparent/TransparentUpgradeableProxy.sol',
    contractName: 'TransparentUpgradeableProxy',
    fullyQualifiedName:
      'openzeppelin-tron-solidity/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy',
  };
  const ADMIN_IDENTITY = {
    sourceName: 'openzeppelin-tron-solidity/contracts/proxy/transparent/ProxyAdmin.sol',
    contractName: 'ProxyAdmin',
    fullyQualifiedName: 'openzeppelin-tron-solidity/contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin',
  };
  const ADMIN_PREDICTED = `0x${'b1'.repeat(20)}`;
  const store = new JsonStore(context.stateFile, { createIfMissing: false });
  const journal = new TransactionJournal(store, CHAIN, { ownerId: 'seed-owner', allowRecovery: false });
  const raw = `0x02${'42'.repeat(80)}`;
  const sourceHash = keccak256(raw);
  journal.receive(raw);
  journal.recordNativeBuilt(
    sourceHash,
    { signedNativeTransaction: NATIVE_BYTES, nativeTransactionId: NATIVE_TXID },
    {
      operationContext: {
        kind: 'deployment',
        from: SENDER,
        to: null,
        nonce: '12',
        predictedContractAddress: PREDICTED,
        actualTarget: ACTUAL,
        contractKind: 'transparent-proxy',
        artifactIdentity: PARENT_IDENTITY,
        provenanceHash: PROVENANCE,
      },
      childCreatePlan: {
        version: 1,
        mode: 'exact-signed',
        sender: SENDER,
        simulationRootAddress: ACTUAL,
        attempts: [],
        counterBases: {},
        counterFinals: {},
      },
    },
  );
  const map = new AddressMap(store, CHAIN);
  // The parent proxy's snapshot: address-width offsets that are OUT OF RANGE for ProxyAdmin's code.
  map.setArtifactSnapshot({
    provenanceHash: PROVENANCE,
    artifactIdentity: PARENT_IDENTITY,
    contractKind: 'transparent-proxy',
    abi: [],
    creationBytecodeHash: `0x${'88'.repeat(32)}`,
    runtimeBytecodeHash: `0x${'99'.repeat(32)}`,
    immutableReferences: [{ start: 2, length: 32 }],
  });
  map.set({ predicted: ADMIN_PREDICTED, actual: ADMIN_ACTUAL, creator: SENDER, sender: SENDER, sourceTransaction: sourceHash });
  map.setContractMetadata({
    predicted: ADMIN_PREDICTED,
    contractKind: 'proxy-admin',
    artifactIdentity: ADMIN_IDENTITY,
    sourceTransaction: sourceHash,
  });

  const out = output();
  assert.equal(
    await run(
      ['repair'],
      repairOptions(context, {
        stdout: out.stream,
        // ProxyAdmin runtime code is far shorter than the parent's offset window; a parent-offset read
        // could never bind it.
        code: { [ADMIN_ACTUAL]: '0x6001' },
        findArtifactPaths: (_out: string, name: string) => (name === ADMIN_IDENTITY.fullyQualifiedName ? ['/out/ProxyAdmin.json'] : []),
        verifyArtifactProvenance: () => ({
          artifact: { abi: [], bytecode: { object: '0x6000' }, deployedBytecode: { object: '0x6001' } },
          ...ADMIN_IDENTITY,
          artifactPath: '/out/ProxyAdmin.json',
          provenanceHash: `0x${'55'.repeat(32)}`,
        }),
      }),
    ),
    0,
  );
  assert.deepEqual(freshMap(context.stateFile).resolveDeploymentDescriptor(ADMIN_PREDICTED), {
    predicted: ADMIN_PREDICTED,
    status: 'complete',
    descriptors: [],
  });
  assert.deepEqual(JSON.parse(out.read()), { status: 'repaired', completed: 1, pending: 0 });
});

// Durability gate: repair must not mark a record complete from disk-resolved offsets it cannot persist
// durably. With no artifact snapshot to enrich, a later read (after the on-disk artifact is gone)
// could not resolve the offsets and would fail the complete proxy closed forever — so repair leaves it
// pending instead, retryable once a snapshot exists.
test('repair leaves a proxy pending when disk offsets cannot be persisted to a snapshot', async t => {
  const context = fixture(t);
  const map = freshMap(context.stateFile);
  // Mapping + metadata but deliberately NO artifact snapshot record.
  map.set({ predicted: PREDICTED, actual: ACTUAL, creator: SENDER, sender: SENDER, sourceTransaction: SOURCE_TX });
  map.setContractMetadata({
    predicted: PREDICTED,
    contractKind: 'transparent-proxy',
    artifactIdentity: IDENTITY,
    sourceTransaction: SOURCE_TX,
    provenanceHash: PROVENANCE,
  });

  const verifyArtifactProvenance = () => ({
    artifact: {
      abi: [],
      bytecode: { object: '0x6000' },
      deployedBytecode: { object: '0x6001', immutableReferences: { '1': [{ start: 2, length: 32 }] } },
    },
    ...IDENTITY,
    artifactPath: '/out/T.sol/T.json',
    provenanceHash: PROVENANCE,
  });
  const out = output();
  assert.equal(
    await run(
      ['repair'],
      repairOptions(context, {
        stdout: out.stream,
        code: { [ACTUAL]: proxyRuntimeCode(ADMIN_ACTUAL) },
        findArtifactPaths: () => ['/out/T.sol/T.json'],
        verifyArtifactProvenance,
      }),
    ),
    0,
  );
  assert.equal(freshMap(context.stateFile).resolveDeploymentDescriptor(PREDICTED)?.status, 'pending');
  assert.deepEqual(JSON.parse(out.read()), { status: 'repaired', completed: 0, pending: 1 });
  // Scoped to journal provenance: an adopt-shaped record (its own provenanceHash) writes mapping,
  // metadata, and snapshot in ONE transaction, so a missing snapshot here is not the crash window.
  assert.equal(freshMap(context.stateFile).resolveArtifactSnapshot(PROVENANCE), undefined);
});

// The confirm flow commits mapping + metadata durably and the artifact snapshot in a later
// transaction; a crash between them leaves a confirmed deployment no read path can recover after a
// recompile. Repair rebuilds the snapshot from the provenance-matched on-disk artifact, hashing the
// linked creation prefix recovered from the journaled initcode so the envelope matches the deploy path.
test('repair rebuilds a crash-lost artifact snapshot for a confirmed journal deployment', async t => {
  const context = fixture(t);
  seedNormalProxy(context.stateFile, { withSnapshot: false, confirm: true });
  assert.equal(freshMap(context.stateFile).resolveArtifactSnapshot(PROVENANCE), undefined);

  const linkedCreation = `0x6001${'33'.repeat(20)}6002`;
  const linkedRuntime = `0x6001__$${'a'.repeat(34)}$__6002`;
  const verifyArtifactProvenance = () => ({
    artifact: {
      abi: [],
      bytecode: { object: `0x6001__$${'b'.repeat(34)}$__6002` },
      deployedBytecode: { object: linkedRuntime, immutableReferences: { '1': [{ start: 2, length: 32 }] } },
    },
    ...IDENTITY,
    artifactPath: '/out/T.sol/T.json',
    provenanceHash: PROVENANCE,
  });

  const decoderOptionsSeen: JsonAny[] = [];
  const out = output();
  assert.equal(
    await run(
      ['repair'],
      repairOptions(context, {
        stdout: out.stream,
        code: { [ACTUAL]: proxyRuntimeCode(ADMIN_ACTUAL) },
        findArtifactPaths: () => ['/out/T.sol/T.json'],
        verifyArtifactProvenance,
        decodeLegacyTransaction: (_raw: JsonAny, options: JsonAny) => {
          decoderOptionsSeen.push(options);
          return { kind: 'deployment', data: linkedCreation };
        },
        matchDeploymentArtifact: () => ({
          ...verifyArtifactProvenance(),
          creationBytecode: linkedCreation,
          constructorData: '0x',
        }),
      }),
    ),
    0,
  );

  assert.deepEqual(freshMap(context.stateFile).resolveArtifactSnapshot(PROVENANCE), {
    provenanceHash: PROVENANCE,
    artifactIdentity: IDENTITY,
    contractKind: 'transparent-proxy',
    abi: [],
    creationBytecodeHash: keccak256(linkedCreation),
    runtimeBytecodeHash: keccak256(toUtf8Bytes(linkedRuntime)),
    immutableReferences: [{ start: 2, length: 32 }],
  });
  assert.deepEqual(freshMap(context.stateFile).resolveDeploymentDescriptor(PREDICTED), {
    predicted: PREDICTED,
    status: 'complete',
    descriptors: [{ role: 'admin', start: 2, length: 32, expectedActual: ADMIN_ACTUAL }],
  });
  assert.deepEqual(JSON.parse(out.read()), { status: 'repaired', completed: 1, pending: 0 });
  // The production decoder throws before parsing when these options are absent; a stub ignoring them
  // would mask repair silently declining every rebuild in production.
  assert.equal(decoderOptionsSeen.length, 1);
  assert.equal(decoderOptionsSeen[0]?.expectedSender, SENDER);
  assert.equal(decoderOptionsSeen[0]?.expectedChainId, CHAIN_ID);
});

// Reconstruction succeeds only while the on-disk artifact still provenance-matches the journaled
// deployment; a drifted (recompiled) artifact is declined and the record stays pending, retryable.
test('repair does not rebuild a snapshot from a drifted on-disk artifact', async t => {
  const context = fixture(t);
  seedNormalProxy(context.stateFile, { withSnapshot: false, confirm: true });

  const out = output();
  assert.equal(
    await run(
      ['repair'],
      repairOptions(context, {
        stdout: out.stream,
        code: { [ACTUAL]: proxyRuntimeCode(ADMIN_ACTUAL) },
        findArtifactPaths: () => ['/out/T.sol/T.json'],
        verifyArtifactProvenance: () => ({
          artifact: {
            abi: [],
            bytecode: { object: '0x6000' },
            deployedBytecode: { object: '0x6001', immutableReferences: { '1': [{ start: 2, length: 32 }] } },
          },
          ...IDENTITY,
          artifactPath: '/out/T.sol/T.json',
          provenanceHash: `0x${'88'.repeat(32)}`,
        }),
        decodeLegacyTransaction: () => ({ kind: 'deployment', data: '0x6000' }),
        matchDeploymentArtifact: () => {
          throw new Error('no artifact matches the initcode');
        },
      }),
    ),
    0,
  );
  assert.equal(freshMap(context.stateFile).resolveArtifactSnapshot(PROVENANCE), undefined);
  assert.equal(freshMap(context.stateFile).resolveDeploymentDescriptor(PREDICTED)?.status, 'pending');
  assert.deepEqual(JSON.parse(out.read()), { status: 'repaired', completed: 0, pending: 1 });
});

// The crash window closes at confirmation: an unconfirmed journal record is startup recovery's job
// (it may still broadcast), not repair's, so no snapshot is rebuilt for it.
test('repair does not rebuild a snapshot for an unconfirmed journal deployment', async t => {
  const context = fixture(t);
  seedNormalProxy(context.stateFile, { withSnapshot: false, confirm: false });

  const out = output();
  assert.equal(
    await run(
      ['repair'],
      repairOptions(context, {
        stdout: out.stream,
        code: { [ACTUAL]: proxyRuntimeCode(ADMIN_ACTUAL) },
        findArtifactPaths: () => ['/out/T.sol/T.json'],
        verifyArtifactProvenance: () => ({
          artifact: {
            abi: [],
            bytecode: { object: '0x6000' },
            deployedBytecode: { object: '0x6001', immutableReferences: { '1': [{ start: 2, length: 32 }] } },
          },
          ...IDENTITY,
          artifactPath: '/out/T.sol/T.json',
          provenanceHash: PROVENANCE,
        }),
        decodeLegacyTransaction: () => ({ kind: 'deployment', data: '0x6000' }),
        matchDeploymentArtifact: () => ({
          artifact: { abi: [], bytecode: { object: '0x6000' }, deployedBytecode: { object: '0x6001' } },
          ...IDENTITY,
          provenanceHash: PROVENANCE,
          creationBytecode: '0x6000',
          constructorData: '0x',
        }),
      }),
    ),
    0,
  );
  assert.equal(freshMap(context.stateFile).resolveArtifactSnapshot(PROVENANCE), undefined);
  assert.equal(freshMap(context.stateFile).resolveDeploymentDescriptor(PREDICTED)?.status, 'pending');
  assert.deepEqual(JSON.parse(out.read()), { status: 'repaired', completed: 0, pending: 1 });
});

// A NORMAL (gateway-deployed) proxy whose metadata omits provenanceHash resolves its snapshot offsets
// through the journaled source transaction. With the on-disk artifact gone, repair must still complete
// the descriptor from those durable offsets — the disk-independent repair contract.
test('repair completes a normal proxy from snapshot offsets resolved via the journaled provenance', async t => {
  const context = fixture(t);
  seedNormalProxy(context.stateFile);
  assert.equal(freshMap(context.stateFile).resolveDeploymentDescriptor(PREDICTED), undefined);

  const out = output();
  assert.equal(
    await run(['repair'], repairOptions(context, { stdout: out.stream, code: { [ACTUAL]: proxyRuntimeCode(ADMIN_ACTUAL) } })),
    0,
  );
  assert.deepEqual(freshMap(context.stateFile).resolveDeploymentDescriptor(PREDICTED), {
    predicted: PREDICTED,
    status: 'complete',
    descriptors: [{ role: 'admin', start: 2, length: 32, expectedActual: ADMIN_ACTUAL }],
  });
  assert.deepEqual(JSON.parse(out.read()), { status: 'repaired', completed: 1, pending: 0 });
});
