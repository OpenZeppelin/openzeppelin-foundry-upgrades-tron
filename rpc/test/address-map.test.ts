import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { AddressMap } from '../../dist/rpc/address-map.js';
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
