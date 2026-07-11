'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AbiCoder, keccak256, toUtf8Bytes } = require('ethers');

const { findArtifactPaths, matchDeploymentArtifact, verifyArtifactProvenance } = require('../artifacts.cjs');
const { verify: solidityProvenanceHelper } = require('../../src/internal/artifact-provenance.cjs');

const root = path.resolve(__dirname, '../..');
const fixtures = path.join(__dirname, 'fixtures/artifacts');
const provenanceFixtures = path.join(root, 'test/fixtures/provenance');
const resultTypes = ['uint8', 'bytes32', 'bytes32', 'bytes32', 'bool', 'string', 'string', 'bytes32', 'bytes32'];

function copyTree(t, source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-tron-artifacts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.cpSync(source, directory, { recursive: true });
  return directory;
}

function basicOut(t) {
  return path.join(copyTree(t, path.join(fixtures, 'basic')), 'out');
}

function provenanceOut(t, name) {
  return path.join(copyTree(t, path.join(provenanceFixtures, name)), 'out');
}

function addAbi(artifactPath) {
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  artifact.abi = [];
  fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
}

test('finds a direct Forge artifact by short name and fully qualified name', t => {
  const out = basicOut(t);
  const expected = path.join(out, 'Widget.sol/Widget.json');

  assert.deepEqual(findArtifactPaths(out, 'Widget'), [expected]);
  assert.deepEqual(findArtifactPaths(out, 'Widget.sol:Widget'), [expected]);
  assert.deepEqual(findArtifactPaths(out, 'contracts/Widget.sol:Widget'), [expected]);
});

test('recursively finds an artifact below a nonstandard output subdirectory', t => {
  const out = basicOut(t);
  const direct = path.join(out, 'Widget.sol/Widget.json');
  const nested = path.join(out, 'generated/deep/Widget.json');
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  fs.renameSync(direct, nested);

  assert.deepEqual(findArtifactPaths(out, 'Widget'), [nested]);
});

test('reports no artifact when raw initcode has no verified prefix', t => {
  const out = basicOut(t);
  assert.throws(() => matchDeploymentArtifact({ outputDirectory: out, initcode: '0x6002600055' }), /no.*artifact/i);
});

test('refuses ambiguous artifacts matching the same raw initcode', t => {
  const out = basicOut(t);
  const duplicate = path.join(out, 'nested/Widget.json');
  fs.mkdirSync(path.dirname(duplicate), { recursive: true });
  fs.copyFileSync(path.join(out, 'Widget.sol/Widget.json'), duplicate);

  assert.throws(() => matchDeploymentArtifact({ outputDirectory: out, initcode: '0x6001600055' }), /ambiguous/i);
});

test('normalizes verified link placeholders while preserving concrete raw initcode', t => {
  const out = provenanceOut(t, 'linked');
  const artifactPath = path.join(out, 'Linked.sol/Linked.json');
  addAbi(artifactPath);
  const linkedAddress = 'ab'.repeat(20);
  const initcode = `0x73${linkedAddress}6000deadbeef`;

  const result = matchDeploymentArtifact({ outputDirectory: out, initcode });

  assert.equal(result.fullyQualifiedName, 'contracts/Linked.sol:Linked');
  assert.equal(result.requiresLinking, true);
  assert.equal(result.creationBytecode, `0x73${linkedAddress}6000`);
  assert.equal(result.constructorData, '0xdeadbeef');
});

test('refuses artifact and build-info creation-bytecode mismatch', t => {
  const out = provenanceOut(t, 'bytecode-mismatch');
  const artifactPath = path.join(out, 'Widget.sol/Widget.json');

  assert.throws(
    () => verifyArtifactProvenance({ outputDirectory: out, artifactPath }),
    error => error.code === 'BYTECODE_MISMATCH',
  );
});

test('checks every metadata source against build-info source content', async t => {
  for (const sourceName of ['contracts/Lib.sol', 'contracts/Widget.sol']) {
    await t.test(sourceName, () => {
      const out = basicOut(t);
      const buildInfoPath = path.join(out, 'build-info/build.json');
      const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
      buildInfo.input.sources[sourceName].content += ' changed';
      fs.writeFileSync(buildInfoPath, JSON.stringify(buildInfo));

      assert.throws(
        () =>
          verifyArtifactProvenance({ outputDirectory: out, artifactPath: path.join(out, 'Widget.sol/Widget.json') }),
        error => error.code === 'SOURCE_HASH_MISMATCH' && error.details.sourceName === sourceName,
      );
    });
  }
});

test('refuses a metadata source missing from build-info', t => {
  const out = basicOut(t);
  const buildInfoPath = path.join(out, 'build-info/build.json');
  const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
  delete buildInfo.input.sources['contracts/Lib.sol'];
  fs.writeFileSync(buildInfoPath, JSON.stringify(buildInfo));

  assert.throws(
    () => verifyArtifactProvenance({ outputDirectory: out, artifactPath: path.join(out, 'Widget.sol/Widget.json') }),
    error => error.code === 'MISSING_SOURCE' && error.details.sourceName === 'contracts/Lib.sol',
  );
});

