import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildImmutableDescriptors,
  immutableRangeLow20,
  immutableRanges,
  projectDescriptorImmutables,
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
