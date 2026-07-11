'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { AbiCoder, keccak256, toUtf8Bytes } = require('ethers');

const {
  CODE,
  buildInfoDirectory,
  findJsonFiles,
  loadBuildInfo,
  normalizeBytecode,
  validateLinkReferences,
  verify,
} = require('../src/internal/artifact-provenance.cjs');

const RESULT_TYPES = ['uint8', 'bytes32', 'bytes32', 'bytes32', 'bool', 'string', 'string', 'bytes32', 'bytes32'];
const HEX_BYTES = /^(?:0x)?(?:[0-9a-fA-F]{2})*$/;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const CODE_NAMES = Object.freeze({
  [CODE.buildInfoNotFound]: 'BUILD_INFO_NOT_FOUND',
  [CODE.ambiguousBuildInfo]: 'AMBIGUOUS_BUILD_INFO',
  [CODE.bytecodeMismatch]: 'BYTECODE_MISMATCH',
  [CODE.compilerVersionMismatch]: 'COMPILER_VERSION_MISMATCH',
  [CODE.missingCompilerIdentity]: 'MISSING_COMPILER_IDENTITY',
  [CODE.missingSource]: 'MISSING_SOURCE',
  [CODE.sourceHashMismatch]: 'SOURCE_HASH_MISMATCH',
  [CODE.compilerBuildMismatch]: 'COMPILER_BUILD_MISMATCH',
  [CODE.artifactOutsideOutput]: 'ARTIFACT_OUTSIDE_OUTPUT',
  [CODE.buildInfoIdentityMismatch]: 'BUILD_INFO_IDENTITY_MISMATCH',
  [CODE.invalidLinkReferences]: 'INVALID_LINK_REFERENCES',
  [CODE.toolFailure]: 'PROVENANCE_TOOL_FAILURE',
});

class ArtifactProvenanceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ArtifactProvenanceError';
    this.code = code;
    this.details = details;
  }
}

function requireAbsoluteOutput(outputDirectory) {
  if (typeof outputDirectory !== 'string' || !path.isAbsolute(outputDirectory)) {
    throw new ArtifactProvenanceError(
      'INVALID_OUTPUT_DIRECTORY',
      'FOUNDRY_OUT must be one deterministic absolute output directory',
    );
  }
  const normalized = path.normalize(outputDirectory);
  let root;
  try {
    root = fs.lstatSync(normalized);
  } catch {
    throw new ArtifactProvenanceError('INVALID_OUTPUT_DIRECTORY', `FOUNDRY_OUT does not exist: ${normalized}`);
  }
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new ArtifactProvenanceError(
      'INVALID_OUTPUT_DIRECTORY',
      `FOUNDRY_OUT must be a real directory, not a symlink: ${normalized}`,
    );
  }
  return normalized;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function outputIdentity(outputDirectory) {
  const stat = fs.lstatSync(outputDirectory, { bigint: true });
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    mode: stat.mode.toString(),
    changed: stat.ctimeNs.toString(),
    realpath: fs.realpathSync(outputDirectory),
    directory: stat.isDirectory(),
    symlink: stat.isSymbolicLink(),
  };
}

function assertStableOutput(outputDirectory, expectedIdentity) {
  let actual;
  try {
    actual = outputIdentity(outputDirectory);
  } catch (error) {
    throw new ArtifactProvenanceError('PROVENANCE_CHANGED', 'FOUNDRY_OUT disappeared during provenance verification', {
      cause: error,
    });
  }
  if (
    actual.symlink ||
    !actual.directory ||
    actual.device !== expectedIdentity.device ||
    actual.inode !== expectedIdentity.inode ||
    actual.mode !== expectedIdentity.mode ||
    actual.changed !== expectedIdentity.changed ||
    actual.realpath !== expectedIdentity.realpath
  ) {
    throw new ArtifactProvenanceError('PROVENANCE_CHANGED', 'FOUNDRY_OUT changed during provenance verification');
  }
}

