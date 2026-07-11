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
  fs.rmSync(path.join(root, 'out-unlinked'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'cache-unlinked'), { recursive: true, force: true });

  const unlinkedBuild = spawnSync('forge', ['build', '--force'], {
    cwd: root,
    env: { ...process.env, FOUNDRY_OUT: 'out-unlinked', FOUNDRY_PROFILE: 'unlinked' },
    stdio: 'inherit',
  });
  if (unlinkedBuild.error) {
    throw unlinkedBuild.error;
  }
  if (unlinkedBuild.status !== 0) {
    process.exitCode = unlinkedBuild.status ?? 1;
    return;
  }

  const result = spawnSync(
    'forge',
    ['test', '-vvv', '--ffi', '--force', '--no-match-test', 'testValidatedDeploymentLinksBoundExternalLibraryArtifact'],
    {
      cwd: root,
      env: { ...process.env, FOUNDRY_OUT: 'out', FOUNDRY_PROFILE: 'default' },
      stdio: 'inherit',
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return;
  }

  const linkedResult = spawnSync(
    'forge',
    ['test', '-vvv', '--ffi', '--match-test', 'testValidatedDeploymentLinksBoundExternalLibraryArtifact'],
    {
      cwd: root,
      env: { ...process.env, FOUNDRY_OUT: 'out-unlinked', FOUNDRY_PROFILE: 'unlinked' },
      stdio: 'inherit',
    },
  );
  if (linkedResult.error) {
    throw linkedResult.error;
  }
  process.exitCode = linkedResult.status ?? 1;
}
