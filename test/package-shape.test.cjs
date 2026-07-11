const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('package exposes Solidity sources and the RPC adapter', () => {
  const pkg = require('../package.json');
  const foundryConfig = fs.readFileSync('foundry.toml', 'utf8');
  const remappings = fs.readFileSync('remappings.txt', 'utf8');

  assert.equal(pkg.name, '@openzeppelin/foundry-upgrades-tron');
  assert.deepEqual(pkg.files, ['src/**/*', 'rpc/**/*']);
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

test('prepack guard requires both Solidity and RPC implementations', t => {
  const { assertPackageContents } = require('../scripts/require-package-contents.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-upgrades-tron-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(() => assertPackageContents(root), /src\/.*rpc\//);

  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'rpc'));
  fs.writeFileSync(path.join(root, 'src', 'Upgrades.sol'), 'library Upgrades {}');
  fs.writeFileSync(path.join(root, 'rpc', 'cli.cjs'), 'module.exports = {};');

  assert.doesNotThrow(() => assertPackageContents(root));
});

test('dotenv variants are ignored except for the example', () => {
  const gitignore = fs.readFileSync('.gitignore', 'utf8');

  assert.match(gitignore, /^\.env\.\*$/m);
  assert.match(gitignore, /^!\.env\.example$/m);
});

test('documents the nonstandard fail-closed simulation requirement without overstating public support', () => {
  const readme = fs.readFileSync('README.md', 'utf8');

  assert.match(readme, /POST\s+`wallet\/simulatesignedtransaction`/);
  assert.match(readme, /matching native transaction ID/);
  assert.match(readme, /`trace_complete: true`/);
  assert.match(readme, /ordered\s+`child_create_attempts`/);
  assert.match(readme, /stock[\s\S]{0,80}java-tron[\s\S]{0,160}do not provide/i);
  assert.match(readme, /write requests fail closed/i);
  assert.match(readme, /TRE readiness diagnostic/i);
  assert.doesNotMatch(readme, /Task \d+/i);
});
