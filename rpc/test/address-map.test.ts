import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  ADDRESS_MAP_VERSION,
  ARTIFACT_SNAPSHOT_VERSION,
  DEPLOYMENT_DESCRIPTOR_VERSION,
  AddressMap,
} from '../../dist/rpc/address-map.js';
import { JsonStore } from '../../dist/rpc/store.js';

// Test-local fixtures (mapping/contract-metadata payloads, including deliberately invalid
// overrides) are deliberately loosely shaped, the same way the real caller-supplied input
// rpc-src/address-map.ts validates at runtime is. `any` is used deliberately throughout this file
// for that content, matching rpc-src/address-map.ts's own handling.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonAny = any;

const PREDICTED = `0x${'11'.repeat(20)}`;
const ACTUAL = `0x${'22'.repeat(20)}`;
const OTHER_PREDICTED = `0x${'33'.repeat(20)}`;
const OTHER_ACTUAL = `0x${'44'.repeat(20)}`;
const CREATOR = `0x${'55'.repeat(20)}`;
const SENDER = `0x${'66'.repeat(20)}`;
const SOURCE_TRANSACTION = `0x${'ab'.repeat(32)}`;

function fixture(t: TestContext, chain: JsonAny = 'tre:728126428') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-tron-address-map-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, 'state.json');
  return { addressMap: new AddressMap(new JsonStore(statePath), chain), statePath };
}

function mapping(overrides: Record<string, JsonAny> = {}) {
  return {
    predicted: PREDICTED,
    actual: ACTUAL,
    creator: CREATOR,
    sender: SENDER,
    sourceTransaction: SOURCE_TRANSACTION,
    ...overrides,
  };
}

const PROVENANCE_HASH = `0x${'77'.repeat(32)}`;
const CREATION_HASH = `0x${'88'.repeat(32)}`;
const RUNTIME_HASH = `0x${'99'.repeat(32)}`;
const SNAPSHOT_IDENTITY = {
  sourceName: 'contracts/Box.sol',
  contractName: 'Box',
  fullyQualifiedName: 'contracts/Box.sol:Box',
};

function snapshot(overrides: Record<string, JsonAny> = {}) {
  return {
    provenanceHash: PROVENANCE_HASH,
    artifactIdentity: SNAPSHOT_IDENTITY,
    contractKind: 'contract',
    abi: [{ type: 'function', name: 'ping', inputs: [], outputs: [], stateMutability: 'nonpayable' }],
    creationBytecodeHash: CREATION_HASH,
    runtimeBytecodeHash: RUNTIME_HASH,
    ...overrides,
  };
}

test('stores global predicted-to-actual and reverse mappings with provenance', t => {
  const { addressMap } = fixture(t);
  const stored = addressMap.set(mapping());

  assert.deepEqual(stored, mapping());
  assert.deepEqual(addressMap.resolvePredicted(PREDICTED.toUpperCase().replace('0X', '0x')), mapping());
  assert.deepEqual(addressMap.resolveActual(`41${'22'.repeat(20)}`), mapping());
  assert.equal(addressMap.toActual(PREDICTED), ACTUAL);
  assert.equal(addressMap.toPredicted(ACTUAL), PREDICTED);
});

test('persists mappings across restart', t => {
  const { addressMap, statePath } = fixture(t);
  addressMap.set(mapping());

  const restarted = new AddressMap(new JsonStore(statePath), 'tre:728126428');
  assert.deepEqual(restarted.resolvePredicted(PREDICTED), mapping());
  assert.deepEqual(restarted.resolveActual(ACTUAL), mapping());
});

