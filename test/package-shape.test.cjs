const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('package exposes Solidity sources and the RPC adapter', () => {
  const pkg = require('../package.json');
  const foundryConfig = fs.readFileSync('foundry.toml', 'utf8');
  const remappings = fs.readFileSync('remappings.txt', 'utf8');

  assert.equal(pkg.name, '@openzeppelin/foundry-upgrades-tron');
  assert.deepEqual(pkg.files, ['src/**/*', 'rpc/**/*']);
  assert.equal(pkg.engines.node, '>=20');
  assert.equal(typeof pkg.scripts.test, 'string');
  assert.equal(typeof pkg.scripts['test:rpc'], 'string');
  assert.equal(typeof pkg.scripts.lint, 'string');
  assert.equal(pkg.scripts.rpc, 'node rpc/cli.cjs');

  assert.match(foundryConfig, /^ffi = true$/m);
  assert.match(foundryConfig, /^ast = true$/m);
  assert.match(foundryConfig, /^build_info = true$/m);
  assert.match(foundryConfig, /^extra_output = \["storageLayout"\]$/m);
  assert.match(remappings, /^openzeppelin-foundry-upgrades-tron\/=src\/$/m);
  assert.match(remappings, /^openzeppelin-tron-solidity\/=lib\/openzeppelin-tron-solidity\/$/m);
});
