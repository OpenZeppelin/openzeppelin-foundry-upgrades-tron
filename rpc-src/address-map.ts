import { toEvmAddress } from './address-codec.js';
import type { ArtifactIdentity } from './artifact-identities.js';
import { validateChainIdentity, type ChainState } from './store.js';

const ADDRESS_MAP_VERSION = 1;
const CONTRACT_METADATA_VERSION = 1;
const TRANSACTION_HASH_PATTERN = /^0x[0-9a-f]{64}$/i;
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;

// Address mappings, contract metadata, and caller-supplied identifiers this module validates are
// external, dynamically-shaped data with no canonical type in this codebase (mirrors the
// convention in rpc-src/receipts.ts). `any` is used deliberately throughout this module for that
// content, so this alias marks the deliberately untyped seam; values are validated at runtime
// before use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonAny = any;

/** One durable predicted-to-actual address mapping record, with its creation provenance. */
export interface AddressMapping {
  predicted: string;
  actual: string;
  creator: string;
  sender: string;
  sourceTransaction: string;
}

/** The durable predicted/actual address-mapping index for one chain. */
export interface AddressMapIndexes {
  version: number;
  byPredicted: Record<string, AddressMapping>;
  byActual: Record<string, string>;
}

/** One durable contract-metadata record, keyed by its predicted address. */
export interface ContractMetadataRecord {
  predicted: string;
  contractKind: string;
  artifactIdentity: ArtifactIdentity;
  sourceTransaction: string;
}

/** The durable contract-metadata index for one chain. */
export interface ContractMetadataIndex {
  version: number;
  byPredicted: Record<string, ContractMetadataRecord>;
}

/** The subset of a durable store's API used by {@link AddressMap}. */
export interface AddressMapStore {
  transaction<T>(chainIdentity: string, callback: (chain: ChainState) => T): T;
  readChain(chainIdentity: string): ChainState | undefined;
}

function isObject(value: unknown): value is Record<string, JsonAny> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNonzeroAddress(address: JsonAny, field: string): string {
  let normalized: string;
  try {
    normalized = toEvmAddress(address);
  } catch (error) {
    throw new Error(`Invalid ${field} address`, { cause: error });
  }
  if (normalized === ZERO_ADDRESS) {
    throw new Error(`Invalid ${field} address`);
  }
  return normalized;
}

function normalizeSourceTransaction(sourceTransaction: JsonAny): string {
  if (typeof sourceTransaction !== 'string' || !TRANSACTION_HASH_PATTERN.test(sourceTransaction)) {
    throw new Error('Invalid source transaction hash');
  }
  return sourceTransaction.toLowerCase();
}

function normalizeMapping(mapping: JsonAny): AddressMapping {
  if (!isObject(mapping)) {
    throw new Error('Invalid address mapping');
  }
  return {
    predicted: normalizeNonzeroAddress(mapping.predicted, 'predicted'),
    actual: normalizeNonzeroAddress(mapping.actual, 'actual'),
    creator: normalizeNonzeroAddress(mapping.creator, 'creator'),
    sender: normalizeNonzeroAddress(mapping.sender, 'sender'),
    sourceTransaction: normalizeSourceTransaction(mapping.sourceTransaction),
  };
}

function emptyIndexes(): AddressMapIndexes {
  return { version: ADDRESS_MAP_VERSION, byPredicted: {}, byActual: {} };
}

