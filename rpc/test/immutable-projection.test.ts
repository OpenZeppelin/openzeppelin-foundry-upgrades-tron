import assert from 'node:assert/strict';
import test from 'node:test';

import { keccak256, toUtf8Bytes } from 'ethers';

import {
  buildDescriptorsFromRanges,
  buildImmutableDescriptors,
  codeMatchesRuntimeTemplate,
  extractImmutableReferences,
  hasAddressWidthRange,
  immutableRangeLow20,
  immutableRanges,
  projectDescriptorImmutables,
  runtimeBytecodeTemplateHash,
} from '../../dist/rpc/immutable-projection.js';

// The projection helpers validate external, dynamically-shaped solc/runtime inputs at runtime, so the
// test fixtures are deliberately loosely shaped, matching rpc-src/immutable-projection.ts's handling.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonAny = any;

const OWN = `0x${'a2'.repeat(20)}`;
const OTHER = `0x${'a4'.repeat(20)}`;
const PREDICTED = `0x${'22'.repeat(20)}`;
const OTHER_PREDICTED = `0x${'d4'.repeat(20)}`;

// A 32-byte immutable word at byte offset 2 holding an address in its low 20 bytes.
function oneWord(embedded: string): string {
  return `0x6080${'00'.repeat(12)}${embedded.slice(2)}6000`;
}
function twoWords(first: string, second: string): string {
  return `0x6080${'00'.repeat(12)}${first.slice(2)}${'00'.repeat(12)}${second.slice(2)}6000`;
}
const ONE_REF = { '1': [{ start: 2, length: 32 }] };

test('immutableRanges and immutableRangeLow20 read solc offsets and the right-aligned address', () => {
  assert.deepEqual(immutableRanges(ONE_REF), [{ start: 2, length: 32 }]);
  assert.deepEqual(immutableRanges(undefined), []);
  assert.equal(immutableRangeLow20(oneWord(OTHER).slice(2), { start: 2, length: 32 }), 'a4'.repeat(20));
});

test('buildImmutableDescriptors binds a transparent proxy address immutable as admin', () => {
  assert.deepEqual(buildImmutableDescriptors('transparent-proxy', OWN, oneWord(OTHER), ONE_REF), [
    { role: 'admin', start: 2, length: 32, expectedActual: OTHER },
  ]);
});

test('buildImmutableDescriptors binds a beacon proxy address immutable as beacon', () => {
  assert.deepEqual(buildImmutableDescriptors('beacon-proxy', OWN, oneWord(OTHER), ONE_REF), [
    { role: 'beacon', start: 2, length: 32, expectedActual: OTHER },
  ]);
});

test('buildImmutableDescriptors binds a contract address immutable as self only when it equals its own actual', () => {
  // Equals own actual -> a `self` role immutable (a UUPS implementation's __self).
  assert.deepEqual(buildImmutableDescriptors('contract', OWN, oneWord(OWN), ONE_REF), [
    { role: 'self', start: 2, length: 32, expectedActual: OWN },
  ]);
  // A different (even mapped) address is not a role immutable and is deliberately skipped.
  assert.deepEqual(buildImmutableDescriptors('contract', OWN, oneWord(OTHER), ONE_REF), []);
});

test('buildImmutableDescriptors captures a self immutable at every offset it appears', () => {
  const refs = { '1': [{ start: 2, length: 32 }], '2': [{ start: 34, length: 32 }] };
  assert.deepEqual(buildImmutableDescriptors('contract', OWN, twoWords(OWN, OWN), refs), [
    { role: 'self', start: 2, length: 32, expectedActual: OWN },
    { role: 'self', start: 34, length: 32, expectedActual: OWN },
  ]);
});

test('buildImmutableDescriptors ignores sub-address-width immutables and empty references', () => {
  assert.deepEqual(buildImmutableDescriptors('contract', OWN, oneWord(OWN), undefined), []);
  // A 16-byte immutable holds non-address data and is never a role immutable.
  assert.deepEqual(buildImmutableDescriptors('transparent-proxy', OWN, oneWord(OTHER), { '1': [{ start: 2, length: 16 }] }), []);
});

test('buildImmutableDescriptors throws when a declared range runs past the runtime code', () => {
  assert.throws(() => buildImmutableDescriptors('transparent-proxy', OWN, '0x6080', ONE_REF), /out of range/i);
});

