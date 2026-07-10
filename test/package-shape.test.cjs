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
