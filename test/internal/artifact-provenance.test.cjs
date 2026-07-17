'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AbiCoder, keccak256, toUtf8Bytes } = require('ethers');
const {
  buildInfoDirectory,
  isAbsolutePath,
  loadBuildInfo,
  resolvePath,
  validateLinkReferences,
  verify,
} = require('../../src/internal/artifact-provenance.cjs');

test('classifies portable absolute path forms', () => {
  assert.equal(isAbsolutePath('/tmp/project/out'), true);
  assert.equal(isAbsolutePath('C:/project/out'), true);
  assert.equal(isAbsolutePath('C:\\project\\out'), true);
  assert.equal(isAbsolutePath('\\\\server\\share\\out'), true);
  assert.equal(isAbsolutePath('project/out'), false);
});

test('resolves relative paths without corrupting Windows absolute paths', () => {
  assert.equal(resolvePath('out', '/tmp/project'), '/tmp/project/out');
  assert.equal(resolvePath('C:/project/out', '/tmp/project'), 'C:\\project\\out');
  assert.equal(resolvePath('C:\\project\\out', '/tmp/project'), 'C:\\project\\out');
  assert.equal(resolvePath('\\\\server\\share\\out', '/tmp/project'), '\\\\server\\share\\out');
});

test('selects split build-info beside artifacts contracts for Windows paths', () => {
  assert.equal(buildInfoDirectory('C:/project/artifacts/contracts'), 'C:\\project\\artifacts\\build-info');
  assert.equal(
    buildInfoDirectory('\\\\server\\share\\project\\artifacts\\contracts'),
    '\\\\server\\share\\project\\artifacts\\build-info',
  );
});

test('encodes deterministic normalized creation bytecode hash for Solidity parity', () => {
  const outputDirectory = path.resolve('test/fixtures/provenance/valid/out');
  const encoded = verify([
    outputDirectory,
    path.join(outputDirectory, 'Widget.sol/Widget.json'),
    'contracts/Widget.sol',
    'Widget',
    'contracts/Widget.sol:Widget',
  ]);
  const [code, provenanceHash, creationBytecodeHash, artifactSnapshotHash] = AbiCoder.defaultAbiCoder().decode(
    ['uint8', 'bytes32', 'bytes32', 'bytes32', 'bool', 'string', 'string', 'bytes32', 'bytes32'],
    encoded,
  );

  assert.equal(code, 0n);
  assert.notEqual(provenanceHash, `0x${'00'.repeat(32)}`);
  assert.equal(creationBytecodeHash, keccak256(toUtf8Bytes('6001600055')));
  assert.equal(
    artifactSnapshotHash,
    keccak256(toUtf8Bytes(fs.readFileSync(path.join(outputDirectory, 'Widget.sol/Widget.json'), 'utf8'))),
  );
});

test('accepts only the exact lowercase link-placeholder identity', () => {
  const references = {
    'contracts/External.sol': { External: [{ start: 1, length: 20 }] },
  };
  const identity = keccak256(toUtf8Bytes('contracts/External.sol:External')).slice(2, 36);

  assert.equal(validateLinkReferences(`73__$${identity}$__6000`, references, references), true);
  assert.equal(validateLinkReferences(`73__$${'1'.repeat(34)}$__6000`, references, references), null);
  assert.equal(validateLinkReferences(`73__$${identity.toUpperCase()}$__6000`, references, references), null);
});

test('exposes both Hardhat 3 split build-info files to snapshot consumers', () => {
  const outputDirectory = path.resolve('test/fixtures/provenance/hh3-valid/artifacts/contracts');
  const artifact = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'contracts/Widget.sol/Widget.json'), 'utf8'));
  const loaded = loadBuildInfo(artifact, outputDirectory, 'Widget', 'contracts/Widget.sol:Widget');

  assert.deepEqual(loaded.buildInfoFiles, [
    path.resolve('test/fixtures/provenance/hh3-valid/artifacts/build-info/solc-0_8_22-valid.json'),
    path.resolve('test/fixtures/provenance/hh3-valid/artifacts/build-info/solc-0_8_22-valid.output.json'),
  ]);
});
