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
  const artifactsRoot = fs.mkdtempSync(path.join(root, 'test_artifacts.solidity-'));
  const defaultCache = path.join(artifactsRoot, 'cache-default');
  const unlinkedOut = path.join(artifactsRoot, 'out-unlinked');
  const unlinkedCache = path.join(artifactsRoot, 'cache-unlinked');
  const prelinkedOut = path.join(artifactsRoot, 'out-prelinked');
  const prelinkedCache = path.join(artifactsRoot, 'cache-prelinked');

  try {
    const unlinkedBuild = spawnSync('forge', ['build', '--force'], {
      cwd: root,
      env: {
        ...process.env,
        FOUNDRY_OUT: unlinkedOut,
        FOUNDRY_CACHE_PATH: unlinkedCache,
        FOUNDRY_PROFILE: 'unlinked',
      },
      stdio: 'inherit',
    });
    if (unlinkedBuild.error) {
      throw unlinkedBuild.error;
    }
    if (unlinkedBuild.status !== 0) {
      process.exitCode = unlinkedBuild.status ?? 1;
      return;
    }

    const prelinkedBuild = spawnSync('forge', ['build', '--force'], {
      cwd: root,
      env: {
        ...process.env,
        FOUNDRY_OUT: prelinkedOut,
        FOUNDRY_CACHE_PATH: prelinkedCache,
        FOUNDRY_PROFILE: 'prelinked',
      },
      stdio: 'inherit',
    });
    if (prelinkedBuild.error) {
      throw prelinkedBuild.error;
    }
    if (prelinkedBuild.status !== 0) {
      process.exitCode = prelinkedBuild.status ?? 1;
      return;
    }

    const result = spawnSync(
      'forge',
      [
        'test',
        '-vvv',
        '--ffi',
        '--force',
        '--no-match-test',
        'testValidatedDeployment(LinksBound|UsesPrelinked)ExternalLibraryArtifact|testGetOutDirDefaultsAndReadsEnvironment',
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          FOUNDRY_OUT: 'out',
          FOUNDRY_CACHE_PATH: defaultCache,
          FOUNDRY_PROFILE: 'default',
        },
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

    // testGetOutDirDefaultsAndReadsEnvironment mutates the FOUNDRY_OUT env var via
    // vm.setEnv, which forge's cheatcode implementation applies process-wide rather
    // than per-test. Forge runs test functions across a multi-threaded pool by
    // default, so running this test alongside the rest of the suite races any
    // concurrently scheduled test that resolves artifact paths through
    // Utils.getOutDir() (itself backed by the same env var): that test can
    // transiently observe the mutated value and fail to locate its artifact.
    // Run it in complete isolation so no other test observes the mutation.
    const outDirEnvResult = spawnSync(
      'forge',
      ['test', '-vvv', '--ffi', '--match-test', 'testGetOutDirDefaultsAndReadsEnvironment'],
      {
        cwd: root,
        env: {
          ...process.env,
          FOUNDRY_OUT: 'out',
          FOUNDRY_CACHE_PATH: defaultCache,
          FOUNDRY_PROFILE: 'default',
        },
        stdio: 'inherit',
      },
    );
    if (outDirEnvResult.error) {
      throw outDirEnvResult.error;
    }
    if (outDirEnvResult.status !== 0) {
      process.exitCode = outDirEnvResult.status ?? 1;
      return;
    }

    const linkedResult = spawnSync(
      'forge',
      ['test', '-vvv', '--ffi', '--match-test', 'testValidatedDeploymentLinksBoundExternalLibraryArtifact'],
      {
        cwd: root,
        env: {
          ...process.env,
          FOUNDRY_OUT: unlinkedOut,
          FOUNDRY_CACHE_PATH: unlinkedCache,
          FOUNDRY_PROFILE: 'unlinked',
        },
        stdio: 'inherit',
      },
    );
    if (linkedResult.error) {
      throw linkedResult.error;
    }
    if (linkedResult.status !== 0) {
      process.exitCode = linkedResult.status ?? 1;
      return;
    }

    const prelinkedResult = spawnSync(
      'forge',
      ['test', '-vvv', '--ffi', '--match-test', 'testValidatedDeploymentUsesPrelinkedExternalLibraryArtifact'],
      {
        cwd: root,
        env: {
          ...process.env,
          FOUNDRY_OUT: prelinkedOut,
          FOUNDRY_CACHE_PATH: prelinkedCache,
          FOUNDRY_PROFILE: 'prelinked',
        },
        stdio: 'inherit',
      },
    );
    if (prelinkedResult.error) {
      throw prelinkedResult.error;
    }
    process.exitCode = prelinkedResult.status ?? 1;
  } finally {
    fs.rmSync(artifactsRoot, { recursive: true, force: true });
  }
}
