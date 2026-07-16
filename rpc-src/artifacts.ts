import fs from 'node:fs';
import path from 'node:path';

import { AbiCoder, keccak256, toUtf8Bytes } from 'ethers';

// The Solidity FFI provenance helper is a load-bearing `.cjs` file at this exact
// runtime-relative path (see rpc/SECURITY.md). A static import would be
// relativized by `rootDir`/`outDir` and would also drag the `.cjs` file into
// the TS project graph, so it is loaded with a computed-path `require` typed
// by a hand-written interface below. `__dirname` at runtime is `dist/rpc`, so
// `../../src/internal/...` resolves to `<repo root>/src/internal/...`.

/** The well-known provenance-tool result/error codes shared with the Solidity FFI helper. */
interface ProvenanceCode {
  readonly success: number;
  readonly buildInfoNotFound: number;
  readonly ambiguousBuildInfo: number;
  readonly bytecodeMismatch: number;
  readonly compilerVersionMismatch: number;
  readonly missingCompilerIdentity: number;
  readonly missingSource: number;
  readonly sourceHashMismatch: number;
  readonly compilerBuildMismatch: number;
  readonly artifactOutsideOutput: number;
  readonly buildInfoIdentityMismatch: number;
  readonly invalidLinkReferences: number;
  readonly toolFailure: number;
}

/**
 * Link references as emitted by solc, e.g. `{ [sourceName]: { [libraryName]: [{ start, length }] } }`.
 * `start`/`length` are byte offsets into the bytecode (not hex-character offsets).
 */
type LinkReferences = Record<string, Record<string, Array<{ start: number; length: number }>>> | undefined;

// The parsed contents of a Foundry/Hardhat build artifact or a solc build-info file are
// external, dynamically-shaped JSON with no canonical type in this codebase (the shape also
// differs between legacy and Hardhat-3 `hh3-artifact-1` artifacts). `any` is used deliberately
// throughout this module for this content, matching its original untyped JS handling.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonAny = any;

interface LoadedBuildInfoError {
  error: string;
  buildInfoFile?: undefined;
}

interface LoadedBuildInfoSuccess {
  buildInfoFile: string;
  buildInfoFiles: string[];
  inputSources: Record<string, { content?: string } | undefined>;
  target: JsonAny;
  sourceLookup: (source: string) => string;
  solcVersion: string;
  solcLongVersion: string;
  hardhat3: boolean;
  error?: undefined;
}

type LoadedBuildInfo = LoadedBuildInfoError | LoadedBuildInfoSuccess;

interface ArtifactProvenanceHelper {
  CODE: ProvenanceCode;
  buildInfoDirectory(outputDirectory: string): string;
  findJsonFiles(directory: string): string[];
  loadBuildInfo(
    artifact: JsonAny,
    outputDirectory: string,
    contractName: string,
    fullyQualifiedName: string,
  ): LoadedBuildInfo;
  normalizeBytecode(value: unknown): string;
  validateLinkReferences(
    bytecode: string,
    artifactReferences: LinkReferences,
    buildReferences: LinkReferences,
  ): boolean | null;
  verify(args: string[]): string;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CODE, buildInfoDirectory, findJsonFiles, loadBuildInfo, normalizeBytecode, validateLinkReferences, verify } =
  require(path.join(__dirname, '..', '..', 'src', 'internal', 'artifact-provenance.cjs')) as ArtifactProvenanceHelper;

