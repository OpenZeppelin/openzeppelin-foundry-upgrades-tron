const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..', '..');
test('tsc emits the gateway to dist/rpc', () => {
  for (const f of ['cli.js', 'cli.d.ts', 'handlers.js', 'handlers.d.ts']) {
    assert.ok(fs.existsSync(path.join(root, 'dist', 'rpc', f)), `missing dist/rpc/${f}`);
  }
  assert.ok(!fs.existsSync(path.join(root, 'rpc-src', 'cli.js')), 'no .js may be emitted beside sources');
});
