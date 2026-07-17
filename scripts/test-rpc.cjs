const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function collectTests(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? collectTests(entryPath) : [entryPath];
    })
    .filter(file => file.endsWith('.test.cjs') || file.endsWith('.test.ts'))
    .sort();
}

const rpcSrcDir = path.join(root, 'rpc-src');
if (fs.existsSync(rpcSrcDir) && fs.readdirSync(rpcSrcDir).some(f => f.endsWith('.ts'))) {
  const buildResult = spawnSync('npm', ['run', 'build:rpc'], { cwd: root, stdio: 'inherit' });
  if (buildResult.error) {
    throw buildResult.error;
  }
  if (buildResult.status !== 0) {
    process.exitCode = buildResult.status ?? 1;
    return;
  }
}

const tests = collectTests(path.join(root, 'rpc'));
if (tests.length > 0) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...tests], { cwd: root, stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
}
