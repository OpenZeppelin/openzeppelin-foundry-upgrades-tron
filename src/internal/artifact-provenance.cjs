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
  invalidLinkReferences: 11,
  toolFailure: 255,
});

const ZERO_HASH = `0x${'00'.repeat(32)}`;
const resultTypes = ['uint8', 'bytes32', 'bytes32', 'bytes32', 'bool', 'string', 'string', 'bytes32', 'bytes32'];
const provenanceTypes = [
  'string',
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

function response(
  code,
  hash = ZERO_HASH,
  detailA = '',
  detailB = '',
  expected = ZERO_HASH,
  actual = ZERO_HASH,
  creationBytecodeHash = ZERO_HASH,
  requiresLinking = false,
  artifactSnapshotHash = ZERO_HASH,
) {
  return AbiCoder.defaultAbiCoder().encode(resultTypes, [
    code,
    hash,
    creationBytecodeHash,
    artifactSnapshotHash,
    requiresLinking,
    detailA,
    detailB,
    expected,
    actual,
  ]);
}

function flattenLinkReferences(value) {
  if (value === undefined) return [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid link references');
  const references = [];
  for (const source of Object.keys(value).sort()) {
    const libraries = value[source];
    if (libraries === null || typeof libraries !== 'object' || Array.isArray(libraries)) {
      throw new Error('invalid link references');
    }
    for (const library of Object.keys(libraries).sort()) {
      const entries = libraries[library];
      if (!Array.isArray(entries) || entries.length === 0) throw new Error('invalid link references');
      for (const entry of entries) {
        if (
          !Number.isSafeInteger(entry?.start) ||
          entry.start < 0 ||
          !Number.isSafeInteger(entry?.length) ||
          entry.length < 0
        ) {
          throw new Error('invalid link references');
        }
        references.push({ source, library, start: entry.start, length: entry.length });
      }
    }
  }
  return references.sort(
    (a, b) => a.start - b.start || a.source.localeCompare(b.source) || a.library.localeCompare(b.library),
  );
}

function validateLinkReferences(bytecode, artifactReferences, buildReferences) {
  let artifact;
  let build;
  try {
    artifact = flattenLinkReferences(artifactReferences);
    build = flattenLinkReferences(buildReferences);
  } catch {
    return null;
  }
  if (JSON.stringify(artifact) !== JSON.stringify(build)) return null;
  if (artifact.length === 0) return /^[0-9a-fA-F]*$/.test(bytecode) ? false : null;

  const normalized = bytecode.split('');
  let previousEnd = 0;
  for (const reference of artifact) {
    if (reference.start > Math.floor(Number.MAX_SAFE_INTEGER / 2)) return null;
    const start = reference.start * 2;
    const length = reference.length * 2;
    const end = start + length;
    if (reference.length !== 20 || start < previousEnd || end > bytecode.length) return null;
    const placeholder = bytecode.slice(start, end);
    const identity = keccak256(toUtf8Bytes(`${reference.source}:${reference.library}`)).slice(2, 36);
    if (placeholder !== `__$${identity}$__`) return null;
    normalized.fill('0', start, end);
    previousEnd = end;
  }
  return /^[0-9a-fA-F]*$/.test(normalized.join('')) ? true : null;
}

function normalizeBytecode(value) {
  if (typeof value !== 'string') throw new Error('Missing creation bytecode');
  return value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
}

// A canonical binding string for the deployed runtime template: the normalized bytecode object joined
// with a sorted, flattened list of its immutableReferences byte ranges. Both participate in the
// provenance hash so any tamper of the runtime object OR its immutable offset map changes provenance.
// Returns '' when the artifact declares no deployed bytecode object (an abstract contract/interface),
// keeping a fixture with no deployedBytecode unaffected. A non-string reference map or malformed group
// yields an explicit 'invalid' marker so it can never collide with a well-formed offset list.
function deployedBytecodeBinding(deployedBytecode) {
  const object = typeof deployedBytecode === 'string' ? deployedBytecode : deployedBytecode?.object;
  if (typeof object !== 'string') return '';
  const normalized = normalizeBytecode(object);
  const references =
    deployedBytecode !== null && typeof deployedBytecode === 'object' ? deployedBytecode.immutableReferences : undefined;
  if (references === undefined || references === null) return `${normalized}|`;
  if (typeof references !== 'object') return `${normalized}|invalid`;
  const pairs = [];
  for (const group of Object.values(references)) {
    if (!Array.isArray(group)) return `${normalized}|invalid`;
    for (const entry of group) {
      const start = entry?.start;
      const length = entry?.length;
      // Reject exactly what immutableRanges rejects, so a malformed entry (e.g. a string-typed offset
      // that formats to the same text as its integer form) can never share a binding with the
      // well-formed offset the range parser would accept.
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length <= 0) {
        return `${normalized}|invalid`;
      }
      pairs.push(`${start}:${length}`);
    }
  }
  pairs.sort();
  return `${normalized}|${pairs.join(',')}`;
}

function semanticVersion(version) {
  return version.split('+', 1)[0];
}

function isWindowsAbsolute(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

function isAbsolutePath(value) {
  return path.posix.isAbsolute(value) || isWindowsAbsolute(value);
}

function pathFlavor(value) {
  return isWindowsAbsolute(value) ? path.win32 : path.posix;
}

function resolvePath(value, root = process.cwd()) {
  if (isWindowsAbsolute(value)) return path.win32.normalize(value);
  if (path.posix.isAbsolute(value)) return path.posix.normalize(value);
  const flavor = pathFlavor(root);
  return flavor.resolve(root, value);
}

function buildInfoDirectory(outputDirectory) {
  const normalized = resolvePath(outputDirectory);
  const flavor = pathFlavor(normalized);
  const parent = flavor.dirname(normalized);
  return flavor.basename(normalized) === 'contracts' && flavor.basename(parent) === 'artifacts'
    ? flavor.join(parent, 'build-info')
    : flavor.join(normalized, 'build-info');
}

function findJsonFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  const flavor = pathFlavor(directory);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = flavor.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...findJsonFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(resolvePath(entryPath));
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
    const flavor = pathFlavor(directory);
    const mainPath = flavor.join(directory, `${id}.json`);
    const outputPath = flavor.join(directory, `${id}.output.json`);
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
      Object.entries(main.userSourceNameMap ?? {}).map(([userSource, canonicalSource]) => [
        canonicalSource,
        userSource,
      ]),
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
      buildInfoFiles: [mainPath, outputPath],
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
    buildInfoFiles: [file],
    inputSources: buildInfo.input?.sources ?? {},
    target: buildInfo.output.contracts[artifactSourceName][contractName],
    sourceLookup: source => source,
    solcVersion: buildInfo.solcVersion,
    solcLongVersion: buildInfo.solcLongVersion,
    hardhat3: false,
  };
}