test('requires exact compiler build identity, not only a semantic version', t => {
  for (const [fixture, code] of [
    ['compiler-build-mismatch', 'COMPILER_BUILD_MISMATCH'],
    ['output-compiler-mismatch', 'COMPILER_BUILD_MISMATCH'],
  ]) {
    const out = provenanceOut(t, fixture);
    assert.throws(
      () => verifyArtifactProvenance({ outputDirectory: out, artifactPath: path.join(out, 'Widget.sol/Widget.json') }),
      error => error.code === code,
    );
  }
});

test('requires one absolute FOUNDRY_OUT and confines artifacts to it', t => {
  const out = basicOut(t);
  const outsideOut = basicOut(t);

  assert.throws(
    () => findArtifactPaths('rpc/test/fixtures/artifacts/basic/out', 'Widget'),
    /FOUNDRY_OUT.*absolute|absolute.*FOUNDRY_OUT/i,
  );
  assert.throws(
    () =>
      verifyArtifactProvenance({
        outputDirectory: out,
        artifactPath: path.join(outsideOut, 'Widget.sol/Widget.json'),
      }),
    error => error.code === 'ARTIFACT_OUTSIDE_OUTPUT',
  );
});

test('computes the exact provenance hash used by the Solidity FFI helper', t => {
  const out = provenanceOut(t, 'valid');
  const artifactPath = path.join(out, 'Widget.sol/Widget.json');
  const result = verifyArtifactProvenance({ outputDirectory: out, artifactPath });
  const encoded = solidityProvenanceHelper([
    out,
    artifactPath,
    'contracts/Widget.sol',
    'Widget',
    'contracts/Widget.sol:Widget',
  ]);
  const [code, provenanceHash] = AbiCoder.defaultAbiCoder().decode(resultTypes, encoded);

  assert.equal(code, 0n);
  assert.equal(result.provenanceHash, provenanceHash);
  const expected = keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ['string', 'string', 'string', 'string', 'string', 'string', 'string', 'string', 'string[]', 'bytes32[]'],
      [
        out,
        path.join(out, 'build-info/build.json'),
        '0.8.22+commit.4fc1097e',
        '0.8.22+commit.4fc1097e',
        '0.8.22',
        '0.8.22',
        'contracts/Widget.sol:Widget',
        '6001600055',
        ['contracts/Widget.sol'],
        [keccak256(toUtf8Bytes('contract Widget {}'))],
      ],
    ),
  );
  assert.equal(result.provenanceHash, expected);
});

test('returns artifact identity, ABI, verified prefix, compiler, and constructor suffix', t => {
  const out = basicOut(t);
  const constructorData = `0x${'00'.repeat(31)}2a`;
  const result = matchDeploymentArtifact({ outputDirectory: out, initcode: `0x6001600055${constructorData.slice(2)}` });

  assert.equal(result.artifactPath, path.join(out, 'Widget.sol/Widget.json'));
  assert.equal(result.sourceName, 'contracts/Widget.sol');
  assert.equal(result.contractName, 'Widget');
  assert.equal(result.fullyQualifiedName, 'contracts/Widget.sol:Widget');
  assert.equal(result.creationBytecode, '0x6001600055');
  assert.equal(result.constructorData, constructorData);
  assert.deepEqual(result.abi, result.artifact.abi);
  assert.deepEqual(result.compiler, {
    artifactVersion: '0.8.22+commit.4fc1097e',
    outputVersion: '0.8.22+commit.4fc1097e',
    solcVersion: '0.8.22',
    solcLongVersion: '0.8.22+commit.4fc1097e',
  });
  assert.match(result.provenanceHash, /^0x[0-9a-f]{64}$/);
});

test('requires raw initcode to contain the complete verified creation-bytecode prefix', t => {
  const out = basicOut(t);
  assert.throws(() => matchDeploymentArtifact({ outputDirectory: out, initcode: '0x60016000' }), /no.*artifact/i);
  assert.throws(() => matchDeploymentArtifact({ outputDirectory: out, initcode: '0x6001600054' }), /no.*artifact/i);
});

test('rebinds the raw initcode prefix to the artifact snapshot selected by provenance', t => {
  const out = basicOut(t);
  const artifactPath = path.join(out, 'Widget.sol/Widget.json');
  const buildInfoPath = path.join(out, 'build-info/build.json');

  assert.throws(
    () =>
      matchDeploymentArtifact({
        outputDirectory: out,
        initcode: '0x6001600055deadbeef',
        hooks: {
          afterCandidateMatch() {
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            artifact.bytecode.object = '0x6002600055';
            fs.writeFileSync(artifactPath, JSON.stringify(artifact));
            const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
            buildInfo.output.contracts['contracts/Widget.sol'].Widget.evm.bytecode.object = '6002600055';
            fs.writeFileSync(buildInfoPath, JSON.stringify(buildInfo));
          },
        },
      }),
    error => error.code === 'ARTIFACT_NOT_FOUND' || error.code === 'PROVENANCE_CHANGED',
  );
});