test('separates identical predicted addresses by chain, not creator', t => {
  const { statePath } = fixture(t);
  const store = new JsonStore(statePath);
  const firstChain = new AddressMap(store, 'chain-a');
  const secondChain = new AddressMap(store, 'chain-b');

  firstChain.set(mapping());
  secondChain.set(mapping({ actual: OTHER_ACTUAL, creator: OTHER_PREDICTED }));

  assert.equal(firstChain.toActual(PREDICTED), ACTUAL);
  assert.equal(secondChain.toActual(PREDICTED), OTHER_ACTUAL);
  assert.throws(() => firstChain.set(mapping({ actual: OTHER_ACTUAL, creator: OTHER_PREDICTED })), /conflict/i);
});

test('enforces one-to-one mappings in both directions', t => {
  const { addressMap } = fixture(t);
  addressMap.set(mapping());

  assert.throws(() => addressMap.set(mapping({ actual: OTHER_ACTUAL })), /predicted.*conflict/i);
  assert.throws(() => addressMap.set(mapping({ predicted: OTHER_PREDICTED })), /actual.*conflict/i);
  assert.equal(addressMap.toActual(OTHER_PREDICTED), undefined);
  assert.equal(addressMap.toPredicted(OTHER_ACTUAL), undefined);
});

test('accepts an identical retry but rejects changed provenance', t => {
  const { addressMap } = fixture(t);
  addressMap.set(mapping());

  assert.deepEqual(addressMap.set(mapping()), mapping());
  assert.throws(() => addressMap.set(mapping({ sourceTransaction: `0x${'cd'.repeat(32)}` })), /provenance.*conflict/i);
});

test('validates mapping addresses and provenance before writing', t => {
  const { addressMap } = fixture(t);

  assert.throws(() => addressMap.set(mapping({ predicted: '0x1234' })), /address/i);
  assert.throws(() => addressMap.set(mapping({ sourceTransaction: '0x1234' })), /source transaction/i);
  assert.throws(() => addressMap.set(mapping({ sender: undefined })), /sender/i);
  assert.deepEqual(addressMap.list(), []);
});

test('refuses internally inconsistent persisted indexes', t => {
  const { addressMap, statePath } = fixture(t);
  addressMap.set(mapping());
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.chains['tre:728126428'].addressMappings.byActual[ACTUAL] = OTHER_PREDICTED;
  fs.writeFileSync(statePath, JSON.stringify(state));

  assert.throws(() => addressMap.resolvePredicted(PREDICTED), /corrupt.*address mapping/i);
});

test('refuses noncanonical persisted provenance', t => {
  const { addressMap, statePath } = fixture(t);
  addressMap.set(mapping());
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.chains['tre:728126428'].addressMappings.byPredicted[PREDICTED].sourceTransaction =
    SOURCE_TRANSACTION.toUpperCase().replace('0X', '0x');
  fs.writeFileSync(statePath, JSON.stringify(state));

  assert.throws(() => addressMap.resolvePredicted(PREDICTED), /corrupt.*address mapping/i);
});

test('refuses orphaned persisted contract metadata even when the queried address is unmapped', t => {
  const { addressMap, statePath } = fixture(t);
  addressMap.set(mapping());
  addressMap.setContractMetadata({
    predicted: PREDICTED,
    contractKind: 'proxy-admin',
    artifactIdentity: {
      sourceName: 'lib/openzeppelin-tron-solidity/contracts/proxy/transparent/ProxyAdmin.sol',
      contractName: 'ProxyAdmin',
      fullyQualifiedName: 'lib/openzeppelin-tron-solidity/contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin',
    },
    sourceTransaction: SOURCE_TRANSACTION,
  });
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  delete state.chains['tre:728126428'].addressMappings.byPredicted[PREDICTED];
  delete state.chains['tre:728126428'].addressMappings.byActual[ACTUAL];
  fs.writeFileSync(statePath, JSON.stringify(state));

  const restarted = new AddressMap(new JsonStore(statePath), 'tre:728126428');
  assert.throws(() => restarted.resolveContractMetadata(OTHER_PREDICTED), /corrupt.*contract metadata/i);
});

