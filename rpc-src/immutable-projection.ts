// Shared helpers for the solc `deployedBytecode.immutableReferences` map: the byte offsets of
// constructor-set immutable words in a contract's runtime code. Both adoption's runtime-code
// comparison (cli.ts) and eth_getCode's predicted-world projection (handlers.ts) read these offsets,
// so the extraction, validation, and address-slice logic live here to avoid divergent copies.

import { keccak256, toUtf8Bytes } from 'ethers';

// The solc immutableReferences map and the runtime bytecode this module reads are external,
// dynamically-shaped inputs validated at runtime; the alias marks that deliberately untyped seam.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonAny = any;

/** One constructor-set immutable's byte offset and width within a contract's runtime code. */
export interface ImmutableRange {
  start: number;
  length: number;
}

/** The upgrade-critical role an address-bearing immutable plays in a deployment's runtime code. */
export type ImmutableRole = 'self' | 'admin' | 'beacon';

/**
 * A semantic commitment binding one address-width immutable of a deployment's runtime code to the
 * role it plays and the actual on-chain address it was observed to hold at capture. `expectedActual`
 * is the authoritative value the runtime code must still present for the descriptor to project; a
 * later read that disagrees is treated as artifact/code drift. Stored per deployment so eth_getCode
 * rewrites only these role immutables into the predicted world, never a coincidental low-20 match.
 */
export interface ImmutableDescriptor {
  role: ImmutableRole;
  start: number;
  length: number;
  // A normalized actual address: `0x` followed by 40 lowercase hex characters.
  expectedActual: string;
}

const ADDRESS_HEX_PATTERN = /^0x[0-9a-f]{40}$/;

/**
 * An artifact-scoped immutable source resolved from an AUTHORITATIVE record: the byte ranges of the
 * artifact's constructor-set immutables (empty = the artifact genuinely declares none) and the
 * keccak256 of its deployed-bytecode template. The template hash is the integrity anchor for the
 * zero-immutable pass-through: artifact provenance binds creation bytecode and sources but NOT the
 * deployed bytecode's immutable-reference map, so an empty range list alone cannot prove served code
 * embeds no live role address — a zero-immutable deployment's on-chain code must equal its template
 * byte-for-byte, while a proxy whose references were stripped carries live addresses where the
 * template has zeros.
 */
export interface ImmutableSource {
  ranges: ImmutableRange[];
  runtimeTemplateHash?: string;
}

// Only a full 32-byte word can carry an address immutable; narrower immutables hold other data. An
// address occupies the low 20 bytes of its word, so any range at least 20 bytes wide is address-width.
function isAddressWidth(range: ImmutableRange): boolean {
  return range.length >= 20;
}

/**
 * Whether any of an artifact's immutable byte ranges is wide enough to carry an address. A range list
 * with no address-width entry has nothing to project: the runtime code embeds no address, so serving
 * it raw cannot contradict the reverse-mapped storage slots. Callers must pass an AUTHORITATIVE range
 * list (durable snapshot offsets or a provenance-verified artifact) — an unresolvable source is a
 * different state and must stay fail-closed for a proxy.
 */
export function hasAddressWidthRange(ranges: ImmutableRange[]): boolean {
  return ranges.some(isAddressWidth);
}

// The runtime bytecode template can carry unresolved external-library link placeholders
// (__$...$__), a shape artifact provenance permits. The fully linked runtime bytes are not known
// before broadcast, so the hash is taken over the raw template string (placeholders included) rather
// than requiring pure hex. Pure hex is hashed over its byte value, which for a contract with no
// immutables equals the keccak of its on-chain runtime code — the equality the zero-immutable
// pass-through verifies (see {@link ImmutableSource}).
export function runtimeBytecodeTemplateHash(value: JsonAny, label: string): string {
  const template = typeof value === 'string' ? value : value?.object;
  if (typeof template !== 'string' || template.length === 0) {
    const error: JsonAny = new Error(`Deployment artifact ${label} is unavailable`);
    error.code = 'INVALID_ARTIFACT';
    throw error;
  }
  const normalized = template.toLowerCase();
  return /^0x(?:[0-9a-fA-F]{2})*$/.test(normalized) ? keccak256(normalized) : keccak256(toUtf8Bytes(normalized));
}