function assertNoSymlinkPath(root, target) {
  if (!isWithin(root, target)) {
    throw new ArtifactProvenanceError('ARTIFACT_OUTSIDE_OUTPUT', 'Provenance path is outside its trusted tree', {
      target,
      root,
    });
  }
  const relative = path.relative(root, target);
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (fs.lstatSync(cursor).isSymbolicLink()) {
      throw new ArtifactProvenanceError('ARTIFACT_OUTSIDE_OUTPUT', 'Provenance paths cannot contain symlinks', {
        target,
        symlink: cursor,
      });
    }
  }
}

function assertNoSymlinksInTree(directory) {
  if (!fs.existsSync(directory)) return;
  if (fs.lstatSync(directory).isSymbolicLink()) {
    throw new ArtifactProvenanceError('ARTIFACT_OUTSIDE_OUTPUT', 'Build-info directory cannot be a symlink', {
      directory,
    });
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new ArtifactProvenanceError('ARTIFACT_OUTSIDE_OUTPUT', 'Build-info paths cannot contain symlinks', {
        path: entryPath,
      });
    }
    if (entry.isDirectory()) assertNoSymlinksInTree(entryPath);
  }
}

function requireArtifactWithinOutput(outputDirectory, artifactPath) {
  if (typeof artifactPath !== 'string') {
    throw new ArtifactProvenanceError('INVALID_ARTIFACT_PATH', 'Artifact path must be a string');
  }
  const normalized = path.normalize(path.isAbsolute(artifactPath) ? artifactPath : path.resolve(artifactPath));
  if (!isWithin(outputDirectory, normalized)) {
    throw new ArtifactProvenanceError('ARTIFACT_OUTSIDE_OUTPUT', 'Artifact is outside FOUNDRY_OUT', {
      artifactPath: normalized,
      outputDirectory,
    });
  }
  if (!fs.existsSync(normalized) || !fs.statSync(normalized).isFile()) {
    throw new ArtifactProvenanceError('ARTIFACT_NOT_FOUND', `Artifact does not exist: ${normalized}`);
  }
  assertNoSymlinkPath(outputDirectory, normalized);
  const realOutput = fs.realpathSync(outputDirectory);
  const realArtifact = fs.realpathSync(normalized);
  if (!isWithin(realOutput, realArtifact)) {
    throw new ArtifactProvenanceError('ARTIFACT_OUTSIDE_OUTPUT', 'Artifact symlink escapes FOUNDRY_OUT', {
      artifactPath: normalized,
      outputDirectory,
    });
  }
  return normalized;
}

function artifactIdentity(artifact, artifactPath) {
  const sourceName = artifact._format === 'hh3-artifact-1' ? artifact.sourceName : artifact.ast?.absolutePath;
  const contractName =
    typeof artifact.contractName === 'string' ? artifact.contractName : path.basename(artifactPath, '.json');
  if (typeof sourceName !== 'string' || sourceName.length === 0 || contractName.length === 0) {
    throw new ArtifactProvenanceError('INVALID_ARTIFACT', `Artifact identity is missing: ${artifactPath}`);
  }
  return { sourceName, contractName, fullyQualifiedName: `${sourceName}:${contractName}` };
}

function readArtifact(artifactPath) {
  let snapshot;
  let artifact;
  try {
    const descriptor = fs.openSync(artifactPath, fs.constants.O_RDONLY | NO_FOLLOW);
    try {
      if (!fs.fstatSync(descriptor).isFile()) throw new Error('Artifact is not a regular file');
      snapshot = fs.readFileSync(descriptor, 'utf8');
    } finally {
      fs.closeSync(descriptor);
    }
    artifact = JSON.parse(snapshot);
  } catch (error) {
    throw new ArtifactProvenanceError('INVALID_ARTIFACT', `Cannot read artifact: ${artifactPath}`, { cause: error });
  }
  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new ArtifactProvenanceError('INVALID_ARTIFACT', `Artifact must contain a JSON object: ${artifactPath}`);
  }
  return { artifact, snapshot };
}

function callHook(hooks, name) {
  const hook = hooks?.[name];
  if (hook !== undefined) {
    if (typeof hook !== 'function') {
      throw new ArtifactProvenanceError('INVALID_TEST_HOOK', `${name} must be a function`);
    }
    hook();
  }
}