test('stores and resolves an immutable artifact snapshot keyed by provenance hash', t => {
  const { addressMap, statePath } = fixture(t);
  const stored = addressMap.setArtifactSnapshot(snapshot());

  assert.deepEqual(stored, snapshot());
  assert.deepEqual(addressMap.resolveArtifactSnapshot(PROVENANCE_HASH), snapshot());
  assert.deepEqual(
    addressMap.resolveArtifactSnapshot(PROVENANCE_HASH.toUpperCase().replace('0X', '0x')),
    snapshot(),
  );
  assert.equal(addressMap.resolveArtifactSnapshot(`0x${'00'.repeat(32)}`), undefined);

  const restarted = new AddressMap(new JsonStore(statePath), 'tre:728126428');
  assert.deepEqual(restarted.resolveArtifactSnapshot(PROVENANCE_HASH), snapshot());
});

test('accepts an identical snapshot retry but refuses overwriting a snapshot in place', t => {
  const { addressMap } = fixture(t);
  addressMap.setArtifactSnapshot(snapshot());

  assert.deepEqual(addressMap.setArtifactSnapshot(snapshot()), snapshot());
  assert.throws(
    () => addressMap.setArtifactSnapshot(snapshot({ abi: [{ type: 'function', name: 'pong', inputs: [] }] })),
    /snapshot.*conflict/i,
  );
  assert.throws(() => addressMap.setArtifactSnapshot(snapshot({ contractKind: 'uups-proxy' })), /snapshot.*conflict/i);
});

test('reconciles a legacy snapshot without offsets instead of conflicting post-confirmation', t => {
  const { addressMap } = fixture(t);
  const references = [{ start: 2, length: 32 }];
  // A record written before offset capture existed: no immutableReferences field.
  addressMap.setArtifactSnapshot(snapshot());

  // A new write of the same artifact adds only the artifact-scoped offsets: upgraded in place, no
  // 'Artifact snapshot conflict' for a confirmed deployment.
  const upgraded = addressMap.setArtifactSnapshot(snapshot({ immutableReferences: references }));
  assert.deepEqual(upgraded.immutableReferences, references);
  assert.deepEqual(addressMap.resolveArtifactSnapshot(PROVENANCE_HASH)?.immutableReferences, references);

  // The reverse direction keeps the richer record: a reference-less retry never strips the offsets.
  const kept = addressMap.setArtifactSnapshot(snapshot());
  assert.deepEqual(kept.immutableReferences, references);

  // Any other difference is still a conflict, offsets present or not.
  assert.throws(
    () => addressMap.setArtifactSnapshot(snapshot({ immutableReferences: references, contractKind: 'uups-proxy' })),
    /snapshot.*conflict/i,
  );
  assert.throws(
    () => addressMap.setArtifactSnapshot(snapshot({ immutableReferences: [{ start: 4, length: 32 }] })),
    /snapshot.*conflict/i,
  );
});

test('validates snapshot identity, kind, abi, and hashes before writing', t => {
  const { addressMap } = fixture(t);

  assert.throws(() => addressMap.setArtifactSnapshot(snapshot({ provenanceHash: '0x1234' })), /provenance/i);
  assert.throws(() => addressMap.setArtifactSnapshot(snapshot({ creationBytecodeHash: '0xdead' })), /snapshot/i);
  assert.throws(() => addressMap.setArtifactSnapshot(snapshot({ runtimeBytecodeHash: 'nope' })), /snapshot/i);
  assert.throws(() => addressMap.setArtifactSnapshot(snapshot({ contractKind: 'Not-A-Kind' })), /snapshot/i);
  assert.throws(() => addressMap.setArtifactSnapshot(snapshot({ abi: 'not-an-array' })), /snapshot/i);
  assert.throws(
    () =>
      addressMap.setArtifactSnapshot(
        snapshot({ artifactIdentity: { sourceName: 'contracts/Box.sol', contractName: 'Box', fullyQualifiedName: 'x' } }),
      ),
    /identity/i,
  );
});