function isWithin(parent, child) {
  const flavor = isWindowsAbsolute(parent) || isWindowsAbsolute(child) ? path.win32 : path.posix;
  const relative = flavor.relative(parent, child);
  return (
    relative === '' || (!relative.startsWith(`..${flavor.sep}`) && relative !== '..' && !flavor.isAbsolute(relative))
  );
}

function verify([outputDirectoryArg, artifactPathArg, contractPath, contractName, fullyQualifiedName]) {
  if (
    ![outputDirectoryArg, artifactPathArg, contractPath, contractName, fullyQualifiedName].every(
      value => typeof value === 'string',
    )
  ) {
    return response(CODE.toolFailure, ZERO_HASH, 'Expected output directory, artifact, source, contract, and FQN');
  }

  const outputDirectory = resolvePath(outputDirectoryArg);
  const artifactPath = resolvePath(artifactPathArg);
  if (!isWithin(outputDirectory, artifactPath)) {
    return response(CODE.artifactOutsideOutput, ZERO_HASH, artifactPath, outputDirectory);
  }

  const artifactSnapshot = fs.readFileSync(artifactPath, 'utf8');
  const artifactSnapshotHash = keccak256(toUtf8Bytes(artifactSnapshot));
  const artifact = JSON.parse(artifactSnapshot);
  if (artifact._format === 'hh3-artifact-1' && artifact.sourceName !== contractPath) {
    return response(CODE.buildInfoIdentityMismatch, ZERO_HASH, contractPath, artifact.sourceName ?? '');
  }
  const loaded = loadBuildInfo(artifact, outputDirectory, contractName, fullyQualifiedName);
  if (loaded.error !== undefined) return loaded.error;
  const { buildInfoFile, inputSources, target, sourceLookup, solcVersion, solcLongVersion, hardhat3 } = loaded;
  const artifactCompilerVersion = artifact.metadata?.compiler?.version;
  if (
    typeof artifactCompilerVersion !== 'string' ||
    typeof solcVersion !== 'string' ||
    semanticVersion(artifactCompilerVersion) !== semanticVersion(solcVersion)
  ) {
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

  const artifactBytecode = normalizeBytecode(
    typeof artifact.bytecode === 'string' ? artifact.bytecode : artifact.bytecode?.object,
  );
  const buildBytecode = normalizeBytecode(target?.evm?.bytecode?.object);
  if (artifactBytecode !== buildBytecode) return response(CODE.bytecodeMismatch, ZERO_HASH, fullyQualifiedName);
  const artifactLinkReferences =
    typeof artifact.bytecode === 'string' ? artifact.linkReferences : artifact.bytecode?.linkReferences;
  const requiresLinking = validateLinkReferences(
    artifactBytecode,
    artifactLinkReferences,
    target?.evm?.bytecode?.linkReferences,
  );
  if (requiresLinking === null) return response(CODE.invalidLinkReferences, ZERO_HASH, fullyQualifiedName);

  // The deployed runtime template is bound into provenance alongside creation bytecode. The immutable
  // projection derives its role descriptors and the zero-immutable raw-serve gate's template hash from
  // deployedBytecode, so provenance that bound only creation bytecode would let a swapped runtime
  // template (references stripped, live addresses embedded) re-verify unchanged. Both the runtime
  // bytecode object AND its immutableReferences offset map are bound: stripping the map alone
  // suppresses role/__self descriptor derivation without touching the object, so the map must
  // participate too. An artifact that declares no deployed bytecode (an abstract contract or interface)
  // binds the empty string, so a fixture with no deployedBytecode is unaffected.
  const artifactDeployedBytecode = deployedBytecodeBinding(artifact.deployedBytecode);

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
      artifactDeployedBytecode,
      sourceNames,
      sourceHashes,
    ]),
  );
  const creationBytecodeHash = keccak256(toUtf8Bytes(artifactBytecode));
  return response(
    CODE.success,
    hash,
    '',
    '',
    ZERO_HASH,
    ZERO_HASH,
    creationBytecodeHash,
    requiresLinking,
    artifactSnapshotHash,
  );
}

function main(args) {
  try {
    process.stdout.write(verify(args));
  } catch (error) {
    process.stdout.write(response(CODE.toolFailure, ZERO_HASH, error instanceof Error ? error.message : String(error)));
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  CODE,
  buildInfoDirectory,
  findJsonFiles,
  isAbsolutePath,
  loadBuildInfo,
  main,
  normalizeBytecode,
  resolvePath,
  validateLinkReferences,
  verify,
};