function snapshotBuildInfo(loaded, outputDirectory) {
  const directory = path.normalize(buildInfoDirectory(outputDirectory));
  const files = (loaded.buildInfoFiles ?? [loaded.buildInfoFile]).map(file => path.normalize(file));
  const snapshots = [];
  for (const file of files) {
    assertNoSymlinkPath(directory, file);
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
    try {
      if (!fs.fstatSync(descriptor).isFile()) throw new Error('Build-info is not a regular file');
      snapshots.push(fs.readFileSync(descriptor, 'utf8'));
    } finally {
      fs.closeSync(descriptor);
    }
  }
  return JSON.stringify({
    files,
    snapshots,
    buildInfoFile: loaded.buildInfoFile,
    solcVersion: loaded.solcVersion,
    solcLongVersion: loaded.solcLongVersion,
    hardhat3: loaded.hardhat3,
    target: loaded.target,
  });
}

function artifactFiles(outputDirectory) {
  const buildInfo = path.join(outputDirectory, 'build-info');
  return findJsonFiles(outputDirectory).filter(file => !isWithin(buildInfo, file) && !file.endsWith('.output.json'));
}

function sourceReferenceMatches(sourceName, referenceSource) {
  const normalizedSource = sourceName.replaceAll('\\', '/');
  const normalizedReference = referenceSource.replaceAll('\\', '/');
  return (
    normalizedSource === normalizedReference ||
    normalizedSource.endsWith(`/${normalizedReference}`) ||
    (!normalizedReference.includes('/') &&
      path.posix.basename(normalizedSource) === path.posix.basename(normalizedReference))
  );
}

function findArtifactPaths(outputDirectoryArg, reference) {
  const outputDirectory = requireAbsoluteOutput(outputDirectoryArg);
  if (typeof reference !== 'string' || reference.length === 0) {
    throw new ArtifactProvenanceError('INVALID_ARTIFACT_REFERENCE', 'Artifact reference must be a nonempty string');
  }

  if (reference.endsWith('.json')) {
    const explicitPath = path.isAbsolute(reference) ? reference : path.join(outputDirectory, reference);
    return [requireArtifactWithinOutput(outputDirectory, explicitPath)];
  }

  const separator = reference.lastIndexOf(':');
  const referenceSource = separator === -1 ? undefined : reference.slice(0, separator);
  const referenceContract = separator === -1 ? reference : reference.slice(separator + 1);
  const matches = [];
  for (const artifactPath of artifactFiles(outputDirectory)) {
    try {
      const { artifact } = readArtifact(artifactPath);
      const identity = artifactIdentity(artifact, artifactPath);
      if (
        identity.contractName === referenceContract &&
        (referenceSource === undefined || sourceReferenceMatches(identity.sourceName, referenceSource))
      ) {
        matches.push(artifactPath);
      }
    } catch {
      // Build-info and unrelated JSON files are not artifact candidates.
    }
  }
  return matches.sort();
}

function decodeVerification(encoded) {
  const [
    numericCode,
    provenanceHash,
    creationBytecodeHash,
    artifactSnapshotHash,
    requiresLinking,
    detailA,
    detailB,
    expected,
    actual,
  ] = AbiCoder.defaultAbiCoder().decode(RESULT_TYPES, encoded);
  return {
    numericCode: Number(numericCode),
    provenanceHash,
    creationBytecodeHash,
    artifactSnapshotHash,
    requiresLinking,
    detailA,
    detailB,
    expected,
    actual,
  };
}

function throwVerificationError(result) {
  const code = CODE_NAMES[result.numericCode] ?? 'UNKNOWN_PROVENANCE_ERROR';
  const details = {
    detailA: result.detailA,
    detailB: result.detailB,
    expected: result.expected,
    actual: result.actual,
  };
  if (code === 'MISSING_SOURCE' || code === 'SOURCE_HASH_MISMATCH') details.sourceName = result.detailA;
  throw new ArtifactProvenanceError(code, `Artifact provenance failed (${code}): ${result.detailA}`, details);
}