test('fails closed on a corrupt persisted artifact snapshot record', t => {
  const { addressMap, statePath } = fixture(t);
  addressMap.setArtifactSnapshot(snapshot());
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.chains['tre:728126428'].artifactSnapshots.byProvenanceHash[PROVENANCE_HASH].creationBytecodeHash = '0xdead';
  fs.writeFileSync(statePath, JSON.stringify(state));

  assert.throws(() => addressMap.resolveArtifactSnapshot(PROVENANCE_HASH), /corrupt.*artifact snapshot/i);
});

test('fails closed when a persisted artifact snapshot is keyed by the wrong provenance hash', t => {
  const { addressMap, statePath } = fixture(t);
  addressMap.setArtifactSnapshot(snapshot());
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const snapshots = state.chains['tre:728126428'].artifactSnapshots.byProvenanceHash;
  snapshots[`0x${'00'.repeat(32)}`] = snapshots[PROVENANCE_HASH];
  delete snapshots[PROVENANCE_HASH];
  fs.writeFileSync(statePath, JSON.stringify(state));

  assert.throws(() => addressMap.resolveArtifactSnapshot(`0x${'00'.repeat(32)}`), /corrupt.*artifact snapshot/i);
});

const ADMIN_ACTUAL = `0x${'a4'.repeat(20)}`;
const SELF_ACTUAL = `0x${'b7'.repeat(20)}`;
// Artifact-scoped constructor-set immutable byte ranges (offsets, not values), identical for every
// deployment of an artifact and therefore stored on the artifact snapshot.
const IMMUTABLE_REFERENCES = [
  { start: 2, length: 32 },
  { start: 40, length: 32 },
];
// The per-deployment role bindings now live in the separate deployment-descriptor index, keyed by
// predicted address, not on the artifact snapshot.
const DEPLOYMENT_DESCRIPTORS = [{ role: 'admin', start: 2, length: 32, expectedActual: ADMIN_ACTUAL }];

test('stores and round-trips an artifact snapshot carrying immutable references across restart', t => {
  const { addressMap, statePath } = fixture(t);
  const stored = addressMap.setArtifactSnapshot(snapshot({ immutableReferences: IMMUTABLE_REFERENCES }));
  assert.deepEqual(stored, snapshot({ immutableReferences: IMMUTABLE_REFERENCES }));

  const restarted = new AddressMap(new JsonStore(statePath), 'tre:728126428');
  assert.deepEqual(
    restarted.resolveArtifactSnapshot(PROVENANCE_HASH),
    snapshot({ immutableReferences: IMMUTABLE_REFERENCES }),
  );
});

test('keeps a legacy six-key snapshot (no immutable references) valid', t => {
  const { addressMap, statePath } = fixture(t);
  const stored = addressMap.setArtifactSnapshot(snapshot());
  // The optional field is absent, not present-and-empty, so a pre-existing on-disk snapshot round-trips.
  assert.equal('immutableReferences' in stored, false);
  const restarted = new AddressMap(new JsonStore(statePath), 'tre:728126428');
  assert.deepEqual(restarted.resolveArtifactSnapshot(PROVENANCE_HASH), snapshot());
});

test('round-trips a snapshot whose immutable references list is empty', t => {
  const { addressMap, statePath } = fixture(t);
  const stored = addressMap.setArtifactSnapshot(snapshot({ immutableReferences: [] }));
  assert.deepEqual(stored, snapshot({ immutableReferences: [] }));
  const restarted = new AddressMap(new JsonStore(statePath), 'tre:728126428');
  assert.deepEqual(restarted.resolveArtifactSnapshot(PROVENANCE_HASH), snapshot({ immutableReferences: [] }));
});

