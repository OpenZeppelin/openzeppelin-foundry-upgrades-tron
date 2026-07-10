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
  buildInfoIdentityMismatch: 10,
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

function remapKeys(record, canonicalToUser) {
  return Object.fromEntries(Object.entries(record ?? {}).map(([key, value]) => [canonicalToUser[key] ?? key, value]));
}

function loadBuildInfo(artifact, outputDirectory, contractName, fullyQualifiedName) {
  const directory = buildInfoDirectory(outputDirectory);
  if (artifact._format === 'hh3-artifact-1') {
    const id = artifact.buildInfoId;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) {
      return { error: response(CODE.buildInfoIdentityMismatch, ZERO_HASH, 'valid Hardhat buildInfoId', id ?? '') };
    }
    const mainPath = path.resolve(directory, `${id}.json`);
    const outputPath = path.resolve(directory, `${id}.output.json`);
    if (!fs.existsSync(mainPath) || !fs.existsSync(outputPath)) {
      return { error: response(CODE.buildInfoNotFound, ZERO_HASH, fullyQualifiedName) };
    }
    const main = JSON.parse(fs.readFileSync(mainPath, 'utf8'));
    const split = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    if (
      typeof main._format !== 'string' ||
      !main._format.startsWith('hh3-sol-build-info') ||
      typeof split._format !== 'string' ||
      !split._format.startsWith('hh3-sol-build-info-output')
    ) {
      return { error: response(CODE.buildInfoIdentityMismatch, ZERO_HASH, id, 'invalid Hardhat build-info format') };
    }
    if (main.id !== id) {
      return { error: response(CODE.buildInfoIdentityMismatch, ZERO_HASH, id, main.id ?? '') };
    }
    if (split.id !== id) {
      return { error: response(CODE.buildInfoIdentityMismatch, ZERO_HASH, id, split.id ?? '') };
    }
    const output = split.output ?? split;
    const canonicalToUser = Object.fromEntries(
      Object.entries(main.userSourceNameMap ?? {}).map(([userSource, canonicalSource]) => [canonicalSource, userSource]),
    );
    const sourceName = artifact.sourceName;
    const inputSourceName = artifact.inputSourceName;
    if (
      typeof sourceName !== 'string' ||
      typeof inputSourceName !== 'string' ||
      artifact.ast?.absolutePath !== inputSourceName ||
      (canonicalToUser[inputSourceName] ?? inputSourceName) !== sourceName
    ) {
      return { error: response(CODE.buildInfoIdentityMismatch, ZERO_HASH, sourceName ?? '', inputSourceName ?? '') };
    }
    const inputSources = remapKeys(main.input?.sources, canonicalToUser);
    const outputContracts = remapKeys(output.contracts, canonicalToUser);
    const target = outputContracts[sourceName]?.[contractName];
    if (target === undefined) return { error: response(CODE.buildInfoNotFound, ZERO_HASH, fullyQualifiedName) };
    return {
      buildInfoFile: mainPath,
      inputSources,
      target,
      sourceLookup: source => canonicalToUser[source] ?? source,
      solcVersion: main.solcVersion,
      solcLongVersion: typeof main.solcLongVersion === 'string' ? main.solcLongVersion : '',
      hardhat3: true,
    };
  }

  const artifactSourceName = artifact.ast.absolutePath;
  const candidates = findJsonFiles(directory)
    .filter(file => !file.endsWith('.output.json'))
    .map(file => ({ file, buildInfo: JSON.parse(fs.readFileSync(file, 'utf8')) }))
    .filter(({ buildInfo }) => buildInfo.output?.contracts?.[artifactSourceName]?.[contractName] !== undefined);
  if (candidates.length === 0) return { error: response(CODE.buildInfoNotFound, ZERO_HASH, fullyQualifiedName) };
  if (candidates.length !== 1) return { error: response(CODE.ambiguousBuildInfo, ZERO_HASH, fullyQualifiedName) };
  const { file, buildInfo } = candidates[0];
  return {
    buildInfoFile: file,
    inputSources: buildInfo.input?.sources ?? {},
    target: buildInfo.output.contracts[artifactSourceName][contractName],
    sourceLookup: source => source,
    solcVersion: buildInfo.solcVersion,
    solcLongVersion: buildInfo.solcLongVersion,
    hardhat3: false,
  };
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
  if (artifact._format === 'hh3-artifact-1' && artifact.sourceName !== contractPath) {
    return response(CODE.buildInfoIdentityMismatch, ZERO_HASH, contractPath, artifact.sourceName ?? '');
  }
  const loaded = loadBuildInfo(artifact, outputDirectory, contractName, fullyQualifiedName);
  if (loaded.error !== undefined) return loaded.error;
  const { buildInfoFile, inputSources, target, sourceLookup, solcVersion, solcLongVersion, hardhat3 } = loaded;
  const artifactCompilerVersion = artifact.metadata?.compiler?.version;
  if (typeof artifactCompilerVersion !== 'string' || typeof solcVersion !== 'string' || semanticVersion(artifactCompilerVersion) !== semanticVersion(solcVersion)) {
    return response(CODE.compilerVersionMismatch, ZERO_HASH, artifactCompilerVersion ?? '', solcVersion ?? '');
  }
  if (!hardhat3 && (typeof solcLongVersion !== 'string' || solcLongVersion.length === 0)) {
    return response(CODE.missingCompilerIdentity, ZERO_HASH, buildInfoFile);
  }
  if (solcLongVersion.includes('+') && artifactCompilerVersion !== solcLongVersion) {
    return response(CODE.compilerBuildMismatch, ZERO_HASH, artifactCompilerVersion, solcLongVersion);
  }

  let outputMetadata;
  try {
    outputMetadata = typeof target.metadata === 'string' ? JSON.parse(target.metadata) : target.metadata;
  } catch {
    return response(CODE.missingCompilerIdentity, ZERO_HASH, buildInfoFile);
  }
  const outputCompilerVersion = outputMetadata?.compiler?.version;
  if (typeof outputCompilerVersion !== 'string') {
    return response(CODE.missingCompilerIdentity, ZERO_HASH, buildInfoFile);
  }
  if (artifactCompilerVersion !== outputCompilerVersion) {
    return response(CODE.compilerBuildMismatch, ZERO_HASH, artifactCompilerVersion, outputCompilerVersion);
  }

  const artifactBytecode = normalizeBytecode(typeof artifact.bytecode === 'string' ? artifact.bytecode : artifact.bytecode?.object);
  const buildBytecode = normalizeBytecode(target?.evm?.bytecode?.object);
  if (artifactBytecode !== buildBytecode) return response(CODE.bytecodeMismatch, ZERO_HASH, fullyQualifiedName);

  const metadataSources = artifact.metadata?.sources;
  if (metadataSources === null || typeof metadataSources !== 'object') {
    return response(CODE.toolFailure, ZERO_HASH, 'Artifact metadata sources are missing');
  }
  const sourceNames = Object.keys(metadataSources).sort();
  const sourceHashes = [];
  for (const sourceName of sourceNames) {
    const content = inputSources[sourceLookup(sourceName)]?.content;
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
      outputCompilerVersion,
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

module.exports = { CODE, buildInfoDirectory, findJsonFiles, loadBuildInfo, main, normalizeBytecode, verify };