function verifyArtifactProvenance({ outputDirectory: outputDirectoryArg, artifactPath: artifactPathArg, hooks }) {
  const outputDirectory = requireAbsoluteOutput(outputDirectoryArg);
  const expectedOutputIdentity = outputIdentity(outputDirectory);
  let artifactPath = requireArtifactWithinOutput(outputDirectory, artifactPathArg);
  callHook(hooks, 'afterArtifactBoundaryCheck');
  artifactPath = requireArtifactWithinOutput(outputDirectory, artifactPath);
  assertStableOutput(outputDirectory, expectedOutputIdentity);
  const buildInfoRoot = path.normalize(buildInfoDirectory(outputDirectory));
  assertNoSymlinksInTree(buildInfoRoot);
  const initial = readArtifact(artifactPath);
  const identity = artifactIdentity(initial.artifact, artifactPath);
  const args = [outputDirectory, artifactPath, identity.sourceName, identity.contractName, identity.fullyQualifiedName];
  const firstEncoded = verify(args);
  const first = decodeVerification(firstEncoded);
  if (first.numericCode !== CODE.success) throwVerificationError(first);
  artifactPath = requireArtifactWithinOutput(outputDirectory, artifactPath);
  assertStableOutput(outputDirectory, expectedOutputIdentity);
  if (keccak256(toUtf8Bytes(initial.snapshot)) !== first.artifactSnapshotHash) {
    throw new ArtifactProvenanceError('PROVENANCE_CHANGED', 'Artifact changed during provenance verification');
  }

  callHook(hooks, 'afterInitialVerification');
  assertNoSymlinksInTree(buildInfoRoot);
  const loaded = loadBuildInfo(initial.artifact, outputDirectory, identity.contractName, identity.fullyQualifiedName);
  if (loaded.error !== undefined) throwVerificationError(decodeVerification(loaded.error));
  const loadedSnapshot = snapshotBuildInfo(loaded, outputDirectory);
  callHook(hooks, 'afterBuildInfoLoad');
  assertNoSymlinksInTree(buildInfoRoot);
  const secondEncoded = verify(args);
  const finalLoaded = loadBuildInfo(
    initial.artifact,
    outputDirectory,
    identity.contractName,
    identity.fullyQualifiedName,
  );
  if (finalLoaded.error !== undefined) throwVerificationError(decodeVerification(finalLoaded.error));
  const finalLoadedSnapshot = snapshotBuildInfo(finalLoaded, outputDirectory);
  artifactPath = requireArtifactWithinOutput(outputDirectory, artifactPath);
  assertStableOutput(outputDirectory, expectedOutputIdentity);
  if (
    secondEncoded !== firstEncoded ||
    readArtifact(artifactPath).snapshot !== initial.snapshot ||
    finalLoadedSnapshot !== loadedSnapshot
  ) {
    throw new ArtifactProvenanceError('PROVENANCE_CHANGED', 'Artifact or build-info changed during verification');
  }

  const templateBytecode = normalizeBytecode(
    typeof initial.artifact.bytecode === 'string' ? initial.artifact.bytecode : initial.artifact.bytecode?.object,
  );
  const outputMetadata =
    typeof finalLoaded.target.metadata === 'string'
      ? JSON.parse(finalLoaded.target.metadata)
      : finalLoaded.target.metadata;
  return {
    artifact: initial.artifact,
    artifactPath,
    sourceName: identity.sourceName,
    contractName: identity.contractName,
    fullyQualifiedName: identity.fullyQualifiedName,
    templateBytecode,
    requiresLinking: first.requiresLinking,
    provenanceHash: first.provenanceHash,
    creationBytecodeHash: first.creationBytecodeHash,
    artifactSnapshotHash: first.artifactSnapshotHash,
    compiler: {
      artifactVersion: initial.artifact.metadata.compiler.version,
      outputVersion: outputMetadata.compiler.version,
      solcVersion: finalLoaded.solcVersion,
      solcLongVersion: finalLoaded.solcLongVersion,
    },
  };
}

