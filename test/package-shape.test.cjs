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