const RESULT_TYPES = ['uint8', 'bytes32', 'bytes32', 'bytes32', 'bool', 'string', 'string', 'bytes32', 'bytes32'];
const HEX_BYTES = /^(?:0x)?(?:[0-9a-fA-F]{2})*$/;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const CODE_NAMES: Record<number, string> = Object.freeze({
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

/** Lifecycle hooks used by the test suite to inject filesystem races between verification steps. */
export interface ProvenanceHooks {
  afterArtifactBoundaryCheck?: () => void;
  afterInitialVerification?: () => void;
  afterBuildInfoLoad?: () => void;
  afterCandidateMatch?: () => void;
}

/** Options accepted by {@link verifyArtifactProvenance}. */
export interface VerifyArtifactProvenanceOptions {
  outputDirectory: string;
  artifactPath: string;
  hooks?: ProvenanceHooks;
}

/** Options accepted by {@link matchDeploymentArtifact}. */
export interface MatchDeploymentArtifactOptions {
  outputDirectory: string;
  initcode: string;
  hooks?: ProvenanceHooks;
}

/** The compiler identity captured by a successful provenance verification. */
export interface VerifiedCompilerIdentity {
  artifactVersion: string;
  outputVersion: string;
  solcVersion: string;
  solcLongVersion: string;
}

/** The shape returned by a successful {@link verifyArtifactProvenance} call. */
export interface VerificationResult {
  artifact: JsonAny;
  artifactPath: string;
  sourceName: string;
  contractName: string;
  fullyQualifiedName: string;
  templateBytecode: string;
  requiresLinking: boolean;
  provenanceHash: string;
  creationBytecodeHash: string;
  artifactSnapshotHash: string;
  compiler: VerifiedCompilerIdentity;
}

/** The shape returned by a successful {@link matchDeploymentArtifact} call. */
export interface DeploymentMatchResult {
  artifact: JsonAny;
  abi: JsonAny;
  artifactPath: string;
  sourceName: string;
  contractName: string;
  fullyQualifiedName: string;
  creationBytecode: string;
  constructorData: string;
  requiresLinking: boolean;
  compiler: VerifiedCompilerIdentity;
  provenanceHash: string;
}

class ArtifactProvenanceError extends Error {
  declare code: string;
  declare details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ArtifactProvenanceError';
    this.code = code;
    this.details = details;
  }
}

function requireAbsoluteOutput(outputDirectory: unknown): string {
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

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

interface OutputIdentity {
  device: string;
  inode: string;
  mode: string;
  changed: string;
  realpath: string;
  directory: boolean;
  symlink: boolean;
}

function outputIdentity(outputDirectory: string): OutputIdentity {
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

function assertStableOutput(outputDirectory: string, expectedIdentity: OutputIdentity): void {
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

function assertNoSymlinkPath(root: string, target: string): void {
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

function assertNoSymlinksInTree(directory: string): void {
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

function requireArtifactWithinOutput(outputDirectory: string, artifactPath: unknown): string {
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

function artifactIdentity(
  artifact: JsonAny,
  artifactPath: string,
): { sourceName: string; contractName: string; fullyQualifiedName: string } {
  const sourceName = artifact._format === 'hh3-artifact-1' ? artifact.sourceName : artifact.ast?.absolutePath;
  const contractName =
    typeof artifact.contractName === 'string' ? artifact.contractName : path.basename(artifactPath, '.json');
  if (typeof sourceName !== 'string' || sourceName.length === 0 || contractName.length === 0) {
    throw new ArtifactProvenanceError('INVALID_ARTIFACT', `Artifact identity is missing: ${artifactPath}`);
  }
  return { sourceName, contractName, fullyQualifiedName: `${sourceName}:${contractName}` };
}

function readArtifact(artifactPath: string): { artifact: JsonAny; snapshot: string } {
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

function callHook(hooks: ProvenanceHooks | undefined, name: keyof ProvenanceHooks): void {
  const hook = hooks?.[name];
  if (hook !== undefined) {
    if (typeof hook !== 'function') {
      throw new ArtifactProvenanceError('INVALID_TEST_HOOK', `${name} must be a function`);
    }
    hook();
  }
}

function snapshotBuildInfo(loaded: LoadedBuildInfoSuccess, outputDirectory: string): string {
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

function artifactFiles(outputDirectory: string): string[] {
  const buildInfo = path.join(outputDirectory, 'build-info');
  return findJsonFiles(outputDirectory).filter(file => !isWithin(buildInfo, file) && !file.endsWith('.output.json'));
}

function sourceReferenceMatches(sourceName: string, referenceSource: string): boolean {
  const normalizedSource = sourceName.replaceAll('\\', '/');
  const normalizedReference = referenceSource.replaceAll('\\', '/');
  return (
    normalizedSource === normalizedReference ||
    normalizedSource.endsWith(`/${normalizedReference}`) ||
    (!normalizedReference.includes('/') &&
      path.posix.basename(normalizedSource) === path.posix.basename(normalizedReference))
  );
}

function findArtifactPaths(outputDirectoryArg: string, reference: string): string[] {
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

interface DecodedVerification {
  numericCode: number;
  provenanceHash: string;
  creationBytecodeHash: string;
  artifactSnapshotHash: string;
  requiresLinking: boolean;
  detailA: string;
  detailB: string;
  expected: string;
  actual: string;
}

function decodeVerification(encoded: string): DecodedVerification {
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

function throwVerificationError(result: DecodedVerification): never {
  const code = CODE_NAMES[result.numericCode] ?? 'UNKNOWN_PROVENANCE_ERROR';
  const details: Record<string, unknown> = {
    detailA: result.detailA,
    detailB: result.detailB,
    expected: result.expected,
    actual: result.actual,
  };
  if (code === 'MISSING_SOURCE' || code === 'SOURCE_HASH_MISMATCH') details.sourceName = result.detailA;
  throw new ArtifactProvenanceError(code, `Artifact provenance failed (${code}): ${result.detailA}`, details);
}

function verifyArtifactProvenance(options: VerifyArtifactProvenanceOptions): VerificationResult {
  return verifyArtifactProvenanceBound(options);
}

function verifyArtifactProvenanceBound(
  { outputDirectory: outputDirectoryArg, artifactPath: artifactPathArg, hooks }: VerifyArtifactProvenanceOptions,
  expectedOutputIdentity?: OutputIdentity,
): VerificationResult {
  const outputDirectory = requireAbsoluteOutput(outputDirectoryArg);
  const boundOutputIdentity = expectedOutputIdentity ?? outputIdentity(outputDirectory);
  assertStableOutput(outputDirectory, boundOutputIdentity);
  let artifactPath = requireArtifactWithinOutput(outputDirectory, artifactPathArg);
  callHook(hooks, 'afterArtifactBoundaryCheck');
  artifactPath = requireArtifactWithinOutput(outputDirectory, artifactPath);
  assertStableOutput(outputDirectory, boundOutputIdentity);
  const buildInfoRoot = path.normalize(buildInfoDirectory(outputDirectory));
  assertNoSymlinksInTree(buildInfoRoot);
  const initial = readArtifact(artifactPath);
  const identity = artifactIdentity(initial.artifact, artifactPath);
  const args = [outputDirectory, artifactPath, identity.sourceName, identity.contractName, identity.fullyQualifiedName];
  const firstEncoded = verify(args);
  const first = decodeVerification(firstEncoded);
  if (first.numericCode !== CODE.success) throwVerificationError(first);
  artifactPath = requireArtifactWithinOutput(outputDirectory, artifactPath);
  assertStableOutput(outputDirectory, boundOutputIdentity);
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
  assertStableOutput(outputDirectory, boundOutputIdentity);
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

function linkReferenceRanges(references: LinkReferences): Array<{ start: number; end: number }> {
  const ranges = [];
  for (const libraries of Object.values(references ?? {})) {
    for (const entries of Object.values(libraries ?? {})) {
      for (const entry of entries) ranges.push({ start: entry.start * 2, end: (entry.start + entry.length) * 2 });
    }
  }
  return ranges.sort((left, right) => left.start - right.start);
}

function matchBytecodePrefix(artifact: JsonAny, initcode: string): string | undefined {
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

function matchDeploymentArtifact({
  outputDirectory: outputDirectoryArg,
  initcode: initcodeArg,
  hooks,
}: MatchDeploymentArtifactOptions): DeploymentMatchResult {
  const outputDirectory = requireAbsoluteOutput(outputDirectoryArg);
  const expectedOutputIdentity = outputIdentity(outputDirectory);
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
  assertStableOutput(outputDirectory, expectedOutputIdentity);
  if (preliminary.length === 0) {
    throw new ArtifactProvenanceError('ARTIFACT_NOT_FOUND', 'No verified artifact matches the raw initcode prefix');
  }
  callHook(hooks, 'afterCandidateMatch');
  assertStableOutput(outputDirectory, expectedOutputIdentity);

  const matches = preliminary.map(candidate => ({
    ...verifyArtifactProvenanceBound(
      {
        outputDirectory,
        artifactPath: candidate.artifactPath,
        hooks,
      },
      expectedOutputIdentity,
    ),
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
  assertStableOutput(outputDirectory, expectedOutputIdentity);
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

export { ArtifactProvenanceError, findArtifactPaths, matchDeploymentArtifact, verifyArtifactProvenance };
