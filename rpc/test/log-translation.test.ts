import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mapAddressField,
  mapFilterParams,
  mapLogData,
  mapLogEntry,
  mapLogWord,
  mapTopics,
} from '../../dist/rpc/log-translation.js';

const ACTUAL = `0x${'22'.repeat(20)}`;
const PREDICTED = `0x${'33'.repeat(20)}`;
const OTHER_ACTUAL = `0x${'44'.repeat(20)}`;
const OTHER_PREDICTED = `0x${'55'.repeat(20)}`;

// actual -> predicted, identity when unmapped (the outbound reverse-map used on results/receipts).
function reverse(address: string): string {
  const low = address.replace(/^0x/i, '').toLowerCase();
  if (low === '22'.repeat(20)) return PREDICTED;
  if (low === '44'.repeat(20)) return OTHER_PREDICTED;
  return address;
}

// predicted -> actual, identity when unmapped (the inbound forward-map used on the filter).
function forward(address: string): string {
  const low = address.replace(/^0x/i, '').toLowerCase();
  if (low === '33'.repeat(20)) return ACTUAL;
  return address;
}

function word(body: string): string {
  return `0x${body}`;
}
function leftPadded(address: string): string {
  return `0x${'0'.repeat(24)}${address.replace(/^0x/i, '').toLowerCase()}`;
}

test('mapAddressField reverse-maps a mapped address and leaves unmapped/zero addresses untouched', () => {
  assert.equal(mapAddressField(ACTUAL, reverse), PREDICTED);
  assert.equal(mapAddressField(`0x${'99'.repeat(20)}`, reverse), `0x${'99'.repeat(20)}`);
  assert.equal(mapAddressField(`0x${'00'.repeat(20)}`, reverse), `0x${'00'.repeat(20)}`);
});

test('mapLogWord rewrites a left-padded mapped address word to the predicted address', () => {
  assert.equal(mapLogWord(leftPadded(ACTUAL), reverse), leftPadded(PREDICTED));
});

test('mapLogWord leaves an unmapped address word, the zero word, and non-address words untouched', () => {
  const unmapped = leftPadded(`0x${'99'.repeat(20)}`);
  assert.equal(mapLogWord(unmapped, reverse), unmapped);

  const zero = word('0'.repeat(64));
  assert.equal(mapLogWord(zero, reverse), zero);

  // High 12 bytes are non-zero -> not an address (e.g. a hash or a large uint256). Even though its
  // low 20 bytes equal a mapped actual address, it must NOT be rewritten.
  const hashLike = word('ff'.repeat(12) + '22'.repeat(20));
  assert.equal(mapLogWord(hashLike, reverse), hashLike);

  // A small numeric amount that happens to be left-padded but is not a known address is untouched.
  const amount = word('0'.repeat(60) + '03e8'); // 1000
  assert.equal(mapLogWord(amount, reverse), amount);
});

test('mapTopics maps each entry independently and preserves the event signature topic', () => {
  const signature = word('dd'.repeat(32));
  const mapped = mapTopics([signature, leftPadded(ACTUAL), leftPadded(OTHER_ACTUAL)], reverse);
  assert.deepEqual(mapped, [signature, leftPadded(PREDICTED), leftPadded(OTHER_PREDICTED)]);
});

test('mapLogData maps each 32-byte word and keeps trailing sub-word bytes byte-for-byte', () => {
  // Two ABI words (both mapped addresses) followed by 4 trailing bytes that do not fill a word.
  const data = `0x${'0'.repeat(24)}${'22'.repeat(20)}${'0'.repeat(24)}${'44'.repeat(20)}deadbeef`;
  const expected = `0x${'0'.repeat(24)}${'33'.repeat(20)}${'0'.repeat(24)}${'55'.repeat(20)}deadbeef`;
  assert.equal(mapLogData(data, reverse), expected);
  assert.equal(mapLogData('0x', reverse), '0x');
});

test('mapLogEntry reverse-maps address, topics, and data together and leaves other fields intact', () => {
  const log = {
    address: ACTUAL,
    topics: [word('dd'.repeat(32)), leftPadded(ACTUAL)],
    data: `0x${'0'.repeat(24)}${'44'.repeat(20)}`,
    blockNumber: '0x2a',
    logIndex: '0x0',
  };
  assert.deepEqual(mapLogEntry(log, reverse), {
    address: PREDICTED,
    topics: [word('dd'.repeat(32)), leftPadded(PREDICTED)],
    data: `0x${'0'.repeat(24)}${'55'.repeat(20)}`,
    blockNumber: '0x2a',
    logIndex: '0x0',
  });
});