function linkReferenceRanges(references) {
  const ranges = [];
  for (const libraries of Object.values(references ?? {})) {
    for (const entries of Object.values(libraries ?? {})) {
      for (const entry of entries) ranges.push({ start: entry.start * 2, end: (entry.start + entry.length) * 2 });
    }
  }
  return ranges.sort((left, right) => left.start - right.start);
}

function matchBytecodePrefix(artifact, initcode) {
  let template;
  try {
    template = normalizeBytecode(typeof artifact.bytecode === 'string' ? artifact.bytecode : artifact.bytecode?.object);
  } catch {
    return undefined;
  }
  if (template.length === 0 || initcode.length < template.length) return undefined;
  const references =
    typeof artifact.bytecode === 'string' ? artifact.linkReferences : artifact.bytecode?.linkReferences;
  const linking = validateLinkReferences(template, references, references);
  if (linking === null) return undefined;
  const prefix = initcode.slice(0, template.length);
  if (!linking) return prefix.toLowerCase() === template.toLowerCase() ? prefix : undefined;

  let cursor = 0;
  for (const range of linkReferenceRanges(references)) {
    if (prefix.slice(cursor, range.start).toLowerCase() !== template.slice(cursor, range.start).toLowerCase()) {
      return undefined;
    }
    if (!/^[0-9a-fA-F]{40}$/.test(prefix.slice(range.start, range.end))) return undefined;
    cursor = range.end;
  }
  return prefix.slice(cursor).toLowerCase() === template.slice(cursor).toLowerCase() ? prefix : undefined;
}

function matchDeploymentArtifact({ outputDirectory: outputDirectoryArg, initcode: initcodeArg, hooks }) {
  const outputDirectory = requireAbsoluteOutput(outputDirectoryArg);
  if (typeof initcodeArg !== 'string' || !HEX_BYTES.test(initcodeArg)) {
    throw new ArtifactProvenanceError('INVALID_INITCODE', 'Raw initcode must be even-length hexadecimal bytes');
  }
  const initcode = initcodeArg.replace(/^0x/i, '');
  const preliminary = [];
  for (const artifactPath of artifactFiles(outputDirectory)) {
    try {
      const { artifact } = readArtifact(artifactPath);
      if (!Array.isArray(artifact.abi)) continue;
      const prefix = matchBytecodePrefix(artifact, initcode);
      if (prefix !== undefined) preliminary.push({ artifactPath, prefix });
    } catch {
      // Invalid, unrelated JSON cannot be selected as a deployment artifact.
    }
  }
  if (preliminary.length === 0) {
    throw new ArtifactProvenanceError('ARTIFACT_NOT_FOUND', 'No verified artifact matches the raw initcode prefix');
  }
  callHook(hooks, 'afterCandidateMatch');

  const matches = preliminary.map(candidate => ({
    ...verifyArtifactProvenance({ outputDirectory, artifactPath: candidate.artifactPath, hooks }),
  }));
  if (matches.length !== 1) {
    throw new ArtifactProvenanceError(
      'AMBIGUOUS_ARTIFACT',
      `Ambiguous deployment initcode matches ${matches.length} artifacts`,
      { artifactPaths: matches.map(match => match.artifactPath).sort() },
    );
  }

  const [match] = matches;
  const prefix = matchBytecodePrefix(match.artifact, initcode);
  if (prefix === undefined) {
    throw new ArtifactProvenanceError(
      'ARTIFACT_NOT_FOUND',
      'The provenance-verified artifact no longer matches the raw initcode prefix',
    );
  }
  return {
    artifact: match.artifact,
    abi: structuredClone(match.artifact.abi),
    artifactPath: match.artifactPath,
    sourceName: match.sourceName,
    contractName: match.contractName,
    fullyQualifiedName: match.fullyQualifiedName,
    creationBytecode: `0x${prefix.toLowerCase()}`,
    constructorData: `0x${initcode.slice(prefix.length).toLowerCase()}`,
    requiresLinking: match.requiresLinking,
    compiler: match.compiler,
    provenanceHash: match.provenanceHash,
  };
}

module.exports = {
  ArtifactProvenanceError,
  findArtifactPaths,
  matchDeploymentArtifact,
  verifyArtifactProvenance,
};
