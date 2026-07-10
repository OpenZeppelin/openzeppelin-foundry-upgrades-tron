const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function containsTest(directory) {
  if (!fs.existsSync(directory)) {
    return false;
  }

  return fs.readdirSync(directory, { withFileTypes: true }).some(entry => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? containsTest(entryPath) : entry.isFile() && entry.name.endsWith('.t.sol');
  });
}

if (containsTest(path.join(root, 'test'))) {
  const result = spawnSync('forge', ['test', '-vvv', '--ffi', '--force'], {
    cwd: root,
    env: { ...process.env, FOUNDRY_OUT: 'out', FOUNDRY_PROFILE: 'default' },
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
}