/**
 * Whether served runtime code equals an immutable source's deployed-bytecode template byte-for-byte.
 * The gate for serving RAW code for a proxy kind: true only for a genuine zero-immutable deployment
 * (nothing constructor-set distinguishes its code from the template). False for a missing hash, a
 * placeholder-bearing (unlinked) template, malformed code, or any byte difference.
 */
export function codeMatchesRuntimeTemplate(code: JsonAny, source: ImmutableSource): boolean {
  if (typeof source.runtimeTemplateHash !== 'string') return false;
  if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(code)) return false;
  return keccak256(code.toLowerCase()) === source.runtimeTemplateHash.toLowerCase();
}

// The 0x-stripped, lowercased hex body of a runtime code string. Byte offsets in a solc
// immutableReferences map index this body (byte 0 is the first runtime code byte).
function runtimeCodeBody(runtimeCodeHex: JsonAny): string {
  if (typeof runtimeCodeHex !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(runtimeCodeHex)) {
    throw new Error('Runtime code is not canonical hex');
  }
  return runtimeCodeHex.slice(2).toLowerCase();
}

function embeddedAddress(body: string, range: ImmutableRange): string {
  const to = (range.start + range.length) * 2;
  if (to > body.length) throw new Error('Immutable reference is out of range');
  return `0x${body.slice(to - 40, to)}`;
}

// The verbatim solc `immutableReferences` object, keyed by AST id, or undefined when the artifact
// carries no deployed bytecode or no immutables. The value is returned as-is for the caller to store
// or validate; malformed content is rejected by {@link immutableRanges} at the point of use.
export function extractImmutableReferences(deployedBytecode: JsonAny): JsonAny {
  return typeof deployedBytecode === 'object' && deployedBytecode !== null
    ? deployedBytecode.immutableReferences
    : undefined;
}

// Flatten every { start, length } entry of every AST-id group of a solc immutableReferences map into
// a single byte-range list. An absent map yields an empty list, preserving byte-exact behavior for
// ordinary contracts; any malformed offset throws so a bad range never reaches masking or projection.
export function immutableRanges(references: JsonAny): ImmutableRange[] {
  if (references === undefined || references === null) return [];
  if (typeof references !== 'object') throw new Error('Verified artifact immutable references are malformed');
  const ranges: ImmutableRange[] = [];
  for (const group of Object.values(references)) {
    if (!Array.isArray(group)) throw new Error('Verified artifact immutable references are malformed');
    for (const entry of group) {
      const start = (entry as JsonAny)?.start;
      const length = (entry as JsonAny)?.length;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length <= 0) {
        throw new Error('Verified artifact immutable references are malformed');
      }
      ranges.push({ start, length });
    }
  }
  return ranges;
}

// The low 20 bytes of a 32-byte immutable word, taken from its byte range as Solidity right-aligns an
// address. Returned as a 40-character lowercase hex string with no 0x prefix.
export function immutableRangeLow20(codeHex: string, range: ImmutableRange): string {
  const region = codeHex.slice(range.start * 2, (range.start + range.length) * 2);
  return region.slice(-40).toLowerCase();
}

// Bind each address-width immutable of a deployment's ACTUAL runtime code to the upgrade-critical role
// it plays, reading the embedded actual address from the on-chain code (the artifact's deployedBytecode
// carries these words ZEROED and cannot supply the value). A transparent proxy's address immutable is
// its `_admin`, a beacon proxy's is its `_beacon`, and any other kind's address immutable is a role
// `self` only when it equals the deployment's own actual address (a UUPS implementation's `__self`,
// which may appear at several offsets); every other address immutable is not a role immutable and is
// deliberately omitted so eth_getCode never rewrites it. A canonical proxy carries exactly one such
// word. Returns an empty list when the artifact declares no address-width immutables.
export function buildImmutableDescriptors(
  kind: JsonAny,
  ownActual: JsonAny,
  runtimeCodeHex: JsonAny,
  references: JsonAny,
): ImmutableDescriptor[] {
  return buildDescriptorsFromRanges(kind, ownActual, runtimeCodeHex, immutableRanges(references));
}

