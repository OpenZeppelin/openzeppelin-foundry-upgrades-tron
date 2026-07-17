const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const write = process.argv.includes('--write');

function collectFiles(relativeDirectory, extensions) {
  const directory = path.join(root, relativeDirectory);
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const relativePath = path.join(relativeDirectory, entry.name);
      return entry.isDirectory() ? collectFiles(relativePath, extensions) : [relativePath];
    })
    .filter(file => extensions.has(path.extname(file)))
    .sort();
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const prettierFiles = [
  ...collectFiles('src', new Set(['.sol'])),
  ...collectFiles('test', new Set(['.cjs', '.sol'])),
  ...collectFiles('rpc', new Set(['.cjs'])),
  ...collectFiles('scripts', new Set(['.cjs'])),
];
if (prettierFiles.length > 0) {
  run('prettier', ['--log-level', 'warn', write ? '--write' : '--check', ...prettierFiles]);
}

const solidityFiles = collectFiles('src', new Set(['.sol']));
if (!write && solidityFiles.length > 0) {
  run('solhint', solidityFiles);
}