function requireIndexes(chain: ChainState): AddressMapIndexes {
  const indexes = chain.addressMappings;
  if (indexes === undefined) {
    return emptyIndexes();
  }
  if (
    !isObject(indexes) ||
    indexes.version !== ADDRESS_MAP_VERSION ||
    !isObject(indexes.byPredicted) ||
    !isObject(indexes.byActual)
  ) {
    throw new Error('Corrupt address mapping indexes');
  }

  const actualAddresses = new Set<string>();
  for (const [predicted, rawRecord] of Object.entries(indexes.byPredicted)) {
    let record: AddressMapping;
    try {
      record = normalizeMapping(rawRecord);
    } catch (error) {
      throw new Error('Corrupt address mapping record', { cause: error });
    }
    const fields = Object.keys(rawRecord).sort();
    if (
      fields.join(',') !== 'actual,creator,predicted,sender,sourceTransaction' ||
      !sameMapping(rawRecord, record) ||
      record.predicted !== predicted ||
      actualAddresses.has(record.actual)
    ) {
      throw new Error('Corrupt address mapping indexes');
    }
    if (indexes.byActual[record.actual] !== predicted) {
      throw new Error('Corrupt address mapping reverse index');
    }
    actualAddresses.add(record.actual);
  }

  if (Object.keys(indexes.byActual).length !== actualAddresses.size) {
    throw new Error('Corrupt address mapping reverse index');
  }
  for (const [actual, predicted] of Object.entries(indexes.byActual)) {
    if (indexes.byPredicted[predicted]?.actual !== actual) {
      throw new Error('Corrupt address mapping reverse index');
    }
  }
  return indexes as unknown as AddressMapIndexes;
}

function sameMapping(left: JsonAny, right: AddressMapping): boolean {
  return (
    left.predicted === right.predicted &&
    left.actual === right.actual &&
    left.creator === right.creator &&
    left.sender === right.sender &&
    left.sourceTransaction === right.sourceTransaction
  );
}

function setMappingInChain(chain: ChainState, mapping: JsonAny): AddressMapping {
  const record = normalizeMapping(mapping);
  const indexes = requireIndexes(chain);
  const existingPredicted = indexes.byPredicted[record.predicted];
  const existingActual = indexes.byActual[record.actual];

  if (existingPredicted !== undefined) {
    if (existingPredicted.actual !== record.actual) throw new Error('Predicted address mapping conflict');
    if (!sameMapping(existingPredicted, record)) throw new Error('Address mapping provenance conflict');
    return existingPredicted;
  }
  if (existingActual !== undefined) throw new Error('Actual address mapping conflict');

  indexes.byPredicted[record.predicted] = record;
  indexes.byActual[record.actual] = record.predicted;
  chain.addressMappings = indexes;
  return record;
}

function normalizeArtifactIdentity(identity: JsonAny): ArtifactIdentity {
  if (
    !isObject(identity) ||
    Object.keys(identity).sort().join(',') !== 'contractName,fullyQualifiedName,sourceName' ||
    typeof identity.sourceName !== 'string' ||
    identity.sourceName.length === 0 ||
    typeof identity.contractName !== 'string' ||
    identity.contractName.length === 0 ||
    identity.fullyQualifiedName !== `${identity.sourceName}:${identity.contractName}`
  ) {
    throw new Error('Invalid contract artifact identity');
  }
  return structuredClone(identity) as ArtifactIdentity;
}

function normalizeContractMetadata(metadata: JsonAny): ContractMetadataRecord {
  if (
    !isObject(metadata) ||
    Object.keys(metadata).sort().join(',') !== 'artifactIdentity,contractKind,predicted,sourceTransaction' ||
    typeof metadata.contractKind !== 'string' ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(metadata.contractKind)
  ) {
    throw new Error('Invalid contract metadata');
  }
  return {
    predicted: normalizeNonzeroAddress(metadata.predicted, 'predicted'),
    contractKind: metadata.contractKind,
    artifactIdentity: normalizeArtifactIdentity(metadata.artifactIdentity),
    sourceTransaction: normalizeSourceTransaction(metadata.sourceTransaction),
  };
}

function emptyContractMetadata(): ContractMetadataIndex {
  return { version: CONTRACT_METADATA_VERSION, byPredicted: {} };
}

function requireContractMetadata(chain: ChainState): ContractMetadataIndex {
  const metadata = chain.contractMetadata;
  if (metadata === undefined) return emptyContractMetadata();
  if (
    !isObject(metadata) ||
    Object.keys(metadata).sort().join(',') !== 'byPredicted,version' ||
    metadata.version !== CONTRACT_METADATA_VERSION ||
    !isObject(metadata.byPredicted)
  ) {
    throw new Error('Corrupt contract metadata index');
  }
  const indexes = requireIndexes(chain);
  for (const [predicted, rawRecord] of Object.entries(metadata.byPredicted)) {
    let record: ContractMetadataRecord;
    try {
      record = normalizeContractMetadata(rawRecord);
    } catch (error) {
      throw new Error('Corrupt contract metadata record', { cause: error });
    }
    if (
      predicted !== record.predicted ||
      JSON.stringify(rawRecord) !== JSON.stringify(record) ||
      indexes.byPredicted[predicted] === undefined
    ) {
      throw new Error('Corrupt contract metadata index');
    }
  }
  return metadata as unknown as ContractMetadataIndex;
}