test('never returns compiler fields from transient unverified build-info', t => {
  const out = basicOut(t);
  const artifactPath = path.join(out, 'Widget.sol/Widget.json');
  const buildInfoPath = path.join(out, 'build-info/build.json');
  const original = fs.readFileSync(buildInfoPath, 'utf8');
  const transient = JSON.parse(original);
  transient.solcVersion = '9.9.9';
  transient.solcLongVersion = '9.9.9+commit.transient';
  transient.output.contracts['contracts/Widget.sol'].Widget.metadata = JSON.stringify({
    compiler: { version: '9.9.9+commit.transient' },
  });

  assert.throws(
    () =>
      verifyArtifactProvenance({
        outputDirectory: out,
        artifactPath,
        hooks: {
          afterInitialVerification() {
            fs.writeFileSync(buildInfoPath, JSON.stringify(transient));
          },
          afterBuildInfoLoad() {
            fs.writeFileSync(buildInfoPath, original);
          },
        },
      }),
    error => error.code === 'PROVENANCE_CHANGED',
  );
});

test('rejects a build-info symlink that escapes the absolute output tree', t => {
  const out = basicOut(t);
  const buildInfoPath = path.join(out, 'build-info/build.json');
  const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-tron-build-info-'));
  t.after(() => fs.rmSync(outsideDirectory, { recursive: true, force: true }));
  const outsideBuildInfo = path.join(outsideDirectory, 'build.json');
  fs.renameSync(buildInfoPath, outsideBuildInfo);
  fs.symlinkSync(outsideBuildInfo, buildInfoPath);

  assert.throws(
    () =>
      verifyArtifactProvenance({
        outputDirectory: out,
        artifactPath: path.join(out, 'Widget.sol/Widget.json'),
      }),
    error => error.code === 'ARTIFACT_OUTSIDE_OUTPUT',
  );
});

test('rejects an artifact leaf swapped to an escaping symlink after its boundary check', t => {
  const out = basicOut(t);
  const artifactPath = path.join(out, 'Widget.sol/Widget.json');
  const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-tron-artifact-swap-'));
  t.after(() => fs.rmSync(outsideDirectory, { recursive: true, force: true }));
  const outsideArtifact = path.join(outsideDirectory, 'Widget.json');
  fs.copyFileSync(artifactPath, outsideArtifact);

  assert.throws(
    () =>
      verifyArtifactProvenance({
        outputDirectory: out,
        artifactPath,
        hooks: {
          afterArtifactBoundaryCheck() {
            fs.rmSync(artifactPath);
            fs.symlinkSync(outsideArtifact, artifactPath);
          },
        },
      }),
    error => error.code === 'ARTIFACT_OUTSIDE_OUTPUT',
  );
});

test('binds both Hardhat 3 split build-info files to one verification snapshot', t => {
  const fixture = copyTree(t, path.join(provenanceFixtures, 'hh3-valid'));
  const out = path.join(fixture, 'artifacts/contracts');
  const artifactPath = path.join(out, 'contracts/Widget.sol/Widget.json');
  const outputPath = path.join(fixture, 'artifacts/build-info/solc-0_8_22-valid.output.json');
  const original = fs.readFileSync(outputPath, 'utf8');
  const transient = JSON.parse(original);
  transient.output.contracts['project/contracts/Widget.sol'].Widget.metadata = JSON.stringify({
    compiler: { version: '0.8.22+commit.transient' },
  });

  assert.throws(
    () =>
      verifyArtifactProvenance({
        outputDirectory: out,
        artifactPath,
        hooks: {
          afterInitialVerification() {
            fs.writeFileSync(outputPath, JSON.stringify(transient));
          },
          afterBuildInfoLoad() {
            fs.writeFileSync(outputPath, original);
          },
        },
      }),
    error => error.code === 'PROVENANCE_CHANGED',
  );
});

test('rejects FOUNDRY_OUT when the configured root itself is a symlink', t => {
  const out = basicOut(t);
  const symlink = `${out}-symlink`;
  fs.symlinkSync(out, symlink, 'dir');

  assert.throws(
    () => findArtifactPaths(symlink, 'Widget'),
    error => error.code === 'INVALID_OUTPUT_DIRECTORY',
  );
});

test('detects replacement of FOUNDRY_OUT by a different tree at the same path', t => {
  const out = basicOut(t);
  const artifactPath = path.join(out, 'Widget.sol/Widget.json');
  const displaced = `${out}-displaced`;

  assert.throws(
    () =>
      verifyArtifactProvenance({
        outputDirectory: out,
        artifactPath,
        hooks: {
          afterArtifactBoundaryCheck() {
            fs.renameSync(out, displaced);
            fs.cpSync(displaced, out, { recursive: true });
          },
        },
      }),
    error => error.code === 'PROVENANCE_CHANGED',
  );
});
