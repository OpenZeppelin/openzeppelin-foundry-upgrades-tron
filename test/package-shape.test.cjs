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
  assert.deepEqual(pkg.files, ['src/**/*', 'rpc/*.cjs', 'rpc/SECURITY.md']);
  assert.equal(pkg.engines.node, '>=20');
  assert.equal(pkg.scripts.test, 'npm run test:package && npm run test:solidity && npm run test:rpc');
  assert.equal(pkg.scripts['test:package'], 'node scripts/test-package.cjs');
  assert.equal(pkg.scripts['test:solidity'], 'node scripts/test-solidity.cjs');
  assert.equal(pkg.scripts['test:rpc'], 'node scripts/test-rpc.cjs');
  assert.equal(pkg.scripts.lint, 'node scripts/lint.cjs');
  assert.equal(pkg.scripts['lint:fix'], 'node scripts/lint.cjs --write');
  assert.equal(pkg.scripts.prepack, 'node scripts/require-package-contents.cjs');
  assert.equal(pkg.scripts.rpc, 'node rpc/cli.cjs');
  assert.equal(pkg.scripts['rpc:start'], 'node rpc/cli.cjs start');
  assert.equal(pkg.scripts['rpc:resolve'], 'node rpc/cli.cjs resolve');
  assert.equal(pkg.scripts['rpc:mappings'], 'node rpc/cli.cjs mappings');
  assert.deepEqual(pkg.bin, { 'openzeppelin-foundry-upgrades-tron': 'rpc/cli.cjs' });

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

test('modern Solidity surface excludes unsupported Defender and evidence-gated legacy APIs', () => {
  const sourceFiles = listFiles('src').filter(file => file.endsWith('.sol'));
  const source = sourceFiles.map(file => fs.readFileSync(file, 'utf8')).join('\n');

  assert.equal(sourceFiles.includes(path.join('src', 'Defender.sol')), false);
  assert.equal(sourceFiles.includes(path.join('src', 'LegacyUpgrades.sol')), false);
  assert.equal(
    sourceFiles.some(file => /(?:legacy|v4).*upgrades/iu.test(file)),
    false,
  );
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
    /\bLegacyUpgrades\b/u,
    /\bUnsafeLegacyUpgrades\b/u,
  ]) {
    assert.doesNotMatch(source, unsupported);
  }
});

test('compile-only consumer locks all modern overload counts', () => {
  const apiShape = fs.readFileSync('test/ApiShape.t.sol', 'utf8');
  const validated = apiShape.match(/^    function validated[A-Za-z0-9_]*\s*\(/gmu) ?? [];
  const unsafe = apiShape.match(/^    function unsafe[A-Za-z0-9_]*\s*\(/gmu) ?? [];

  assert.equal(validated.length, 23);
  assert.equal(unsafe.length, 11);
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

test('public documentation covers the supported modern TVM workflow and intentional divergences', () => {
  const files = [
    'README.md',
    'CONTRIBUTING.md',
    'CHANGELOG.md',
    'docs/modules/pages/foundry-upgrades-tron.adoc',
    'docs/modules/api/pages/api-foundry-upgrades-tron.adoc',
    'docs/modules/api/pages/Options.adoc',
    'docs/modules/api/pages/Upgrades.adoc',
  ];
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
    /legacy[^.]{0,120}(?:evidence-gated|not currently exported)/iu,
    /actual[^.]{0,80}(?:TVM|TRON)[^.]{0,80}address/iu,
  ]) {
    assert.match(documentation, required);
  }
});

test('published package contains runtime RPC files but no tests or fixture build output', () => {
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
  });
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const files = JSON.parse(packed.stdout)[0].files.map(file => file.path);

  for (const runtime of ['src/Upgrades.sol', 'rpc/cli.cjs', 'rpc/SECURITY.md']) {
    assert.ok(files.includes(runtime), `missing ${runtime}`);
  }
  assert.equal(
    files.some(file => file.startsWith('rpc/test/')),
    false,
  );
  assert.equal(
    files.some(file => /(?:^|\/)out\//u.test(file)),
    false,
  );
});

test('prepack guard requires both Solidity and RPC implementations', t => {
  const { REQUIRED_PACKAGE_FILES, assertPackageContents } = require('../scripts/require-package-contents.cjs');
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
