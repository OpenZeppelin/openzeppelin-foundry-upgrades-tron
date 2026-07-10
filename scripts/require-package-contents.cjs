const fs = require('node:fs');
const path = require('node:path');

function containsFileWithExtension(directory, extension) {
  if (!fs.existsSync(directory)) {
    return false;
  }

  return fs.readdirSync(directory, { withFileTypes: true }).some(entry => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory()
      ? containsFileWithExtension(entryPath, extension)
      : entry.isFile() && path.extname(entry.name) === extension;
  });
}

function assertPackageContents(root) {
  const missing = [];
  if (!containsFileWithExtension(path.join(root, 'src'), '.sol')) {
    missing.push('src/ Solidity implementation');
  }
  if (!containsFileWithExtension(path.join(root, 'rpc'), '.cjs')) {
    missing.push('rpc/ adapter implementation');
  }

  if (missing.length > 0) {
    throw new Error(`Refusing to publish without ${missing.join(' and ')}`);
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

module.exports = { assertPackageContents };