test('rejects malformed immutable references before writing', t => {
  const { addressMap } = fixture(t);
  assert.throws(
    () => addressMap.setArtifactSnapshot(snapshot({ immutableReferences: [{ start: -1, length: 32 }] })),
    /immutable references/i,
  );
  assert.throws(
    () => addressMap.setArtifactSnapshot(snapshot({ immutableReferences: [{ start: 2, length: 0 }] })),
    /immutable references/i,
  );
  assert.throws(
    () => addressMap.setArtifactSnapshot(snapshot({ immutableReferences: [{ start: 2 }] })),
    /immutable references/i,
  );
  assert.throws(
    () => addressMap.setArtifactSnapshot(snapshot({ immutableReferences: { start: 2, length: 32 } })),
    /immutable references/i,
  );
});

test('fails closed on a persisted snapshot whose immutable references were corrupted', t => {
  const { addressMap, statePath } = fixture(t);
  addressMap.setArtifactSnapshot(snapshot({ immutableReferences: IMMUTABLE_REFERENCES }));
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.chains['tre:728126428'].artifactSnapshots.byProvenanceHash[PROVENANCE_HASH].immutableReferences[0].length = -5;
  fs.writeFileSync(statePath, JSON.stringify(state));

  assert.throws(() => addressMap.resolveArtifactSnapshot(PROVENANCE_HASH), /corrupt.*artifact snapshot/i);
});

// The deployment-descriptor index: per-deployment role immutables keyed by predicted address, with a
// controlled pending -> complete transition (the only durable record that is not pure conflict-refuse).
const COMPLETE = { predicted: PREDICTED, status: 'complete', descriptors: DEPLOYMENT_DESCRIPTORS };
const PENDING = { predicted: PREDICTED, status: 'pending', descriptors: [] };

test('stores and resolves a deployment descriptor keyed by predicted address', t => {
  const { addressMap, statePath } = fixture(t);
  addressMap.set(mapping());
  const stored = addressMap.setDeploymentDescriptor(COMPLETE);
  assert.deepEqual(stored, COMPLETE);
  // Resolvable by predicted and, in reverse, by actual.
  assert.deepEqual(addressMap.resolveDeploymentDescriptor(PREDICTED), COMPLETE);
  assert.deepEqual(addressMap.resolveDeploymentDescriptor(ACTUAL), COMPLETE);
  assert.equal(addressMap.resolveDeploymentDescriptor(OTHER_PREDICTED), undefined);

  const restarted = new AddressMap(new JsonStore(statePath), 'tre:728126428');
  assert.deepEqual(restarted.resolveDeploymentDescriptor(PREDICTED), COMPLETE);
});

test('requires an address mapping before storing a deployment descriptor', t => {
  const { addressMap } = fixture(t);
  assert.throws(() => addressMap.setDeploymentDescriptor(COMPLETE), /require.*address mapping/i);
});

test('transitions a pending deployment descriptor to complete but never regresses', t => {
  const { addressMap } = fixture(t);
  addressMap.set(mapping());
  // Insert pending (empty), and a repeat pending is an idempotent no-op.
  assert.deepEqual(addressMap.setDeploymentDescriptor(PENDING), PENDING);
  assert.deepEqual(addressMap.setDeploymentDescriptor(PENDING), PENDING);
  // pending -> complete replaces the record (the verified-enrichment transition).
  assert.deepEqual(addressMap.setDeploymentDescriptor(COMPLETE), COMPLETE);
  assert.deepEqual(addressMap.resolveDeploymentDescriptor(PREDICTED), COMPLETE);
  // complete -> identical complete is idempotent.
  assert.deepEqual(addressMap.setDeploymentDescriptor(COMPLETE), COMPLETE);
  // complete -> pending is refused (never regress).
  assert.throws(() => addressMap.setDeploymentDescriptor(PENDING), /regress to pending/i);
  // complete -> differing complete is refused.
  assert.throws(
    () =>
      addressMap.setDeploymentDescriptor({
        predicted: PREDICTED,
        status: 'complete',
        descriptors: [{ role: 'admin', start: 4, length: 32, expectedActual: ADMIN_ACTUAL }],
      }),
    /descriptor conflict/i,
  );
});