test('projectDescriptorImmutables verifies then rewrites a bound role immutable', () => {
  const descriptors = [{ role: 'admin', start: 2, length: 32, expectedActual: OTHER }] as JsonAny;
  const toPredicted = (actual: string) => (actual.toLowerCase() === OTHER ? OTHER_PREDICTED : undefined);
  assert.equal(projectDescriptorImmutables(oneWord(OTHER), descriptors, PREDICTED, toPredicted), oneWord(OTHER_PREDICTED));
});

test('projectDescriptorImmutables projects a self immutable to the deployment predicted address', () => {
  const descriptors = [{ role: 'self', start: 2, length: 32, expectedActual: OWN }] as JsonAny;
  const toPredicted = (actual: string) => (actual.toLowerCase() === OWN ? PREDICTED : undefined);
  assert.equal(projectDescriptorImmutables(oneWord(OWN), descriptors, PREDICTED, toPredicted), oneWord(PREDICTED));
});

test('projectDescriptorImmutables throws when the on-chain word drifts from its commitment', () => {
  const descriptors = [{ role: 'admin', start: 2, length: 32, expectedActual: OTHER }] as JsonAny;
  assert.throws(
    () => projectDescriptorImmutables(oneWord(OWN), descriptors, PREDICTED, () => OTHER_PREDICTED),
    /does not match/i,
  );
});

test('projectDescriptorImmutables throws when the committed actual is unmapped', () => {
  const descriptors = [{ role: 'admin', start: 2, length: 32, expectedActual: OTHER }] as JsonAny;
  assert.throws(
    () => projectDescriptorImmutables(oneWord(OTHER), descriptors, PREDICTED, () => undefined),
    /does not resolve/i,
  );
});

test('projectDescriptorImmutables throws when a self immutable does not resolve to its own predicted address', () => {
  const descriptors = [{ role: 'self', start: 2, length: 32, expectedActual: OWN }] as JsonAny;
  // OWN resolves to a predicted address that is NOT this deployment's own predicted address.
  assert.throws(
    () => projectDescriptorImmutables(oneWord(OWN), descriptors, PREDICTED, () => OTHER_PREDICTED),
    /own predicted address/i,
  );
});

// --- Edge cases: reference extraction, malformed maps, and the zero-immutable pass-through anchors ---

test('extractImmutableReferences returns the solc map only for an object deployedBytecode', () => {
  assert.deepEqual(extractImmutableReferences({ immutableReferences: ONE_REF }), ONE_REF);
  // No immutableReferences member -> undefined (an ordinary contract with no constructor immutables).
  assert.equal(extractImmutableReferences({ object: '0x6080' }), undefined);
  for (const value of [undefined, null, '0x6080', 42]) {
    assert.equal(extractImmutableReferences(value), undefined);
  }
});

test('immutableRanges treats an empty or member-less map as no immutables', () => {
  assert.deepEqual(immutableRanges(null), []);
  assert.deepEqual(immutableRanges({}), []);
  assert.deepEqual(immutableRanges({ '1': [] }), []);
});

test('immutableRanges flattens multiple AST-id groups and multiple entries in order', () => {
  const refs = { '1': [{ start: 2, length: 32 }], '2': [{ start: 34, length: 32 }, { start: 66, length: 16 }] };
  assert.deepEqual(immutableRanges(refs), [
    { start: 2, length: 32 },
    { start: 34, length: 32 },
    { start: 66, length: 16 },
  ]);
});

test('immutableRanges rejects every malformed reference shape', () => {
  for (const bad of [
    'not-an-object',
    { '1': 'not-an-array' },
    { '1': [{ start: -1, length: 32 }] },
    { '1': [{ start: 2, length: 0 }] },
    { '1': [{ start: 2, length: -4 }] },
    { '1': [{ start: 1.5, length: 32 }] },
    { '1': [{ start: 2 }] }, // missing length
    { '1': [{ length: 32 }] }, // missing start
  ]) {
    assert.throws(() => immutableRanges(bad as JsonAny), /malformed/i, JSON.stringify(bad));
  }
});

test('buildDescriptorsFromRanges binds multiple address immutables of a transparent proxy as admin', () => {
  const ranges = [{ start: 2, length: 32 }, { start: 34, length: 32 }];
  assert.deepEqual(buildDescriptorsFromRanges('transparent-proxy', OWN, twoWords(OTHER, OWN), ranges), [
    { role: 'admin', start: 2, length: 32, expectedActual: OTHER },
    { role: 'admin', start: 34, length: 32, expectedActual: OWN },
  ]);
});

test('buildDescriptorsFromRanges rejects a non-canonical own actual address', () => {
  assert.throws(
    () => buildDescriptorsFromRanges('contract', 'not-an-address', oneWord(OWN), [{ start: 2, length: 32 }]),
    /canonical address/i,
  );
});

