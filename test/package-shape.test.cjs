const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('package exposes Solidity sources and the RPC adapter', () => {
  const pkg = require('../package.json');
  const foundryConfig = fs.readFileSync('foundry.toml', 'utf8');
  const remappings = fs.readFileSync('remappings.txt', 'utf8');

  assert.equal(pkg.name, '@openzeppelin/foundry-upgrades-tron');
  assert.deepEqual(pkg.files, ['src/**/*', 'dist/rpc/**/*', 'rpc/SECURITY.md']);
  assert.equal(pkg.engines.node, '>=22');
  assert.equal(pkg.scripts.test, 'npm run test:package && npm run test:solidity && npm run test:rpc');
  assert.equal(pkg.scripts['test:package'], 'node scripts/test-package.cjs');
  assert.equal(pkg.scripts['test:solidity'], 'node scripts/test-solidity.cjs');
  assert.equal(pkg.scripts['test:rpc'], 'node scripts/test-rpc.cjs');
  assert.equal(pkg.scripts.lint, 'node scripts/lint.cjs');
  assert.equal(pkg.scripts['lint:fix'], 'node scripts/lint.cjs --write');
  assert.equal(pkg.scripts.prepack, 'npm run build:rpc && node scripts/require-package-contents.cjs');
  assert.equal(pkg.scripts.rpc, 'node dist/rpc/cli.js');
  assert.equal(pkg.scripts['rpc:start'], 'node dist/rpc/cli.js start');
  assert.equal(pkg.scripts['rpc:resolve'], 'node dist/rpc/cli.js resolve');
  assert.equal(pkg.scripts['rpc:mappings'], 'node dist/rpc/cli.js mappings');
  assert.deepEqual(pkg.bin, { 'openzeppelin-foundry-upgrades-tron': 'dist/rpc/cli.js' });

  assert.match(foundryConfig, /^ffi = true$/m);
  assert.match(foundryConfig, /^ast = true$/m);
  assert.match(foundryConfig, /^build_info = true$/m);
  assert.match(foundryConfig, /^extra_output = \["storageLayout"\]$/m);
  assert.match(remappings, /^openzeppelin-foundry-upgrades-tron\/=src\/$/m);
  assert.match(remappings, /^openzeppelin-tron-solidity\/=lib\/openzeppelin-tron-solidity\/$/m);
});