test('rejects malformed deployment descriptor records before writing', t => {
  const { addressMap } = fixture(t);
  addressMap.set(mapping());
  const ok = { role: 'self', start: 2, length: 32, expectedActual: SELF_ACTUAL };
  const rec = (descriptors: JsonAny, status = 'complete') => ({ predicted: PREDICTED, status, descriptors });

  assert.throws(() => addressMap.setDeploymentDescriptor(rec([{ ...ok, role: 'owner' }])), /deployment descriptor record/i);
  assert.throws(() => addressMap.setDeploymentDescriptor(rec([{ ...ok, start: -1 }])), /deployment descriptor record/i);
  assert.throws(() => addressMap.setDeploymentDescriptor(rec([{ ...ok, length: 0 }])), /deployment descriptor record/i);
  assert.throws(
    () => addressMap.setDeploymentDescriptor(rec([{ ...ok, expectedActual: SELF_ACTUAL.toUpperCase().replace('0X', '0x') }])),
    /deployment descriptor record/i,
  );
  assert.throws(() => addressMap.setDeploymentDescriptor(rec({ role: 'self' })), /deployment descriptor record/i);
  assert.throws(() => addressMap.setDeploymentDescriptor(rec([], 'bogus')), /deployment descriptor record/i);
  // A pending record must carry no descriptors.
  assert.throws(
    () => addressMap.setDeploymentDescriptor(rec(DEPLOYMENT_DESCRIPTORS, 'pending')),
    /deployment descriptor record/i,
  );
});

test('fails closed on a corrupt persisted deployment descriptor index', t => {
  const { addressMap, statePath } = fixture(t);
  addressMap.set(mapping());
  addressMap.setDeploymentDescriptor(COMPLETE);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.chains['tre:728126428'].deploymentDescriptors.version = 2;
  fs.writeFileSync(statePath, JSON.stringify(state));

  assert.throws(() => addressMap.resolveDeploymentDescriptor(PREDICTED), /corrupt.*deployment descriptor/i);
});

// (e) State-file compatibility: an on-disk chain in the ORIGINAL shape (a snapshot with no
// immutableReferences and no deploymentDescriptors field at all) loads without error and behaves as
// legacy-backfill — a resolvable snapshot and mapping, but no descriptor record. This change is purely
// additive: none of the index versions are bumped.
test('loads an original-shape on-disk chain without error and treats it as legacy', t => {
  const { statePath } = fixture(t);
  const original = {
    version: 1,
    chains: {
      'tre:728126428': {
        chainIdentity: 'tre:728126428',
        addressMappings: {
          version: ADDRESS_MAP_VERSION,
          byPredicted: { [PREDICTED]: mapping() },
          byActual: { [ACTUAL]: PREDICTED },
        },
        artifactSnapshots: {
          version: ARTIFACT_SNAPSHOT_VERSION,
          byProvenanceHash: { [PROVENANCE_HASH]: snapshot() },
        },
      },
    },
  };
  fs.writeFileSync(statePath, JSON.stringify(original));
  const map = new AddressMap(new JsonStore(statePath, { createIfMissing: false }), 'tre:728126428');
  assert.deepEqual(map.resolveArtifactSnapshot(PROVENANCE_HASH), snapshot());
  assert.equal('immutableReferences' in (map.resolveArtifactSnapshot(PROVENANCE_HASH) as JsonAny), false);
  assert.equal(map.resolveDeploymentDescriptor(PREDICTED), undefined);
});

test('keeps every durable index version additive (no state-version bump)', () => {
  assert.equal(ADDRESS_MAP_VERSION, 1);
  assert.equal(ARTIFACT_SNAPSHOT_VERSION, 1);
  assert.equal(DEPLOYMENT_DESCRIPTOR_VERSION, 1);
});
