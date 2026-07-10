'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AbiCoder, keccak256, toUtf8Bytes } = require('ethers');

const CODE = Object.freeze({
  success: 0,
  buildInfoNotFound: 1,
  ambiguousBuildInfo: 2,
  bytecodeMismatch: 3,
  compilerVersionMismatch: 4,
  missingCompilerIdentity: 5,
  missingSource: 6,
  sourceHashMismatch: 7,
  compilerBuildMismatch: 8,
  artifactOutsideOutput: 9,
  toolFailure: 255,
});

const ZERO_HASH = `0x${'00'.repeat(32)}`;
const resultTypes = ['uint8', 'bytes32', 'string', 'string', 'bytes32', 'bytes32'];
const provenanceTypes = [
  'string',
  'string',
  'string',
  'string',
  'string',
  'string',
  'string',
  'string[]',
  'bytes32[]',
];

function response(code, hash = ZERO_HASH, detailA = '', detailB = '', expected = ZERO_HASH, actual = ZERO_HASH) {
  return AbiCoder.defaultAbiCoder().encode(resultTypes, [code, hash, detailA, detailB, expected, actual]);
}

function normalizeBytecode(value) {
  if (typeof value !== 'string') throw new Error('Missing creation bytecode');
  return value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
}

function semanticVersion(version) {
  return version.split('+', 1)[0];
}

function buildInfoDirectory(outputDirectory) {
  const normalized = path.resolve(outputDirectory);
  const suffix = `${path.sep}artifacts${path.sep}contracts`;
  return normalized.endsWith(suffix)
    ? path.join(normalized.slice(0, -'contracts'.length), 'build-info')
    : path.join(normalized, 'build-info');
}

function findJsonFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...findJsonFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path.resolve(entryPath));
  }
  return files.sort();
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function verify([outputDirectoryArg, artifactPathArg, contractPath, contractName, fullyQualifiedName]) {
  if (![outputDirectoryArg, artifactPathArg, contractPath, contractName, fullyQualifiedName].every(value => typeof value === 'string')) {
    return response(CODE.toolFailure, ZERO_HASH, 'Expected output directory, artifact, source, contract, and FQN');
  }

  const outputDirectory = path.resolve(outputDirectoryArg);
  const artifactPath = path.resolve(artifactPathArg);
  if (!isWithin(outputDirectory, artifactPath)) {
    return response(CODE.artifactOutsideOutput, ZERO_HASH, artifactPath, outputDirectory);
  }

  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  const artifactSourceName = artifact.ast.absolutePath;
  const candidates = findJsonFiles(buildInfoDirectory(outputDirectory)).filter(file => {
    const buildInfo = JSON.parse(fs.readFileSync(file, 'utf8'));
    return buildInfo.output?.contracts?.[artifactSourceName]?.[contractName] !== undefined;
  });
  if (candidates.length === 0) return response(CODE.buildInfoNotFound, ZERO_HASH, fullyQualifiedName);
  if (candidates.length !== 1) return response(CODE.ambiguousBuildInfo, ZERO_HASH, fullyQualifiedName);

  const buildInfoFile = candidates[0];
  const buildInfo = JSON.parse(fs.readFileSync(buildInfoFile, 'utf8'));
  const artifactCompilerVersion = artifact.metadata?.compiler?.version;
  const solcVersion = buildInfo.solcVersion;
  const solcLongVersion = buildInfo.solcLongVersion;
  if (typeof artifactCompilerVersion !== 'string' || typeof solcVersion !== 'string' || semanticVersion(artifactCompilerVersion) !== semanticVersion(solcVersion)) {
    return response(CODE.compilerVersionMismatch, ZERO_HASH, artifactCompilerVersion ?? '', solcVersion ?? '');
  }
  if (typeof solcLongVersion !== 'string' || solcLongVersion.length === 0) {
    return response(CODE.missingCompilerIdentity, ZERO_HASH, buildInfoFile);
  }
  if (solcLongVersion.includes('+') && artifactCompilerVersion !== solcLongVersion) {
    return response(CODE.compilerBuildMismatch, ZERO_HASH, artifactCompilerVersion, solcLongVersion);
  }

  const artifactBytecode = normalizeBytecode(artifact.bytecode?.object);
  const buildBytecode = normalizeBytecode(
    buildInfo.output.contracts[artifactSourceName][contractName]?.evm?.bytecode?.object,
  );
  if (artifactBytecode !== buildBytecode) return response(CODE.bytecodeMismatch, ZERO_HASH, fullyQualifiedName);

  const metadataSources = artifact.metadata?.sources;
  if (metadataSources === null || typeof metadataSources !== 'object') {
    return response(CODE.toolFailure, ZERO_HASH, 'Artifact metadata sources are missing');
  }
  const sourceNames = Object.keys(metadataSources).sort();
  const sourceHashes = [];
  for (const sourceName of sourceNames) {
    const content = buildInfo.input?.sources?.[sourceName]?.content;
    if (typeof content !== 'string') return response(CODE.missingSource, ZERO_HASH, sourceName);
    const actual = keccak256(toUtf8Bytes(content));
    const expected = metadataSources[sourceName]?.keccak256;
    if (typeof expected !== 'string' || actual.toLowerCase() !== expected.toLowerCase()) {
      return response(CODE.sourceHashMismatch, ZERO_HASH, sourceName, '', expected ?? ZERO_HASH, actual);
    }
    sourceHashes.push(actual);
  }

  const hash = keccak256(
    AbiCoder.defaultAbiCoder().encode(provenanceTypes, [
      outputDirectory,
      buildInfoFile,
      artifactCompilerVersion,
      solcVersion,
      solcLongVersion,
      `${contractPath}:${contractName}`,
      artifactBytecode,
      sourceNames,
      sourceHashes,
    ]),
  );
  return response(CODE.success, hash);
}

function main(args) {
  try {
    process.stdout.write(verify(args));
  } catch (error) {
    process.stdout.write(response(CODE.toolFailure, ZERO_HASH, error instanceof Error ? error.message : String(error)));
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { CODE, buildInfoDirectory, findJsonFiles, main, normalizeBytecode, verify };