function setContractMetadataInChain(chain: ChainState, value: JsonAny): ContractMetadataRecord {
  const record = normalizeContractMetadata(value);
  const indexes = requireIndexes(chain);
  if (indexes.byPredicted[record.predicted] === undefined) {
    throw new Error('Contract metadata requires an address mapping');
  }
  const metadata = requireContractMetadata(chain);
  const existing = metadata.byPredicted[record.predicted];
  if (existing !== undefined) {
    if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error('Contract metadata conflict');
    return existing;
  }
  metadata.byPredicted[record.predicted] = record;
  chain.contractMetadata = metadata;
  return record;
}

function resolveContractMetadataInChain(chain: ChainState, address: JsonAny): ContractMetadataRecord | undefined {
  const normalized = normalizeNonzeroAddress(address, 'contract metadata');
  const indexes = requireIndexes(chain);
  const metadata = requireContractMetadata(chain);
  const predicted = indexes.byPredicted[normalized] === undefined ? indexes.byActual[normalized] : normalized;
  if (predicted === undefined) return undefined;
  return metadata.byPredicted[predicted];
}

class AddressMap {
  declare store: AddressMapStore;
  declare chainIdentity: string;

  constructor(store: AddressMapStore, chainIdentity: unknown) {
    if (store === null || typeof store !== 'object' || typeof store.transaction !== 'function') {
      throw new Error('A durable store is required');
    }
    this.store = store;
    this.chainIdentity = validateChainIdentity(chainIdentity);
  }

  set(mapping: JsonAny): AddressMapping {
    return this.store.transaction(this.chainIdentity, chain => setMappingInChain(chain, mapping));
  }

  setContractMetadata(metadata: JsonAny): ContractMetadataRecord {
    return this.store.transaction(this.chainIdentity, chain => setContractMetadataInChain(chain, metadata));
  }

  resolvePredicted(predicted: JsonAny): AddressMapping | undefined {
    const normalized = normalizeNonzeroAddress(predicted, 'predicted');
    const chain = this.store.readChain(this.chainIdentity);
    if (chain === undefined) {
      return undefined;
    }
    return structuredClone(requireIndexes(chain).byPredicted[normalized]);
  }

  resolveActual(actual: JsonAny): AddressMapping | undefined {
    const normalized = normalizeNonzeroAddress(actual, 'actual');
    const chain = this.store.readChain(this.chainIdentity);
    if (chain === undefined) {
      return undefined;
    }
    const indexes = requireIndexes(chain);
    const predicted = indexes.byActual[normalized];
    return predicted === undefined ? undefined : structuredClone(indexes.byPredicted[predicted]);
  }

  toActual(predicted: JsonAny): string | undefined {
    return this.resolvePredicted(predicted)?.actual;
  }

  toPredicted(actual: JsonAny): string | undefined {
    return this.resolveActual(actual)?.predicted;
  }

  list(): AddressMapping[] {
    const chain = this.store.readChain(this.chainIdentity);
    if (chain === undefined) {
      return [];
    }
    return Object.values(requireIndexes(chain).byPredicted)
      .map(record => structuredClone(record))
      .sort((left, right) => left.predicted.localeCompare(right.predicted));
  }

  resolveContractMetadata(address: JsonAny): ContractMetadataRecord | undefined {
    const normalized = normalizeNonzeroAddress(address, 'contract metadata');
    const chain = this.store.readChain(this.chainIdentity);
    if (chain === undefined) return undefined;
    const record = resolveContractMetadataInChain(chain, normalized);
    return record === undefined ? undefined : structuredClone(record);
  }
}

export {
  ADDRESS_MAP_VERSION,
  CONTRACT_METADATA_VERSION,
  AddressMap,
  requireIndexes,
  resolveContractMetadataInChain,
  setContractMetadataInChain,
  setMappingInChain,
};