test('modern Solidity surface does not export deployment implementation helpers', () => {
  const source = fs.readFileSync('src/Upgrades.sol', 'utf8');
  assert.doesNotMatch(source, /function\s+requireTRC1967Initialization\s*\(/u);
});

test('published Solidity surfaces exclude Defender and unsupported legacy deployment APIs', () => {
  const sourceFiles = listFiles('src').filter(file => file.endsWith('.sol'));
  const source = sourceFiles.map(file => fs.readFileSync(file, 'utf8')).join('\n');
  const legacySource = fs.readFileSync('src/LegacyUpgrades.sol', 'utf8');

  assert.equal(sourceFiles.includes(path.join('src', 'Defender.sol')), false);
  assert.equal(sourceFiles.includes(path.join('src', 'LegacyUpgrades.sol')), true);
  for (const unsupported of [
    /\bDefenderOptions\b/u,
    /\bTxOverrides\b/u,
    /\bProposeUpgradeResponse\b/u,
    /\bApprovalProcessResponse\b/u,
    /\buseDefenderDeploy\b/u,
    /\bskipVerifySourceCode\b/u,
    /\bdeployContract\s*\(/u,
    /\bproposeUpgrade\b/u,
    /\bgetDeployApprovalProcess\b/u,
    /\bgetUpgradeApprovalProcess\b/u,
    /\bforceImport\s*\(/u,
  ]) {
    assert.doesNotMatch(source, unsupported);
  }

  for (const unsupportedLegacy of [
    /function\s+deployUUPSProxy\s*\(/u,
    /function\s+deployTransparentProxy\s*\(/u,
    /function\s+deployBeacon\s*\(/u,
    /function\s+deployBeaconProxy\s*\(/u,
    /function\s+validateImplementation\s*\(/u,
    /function\s+deployImplementation\s*\(/u,
  ]) {
    assert.doesNotMatch(legacySource, unsupportedLegacy);
  }
});

test('compile-only consumer locks modern and legacy overload counts', () => {
  const apiShape = fs.readFileSync('test/ApiShape.t.sol', 'utf8');
  const validated = apiShape.match(/^    function validated[A-Za-z0-9_]*\s*\(/gmu) ?? [];
  const unsafe = apiShape.match(/^    function unsafe[A-Za-z0-9_]*\s*\(/gmu) ?? [];
  const legacyValidated = apiShape.match(/^    function legacyValidated[A-Za-z0-9_]*\s*\(/gmu) ?? [];
  const legacyUnsafe = apiShape.match(/^    function legacyUnsafe[A-Za-z0-9_]*\s*\(/gmu) ?? [];

  assert.equal(validated.length, 23);
  assert.equal(unsafe.length, 11);
  assert.equal(legacyValidated.length, 13);
  assert.equal(legacyUnsafe.length, 7);
});

test('every supported modern library function has adjacent NatSpec', () => {
  const source = fs.readFileSync('src/Upgrades.sol', 'utf8');
  const functions = [...source.matchAll(/^    function\s+[A-Za-z0-9_]+\s*\(/gmu)];
  let supportedFunctions = 0;

  for (const match of functions) {
    const signatureEnd = source.indexOf('{', match.index);
    const signature = source.slice(match.index, signatureEnd);
    if (/\bprivate\b/u.test(signature)) continue;
    supportedFunctions += 1;
    const prefix = source.slice(0, match.index).trimEnd();
    const commentStart = prefix.lastIndexOf('/**');
    const comment = prefix.slice(commentStart);
    assert.ok(commentStart >= 0 && comment.endsWith('*/'), `missing adjacent NatSpec for ${signature.trim()}`);
    assert.match(comment, /@dev\s+\S/u, `missing @dev summary for ${signature.trim()}`);
  }

  assert.equal(supportedFunctions, 34);
});

test('every supported legacy library function has adjacent NatSpec', () => {
  const source = fs.readFileSync('src/LegacyUpgrades.sol', 'utf8');
  const functions = [...source.matchAll(/^    function\s+[A-Za-z0-9_]+\s*\(/gmu)];

  for (const match of functions) {
    const signatureEnd = source.indexOf('{', match.index);
    const signature = source.slice(match.index, signatureEnd);
    const prefix = source.slice(0, match.index).trimEnd();
    const commentStart = prefix.lastIndexOf('/**');
    const comment = prefix.slice(commentStart);
    assert.ok(commentStart >= 0 && comment.endsWith('*/'), `missing adjacent NatSpec for ${signature.trim()}`);
    assert.match(comment, /@dev\s+\S/u, `missing @dev summary for ${signature.trim()}`);
  }

  assert.equal(functions.length, 20);
});

test('public documentation covers the supported modern TVM workflow and intentional divergences', () => {
  const files = ['README.md', 'CONTRIBUTING.md', 'CHANGELOG.md'];
  const documentation = files.map(file => fs.readFileSync(file, 'utf8')).join('\n');

  for (const required of [
    /openzeppelin-foundry-upgrades-tron\//u,
    /openzeppelin-tron-solidity\//u,
    /ffi\s*=\s*true/u,
    /build_info\s*=\s*true/u,
    /storageLayout/u,
    /FOUNDRY_OUT/u,
    /compiler provenance/iu,
    /FFI security/iu,
    /non-?empty initializer/iu,
    /LinkedLibrary/u,
    /UnsafeUpgrades/u,
    /Defender[^.]{0,80}(?:unsupported|not supported|not included)/iu,
    /(?:verification|source verification)[^.]{0,80}(?:unsupported|not supported|not translated)/iu,
    /forking[^.]{0,80}(?:unsupported|not supported)/iu,
    /LegacyUpgrades\.sol/iu,
    /v4\.9\.6/u,
    /v4\.9\.6[^.]{0,160}(?:pending|not yet confirmed)/iu,
    /actual[^.]{0,80}(?:TVM|TRON)[^.]{0,80}address/iu,
    /ETH_RPC_TIMEOUT=300/u,
    /`Box\.sol`[\s\S]{0,200}`Box\.sol:Box`[\s\S]{0,200}`out\/Box\.sol\/Box\.json`/u,
    /`tryCaller`[\s\S]{0,120}(?:tests|test-only)/iu,
    /`TRC1967InitializationRequired`/u,
    /`unsafeAllow`[\s\S]{0,120}comma-separated/iu,
    /`exclude`[\s\S]{0,160}glob[\s\S]{0,160}reference contracts/iu,
    /`referenceBuildInfoDir`[\s\S]{0,120}(?:absolute|project-relative)/iu,
  ]) {
    assert.match(documentation, required);
  }

  // The deprecated Antora sources are deleted; user docs live in the README and the docs-site repo.
  assert.equal(fs.existsSync(path.resolve(__dirname, '..', 'docs')), false);
  // The external stock-TRE v4 lifecycle is not confirmed; documentation must not claim it as evidence.
  assert.doesNotMatch(
    documentation,
    /external[^.]{0,120}(?:evidence|lifecycle)[^.]{0,120}(?:genuine|pinned)[^.]{0,80}v4\.9\.6/iu,
  );
});

test('documents opaque external v4 upgrade limits and the adoption route', () => {
  const readme = fs.readFileSync('README.md', 'utf8');
  assert.match(readme, /opaque[\s\S]{0,300}`upgradeToAndCall`[\s\S]{0,300}`upgradeAndCall`[\s\S]{0,300}`upgradeTo`/iu);
  assert.match(readme, /v4 UUPS[\s\S]{0,220}empty[\s\S]{0,220}not recognized/iu);
  assert.match(readme, /v4 transparent[\s\S]{0,240}empty[\s\S]{0,240}not recognized/iu);
  assert.match(readme, /adopt[\s\S]{0,220}`uups-proxy`[\s\S]{0,220}current implementation/iu);
  assert.match(readme, /"OPAQUE_PREDICTED_ADDRESS"/u);
});

test('published package contains runtime RPC files but no tests or fixture build output', () => {
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
  });
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const files = JSON.parse(packed.stdout)[0].files.map(file => file.path);

  for (const runtime of ['src/Upgrades.sol', 'src/LegacyUpgrades.sol', 'dist/rpc/cli.js', 'rpc/SECURITY.md']) {
    assert.ok(files.includes(runtime), `missing ${runtime}`);
  }
  assert.equal(
    files.some(file => file.startsWith('rpc/test/')),
    false,
  );
  assert.equal(
    files.some(file => file.startsWith('rpc-src/')),
    false,
  );
  assert.equal(
    files.some(file => /\.test\.(c?ts|c?js)$/u.test(file)),
    false,
  );
  assert.equal(
    files.some(file => /^tsconfig.*\.json$/u.test(path.basename(file))),
    false,
  );
  assert.equal(
    files.some(file => /(?:^|\/)out\//u.test(file)),
    false,
  );
});

test('prepack guard requires both Solidity and RPC implementations', t => {
  const { REQUIRED_PACKAGE_FILES, assertPackageContents } = require('../scripts/require-package-contents.cjs');
  assert.ok(REQUIRED_PACKAGE_FILES.includes('src/LegacyUpgrades.sol'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-upgrades-tron-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(() => assertPackageContents(root), /missing required package files/i);

  for (const file of REQUIRED_PACKAGE_FILES) {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, 'required');
  }

  assert.doesNotThrow(() => assertPackageContents(root));

  fs.rmSync(path.join(root, 'src', 'internal', 'artifact-provenance.cjs'));
  assert.throws(() => assertPackageContents(root), /artifact-provenance\.cjs/);
});

test('dotenv variants are ignored except for the example', () => {
  const gitignore = fs.readFileSync('.gitignore', 'utf8');

  assert.match(gitignore, /^\.env\.\*$/m);
  assert.match(gitignore, /^!\.env\.example$/m);
  assert.match(gitignore, /^\.openzeppelin-upgrades\/$/m);
});

test('documents adapter security boundaries and fail-closed unsupported writes', () => {
  const security = fs.readFileSync('rpc/SECURITY.md', 'utf8');

  assert.match(security, /loopback/i);
  assert.match(security, /private key/i);
  assert.match(security, /signed native transaction/i);
  assert.match(security, /CREATE2/);
  assert.match(security, /typed transaction/i);
  assert.match(security, /constant payload simulation/i);
  assert.match(security, /0600/);
  assert.match(security, /transaction[- ]shape\s+validation/i);
  assert.match(security, /`repair`/);
  assert.match(security, /reconstructed\s+later\s+under\s+the\s+same\s+provenance\s+check/i);
  assert.doesNotMatch(security, /snapshot\s+captured\s+at\s+deployment\s+when/i);
  assert.match(security, /upgrade-safety/i);
  assert.doesNotMatch(security, /adopt.{0,40}only writer besides the deployment flow/i);
});

test('documents the nonstandard fail-closed simulation requirement without overstating public support', () => {
  const readme = fs.readFileSync('README.md', 'utf8');

  assert.match(readme, /POST\s+`wallet\/simulatesignedtransaction`/);
  assert.match(readme, /matching native[\s\S]{0,20}transaction ID/i);
  assert.match(readme, /complete ordered child-`CREATE` trace/);
  assert.match(readme, /stock TRE and java-tron/);
  assert.match(readme, /constant, non-broadcasting[\s\S]{0,80}capability probe/i);
  assert.match(readme, /ambiguous child creations fail before broadcast/i);
  assert.match(readme, /numbered block tags[\s\S]{0,180}latest/i);
  assert.match(readme, /not archival or fork support/i);
  assert.doesNotMatch(readme, /Task \d+/i);
});

function listFiles(relativeDirectory) {
  return fs.readdirSync(relativeDirectory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(relativeDirectory, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  });
}
