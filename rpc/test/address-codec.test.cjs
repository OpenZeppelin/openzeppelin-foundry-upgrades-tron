const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeAddress, toBase58Address, toEvmAddress, toTronHexAddress } = require('../address-codec.cjs');

const EVM_ADDRESS = '0x1111111111111111111111111111111111111111';
const TRON_HEX_ADDRESS = '411111111111111111111111111111111111111111';
const BASE58_ADDRESS = 'TBXSw8fM4jpQkGc6zZjsVABFpVN7UvXPdV';
const EVM_ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const TRON_ZERO_ADDRESS = '410000000000000000000000000000000000000000';
const BASE58_ZERO_ADDRESS = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';

test('round-trips a 20-byte EVM hex address through TRON hex and Base58', () => {
  assert.equal(toTronHexAddress(EVM_ADDRESS), TRON_HEX_ADDRESS);
  assert.equal(toBase58Address(EVM_ADDRESS), BASE58_ADDRESS);
  assert.equal(toEvmAddress(toTronHexAddress(EVM_ADDRESS)), EVM_ADDRESS);
  assert.equal(toEvmAddress(toBase58Address(EVM_ADDRESS)), EVM_ADDRESS);
});

test('accepts a bare 20-byte hex address and returns canonical output', () => {
  const bareUppercase = EVM_ADDRESS.slice(2).toUpperCase();

  assert.deepEqual(normalizeAddress(bareUppercase), {
    evm: EVM_ADDRESS,
    tronHex: TRON_HEX_ADDRESS,
    base58: BASE58_ADDRESS,
  });
});

test('round-trips a 41-prefixed TRON hex address case-insensitively', () => {
  assert.deepEqual(normalizeAddress(`0x${TRON_HEX_ADDRESS.toUpperCase()}`), {
    evm: EVM_ADDRESS,
    tronHex: TRON_HEX_ADDRESS,
    base58: BASE58_ADDRESS,
  });
});

test('round-trips a checksum-valid Base58 address', () => {
  assert.deepEqual(normalizeAddress(BASE58_ADDRESS), {
    evm: EVM_ADDRESS,
    tronHex: TRON_HEX_ADDRESS,
    base58: BASE58_ADDRESS,
  });
});

test('preserves the zero address across all encodings', () => {
  for (const address of [EVM_ZERO_ADDRESS, TRON_ZERO_ADDRESS, BASE58_ZERO_ADDRESS]) {
    assert.deepEqual(normalizeAddress(address), {
      evm: EVM_ZERO_ADDRESS,
      tronHex: TRON_ZERO_ADDRESS,
      base58: BASE58_ZERO_ADDRESS,
    });
  }
});

test('rejects malformed, non-TRON, and non-string addresses', () => {
  const invalidAddresses = [
    '',
    ' 0x1111111111111111111111111111111111111111',
    '0x111111111111111111111111111111111111111',
    '0x11111111111111111111111111111111111111111',
    '0xgg11111111111111111111111111111111111111',
    '421111111111111111111111111111111111111111',
    `${BASE58_ADDRESS.slice(0, -1)}W`,
    null,
    0,
  ];

  for (const address of invalidAddresses) {
    assert.throws(() => normalizeAddress(address), /invalid TRON address/i, String(address));
  }
});
