const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_PACKAGE_FILES = Object.freeze([
  'src/Options.sol',
  'src/Upgrades.sol',
  'src/internal/Core.sol',
  'src/internal/artifact-provenance.cjs',
  'rpc/SECURITY.md',
  'rpc/cli.cjs',
  'rpc/handlers.cjs',
]);

function assertPackageContents(root) {
  const missing = REQUIRED_PACKAGE_FILES.filter(
    file => !fs.statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile(),
  );

  if (missing.length > 0) {
    throw new Error(`Refusing to publish: missing required package files: ${missing.join(', ')}`);
  }
}

if (require.main === module) {
  try {
    assertPackageContents(path.resolve(__dirname, '..'));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { REQUIRED_PACKAGE_FILES, assertPackageContents };