// The pre-flattened-range core of {@link buildImmutableDescriptors}. Callers that already hold the
// artifact's byte ranges — durable snapshot `immutableReferences` on the eth_getCode enrichment path,
// where the solc reference map is unavailable — bind role immutables directly from those offsets. The
// role-selection and address-slice logic is identical to the solc-map overload: only the low-20 bytes
// of an address-width word are read, a `self` role is bound only when the embedded value equals the
// deployment's own actual, and every non-role address immutable is deliberately omitted.
export function buildDescriptorsFromRanges(
  kind: JsonAny,
  ownActual: JsonAny,
  runtimeCodeHex: JsonAny,
  ranges: ImmutableRange[],
): ImmutableDescriptor[] {
  const addressRanges = ranges.filter(isAddressWidth);
  if (addressRanges.length === 0) return [];
  const body = runtimeCodeBody(runtimeCodeHex);
  const own = typeof ownActual === 'string' ? ownActual.toLowerCase() : '';
  if (!ADDRESS_HEX_PATTERN.test(own)) throw new Error('Deployment actual address is not a canonical address');
  const descriptors: ImmutableDescriptor[] = [];
  for (const range of addressRanges) {
    const embedded = embeddedAddress(body, range);
    const base = { start: range.start, length: range.length };
    if (kind === 'transparent-proxy') {
      descriptors.push({ role: 'admin', ...base, expectedActual: embedded });
    } else if (kind === 'beacon-proxy') {
      descriptors.push({ role: 'beacon', ...base, expectedActual: embedded });
    } else if (embedded === own) {
      descriptors.push({ role: 'self', ...base, expectedActual: own });
    }
  }
  return descriptors;
}

// Verify-then-rewrite the descriptor-bound role immutables of a deployment's actual runtime code into
// the predicted world. For each descriptor the on-chain word must still equal its committed
// `expectedActual` (case-insensitive) — a mismatch is artifact/code drift and throws — and that actual
// must resolve through `toPredicted` to a mapped predicted address, which for a `self` descriptor must
// be the deployment's own predicted address. Any unresolved target throws. Non-descriptor immutables
// are never inspected or touched. Throwing (rather than a silent pass-through) lets the caller apply
// the proxy-vs-contract fail-closed policy: a descriptor is an authoritative commitment.
export function projectDescriptorImmutables(
  runtimeCodeHex: JsonAny,
  descriptors: ImmutableDescriptor[],
  predicted: JsonAny,
  toPredicted: (actual: string) => string | undefined,
): string {
  const chars = runtimeCodeBody(runtimeCodeHex).split('');
  const ownPredicted = typeof predicted === 'string' ? predicted.toLowerCase() : '';
  for (const descriptor of descriptors) {
    const to = (descriptor.start + descriptor.length) * 2;
    if (to > chars.length) throw new Error('Immutable reference is out of range');
    const low20Start = to - 40;
    const embedded = `0x${chars.slice(low20Start, to).join('')}`;
    if (embedded !== descriptor.expectedActual.toLowerCase()) {
      throw new Error('Runtime immutable value does not match its captured commitment');
    }
    const target = toPredicted(descriptor.expectedActual);
    if (target === undefined) throw new Error('Runtime immutable value does not resolve to a mapped predicted address');
    const targetHex = target.slice(2).toLowerCase();
    if (!ADDRESS_HEX_PATTERN.test(target.toLowerCase())) throw new Error('Mapped predicted address is malformed');
    if (descriptor.role === 'self' && targetHex !== ownPredicted.slice(2)) {
      throw new Error('Self immutable does not resolve to its own predicted address');
    }
    for (let i = 0; i < 40; i += 1) chars[low20Start + i] = targetHex[i];
  }
  return `0x${chars.join('')}`;
}