test('mapFilterParams forward-maps a single address, an address array, and address topics of a getLogs filter', () => {
  const single = mapFilterParams([{ address: PREDICTED, fromBlock: '0x1' }], forward);
  assert.deepEqual(single, [{ address: ACTUAL, fromBlock: '0x1' }]);

  const array = mapFilterParams([{ address: [PREDICTED, `0x${'99'.repeat(20)}`] }], forward);
  assert.deepEqual(array, [{ address: [ACTUAL, `0x${'99'.repeat(20)}`] }]);

  const topics = mapFilterParams([{ topics: [word('dd'.repeat(32)), leftPadded(PREDICTED)] }], forward);
  assert.deepEqual(topics, [{ topics: [word('dd'.repeat(32)), leftPadded(ACTUAL)] }]);
});

test('mapFilterParams tolerates a nested OR topic array and a missing/empty filter', () => {
  const nested = mapFilterParams([{ topics: [[leftPadded(PREDICTED), word('dd'.repeat(32))]] }], forward);
  assert.deepEqual(nested, [{ topics: [[leftPadded(ACTUAL), word('dd'.repeat(32))]] }]);

  assert.deepEqual(mapFilterParams([], forward), []);
});

// --- Edge cases: casing normalization, unmapped/empty logs, and malformed entries ------------------

test('mapAddressField and mapLogWord normalize mixed-case hex before the exact lookup', () => {
  const upperActual = `0x${'22'.repeat(20)}`.toUpperCase().replace('0X', '0x');
  assert.equal(mapAddressField(upperActual, reverse), PREDICTED);
  const upperWord = `0x${'0'.repeat(24)}${'22'.repeat(20)}`.toUpperCase().replace('0X', '0x');
  assert.equal(mapLogWord(upperWord, reverse), leftPadded(PREDICTED));
});

test('mapAddressField leaves non-string and non-address inputs untouched', () => {
  for (const value of [undefined, null, 42, {}, '0x1234', 'not-hex']) {
    assert.equal(mapAddressField(value as never, reverse), value as never);
  }
});

test('mapLogWord leaves non-string and non-word inputs untouched', () => {
  for (const value of [undefined, null, 42, `0x${'22'.repeat(20)}`]) {
    assert.equal(mapLogWord(value as never, reverse), value as never);
  }
});

test('mapTopics and mapLogData pass through non-array / non-string inputs unchanged', () => {
  assert.equal(mapTopics(undefined as never, reverse), undefined);
  assert.equal(mapTopics('0xdead' as never, reverse), '0xdead');
  assert.equal(mapLogData(undefined as never, reverse), undefined);
  assert.equal(mapLogData(42 as never, reverse), 42);
});

test('mapLogData keeps odd trailing sub-word bytes and maps only complete words', () => {
  // One mapped-address word followed by 3 trailing bytes that never fill a second word.
  const data = `0x${'0'.repeat(24)}${'22'.repeat(20)}aabbcc`;
  const expected = `0x${'0'.repeat(24)}${'33'.repeat(20)}aabbcc`;
  assert.equal(mapLogData(data, reverse), expected);
  // Sub-word data smaller than a single word is preserved verbatim.
  assert.equal(mapLogData('0xdeadbeef', reverse), '0xdeadbeef');
});

test('mapLogEntry reverse-maps an entry whose address is unmapped by leaving it untouched', () => {
  const unmapped = `0x${'99'.repeat(20)}`;
  const log = { address: unmapped, topics: [leftPadded(unmapped)], data: leftPadded(unmapped), blockNumber: '0x1' };
  assert.deepEqual(mapLogEntry(log, reverse), log);
});

test('mapLogEntry returns null, arrays, and non-objects untouched', () => {
  assert.equal(mapLogEntry(null as never, reverse), null);
  const arr = [{ address: ACTUAL }];
  assert.equal(mapLogEntry(arr as never, reverse), arr);
  assert.equal(mapLogEntry('0xdead' as never, reverse), '0xdead');
});

test('mapLogEntry tolerates malformed field types and only maps well-formed ones', () => {
  const log = { address: 42, topics: 'not-an-array', data: 99, blockNumber: '0x1' };
  // Malformed fields are left byte-for-byte; the entry is still a fresh object copy.
  assert.deepEqual(mapLogEntry(log, reverse), log);

  const partial = { address: ACTUAL }; // no topics / data members
  const mapped = mapLogEntry(partial, reverse);
  assert.deepEqual(mapped, { address: PREDICTED });
  assert.equal('topics' in mapped, false);
  assert.equal('data' in mapped, false);
});

test('mapFilterParams passes through non-array params and a non-object filter', () => {
  assert.equal(mapFilterParams('nope' as never, forward), 'nope');
  assert.deepEqual(mapFilterParams([null, 'latest'], forward), [null, 'latest']);
  assert.deepEqual(mapFilterParams(['not-a-filter'], forward), ['not-a-filter']);
});

test('mapFilterParams maps an address array with a mix of mapped and unmapped entries', () => {
  const unmapped = `0x${'99'.repeat(20)}`;
  const result = mapFilterParams([{ address: [PREDICTED, unmapped, `0x${'00'.repeat(20)}`] }], forward);
  assert.deepEqual(result, [{ address: [ACTUAL, unmapped, `0x${'00'.repeat(20)}`] }]);
});
