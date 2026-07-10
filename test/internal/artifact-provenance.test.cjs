'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { AbiCoder, keccak256, toUtf8Bytes } = require('ethers');
const {
  buildInfoDirectory,
  isAbsolutePath,
  resolvePath,
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
  const [code, provenanceHash, creationBytecodeHash] = AbiCoder.defaultAbiCoder().decode(
    ['uint8', 'bytes32', 'bytes32', 'string', 'string', 'bytes32', 'bytes32'],
    encoded,
  );

  assert.equal(code, 0n);
  assert.notEqual(provenanceHash, `0x${'00'.repeat(32)}`);
  assert.equal(creationBytecodeHash, keccak256(toUtf8Bytes('6001600055')));
});
