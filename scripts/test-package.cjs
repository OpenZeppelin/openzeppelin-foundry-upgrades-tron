'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function collectTests(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? collectTests(entryPath) : [entryPath];
    })
    .filter(file => file.endsWith('.test.cjs'))
    .sort();
}

function runPackageTests() {
  const tests = collectTests(path.join(root, 'test'));
  if (tests.length === 0) throw new Error('No package tests found under test/');
  const result = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (require.main === module) process.exitCode = runPackageTests();

module.exports = { collectTests, runPackageTests };