test('hasAddressWidthRange is true only when some range is at least 20 bytes wide', () => {
  assert.equal(hasAddressWidthRange([]), false);
  assert.equal(hasAddressWidthRange([{ start: 2, length: 16 }]), false);
  assert.equal(hasAddressWidthRange([{ start: 2, length: 20 }]), true);
  assert.equal(hasAddressWidthRange([{ start: 2, length: 16 }, { start: 4, length: 32 }]), true);
});

test('runtimeBytecodeTemplateHash hashes pure hex as bytes and a placeholder template as utf8', () => {
  const hex = '0x6080604052';
  assert.equal(runtimeBytecodeTemplateHash(hex, 'runtime bytecode'), keccak256(hex.toLowerCase()));
  // A `deployedBytecode` object form is read from `.object`.
  assert.equal(runtimeBytecodeTemplateHash({ object: hex }, 'runtime bytecode'), keccak256(hex.toLowerCase()));
  // An unlinked template carrying a library placeholder is not pure hex, so it is hashed over utf8.
  const linked = '0x6080__$abc$__604052';
  assert.equal(runtimeBytecodeTemplateHash(linked, 'runtime bytecode'), keccak256(toUtf8Bytes(linked.toLowerCase())));
});

test('runtimeBytecodeTemplateHash throws a typed INVALID_ARTIFACT error on an unavailable template', () => {
  for (const bad of [undefined, null, '', { object: '' }, { object: 42 }, 42]) {
    assert.throws(
      () => runtimeBytecodeTemplateHash(bad as JsonAny, 'runtime bytecode'),
      (error: JsonAny) => error.code === 'INVALID_ARTIFACT' && /unavailable/i.test(error.message),
      JSON.stringify(bad),
    );
  }
});

test('codeMatchesRuntimeTemplate holds only for a byte-exact match against a present hex hash', () => {
  const code = '0x6080604052';
  const source = { ranges: [], runtimeTemplateHash: keccak256(code) };
  assert.equal(codeMatchesRuntimeTemplate(code, source), true);
  // Case-insensitive on both sides.
  assert.equal(codeMatchesRuntimeTemplate(code.toUpperCase().replace('0X', '0x'), source), true);
  // Any byte difference fails.
  assert.equal(codeMatchesRuntimeTemplate('0x6080604000', source), false);
  // A missing hash (offset-less legacy snapshot) never passes the raw-code gate.
  assert.equal(codeMatchesRuntimeTemplate(code, { ranges: [] }), false);
  // Malformed code never passes.
  for (const bad of ['0xnothex', '0x123', 42, null, undefined]) {
    assert.equal(codeMatchesRuntimeTemplate(bad as JsonAny, source), false);
  }
  // A placeholder (utf8-hashed) template never equals the keccak of served hex code.
  const placeholder = '0x6080__$abc$__';
  assert.equal(
    codeMatchesRuntimeTemplate(code, { ranges: [], runtimeTemplateHash: runtimeBytecodeTemplateHash(placeholder, 'x') }),
    false,
  );
});

test('projectDescriptorImmutables rewrites only descriptor words and leaves surrounding bytes intact', () => {
  const descriptors = [
    { role: 'admin', start: 2, length: 32, expectedActual: OTHER },
    { role: 'self', start: 34, length: 32, expectedActual: OWN },
  ] as JsonAny;
  const toPredicted = (actual: string) =>
    actual.toLowerCase() === OTHER ? OTHER_PREDICTED : actual.toLowerCase() === OWN ? PREDICTED : undefined;
  // Two adjacent role words then a trailing opcode tail that must survive byte-for-byte.
  const code = `0x6080${'00'.repeat(12)}${OTHER.slice(2)}${'00'.repeat(12)}${OWN.slice(2)}6000`;
  const expected = `0x6080${'00'.repeat(12)}${OTHER_PREDICTED.slice(2)}${'00'.repeat(12)}${PREDICTED.slice(2)}6000`;
  assert.equal(projectDescriptorImmutables(code, descriptors, PREDICTED, toPredicted), expected);
});

test('projectDescriptorImmutables throws when a descriptor range runs past the runtime code', () => {
  const descriptors = [{ role: 'admin', start: 2, length: 32, expectedActual: OTHER }] as JsonAny;
  assert.throws(
    () => projectDescriptorImmutables('0x6080', descriptors, PREDICTED, () => OTHER_PREDICTED),
    /out of range/i,
  );
});
