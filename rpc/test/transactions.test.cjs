'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Transaction, Wallet, encodeRlp, hexlify, toBeArray } = require('ethers');

const { decodeLegacyTransaction } = require('../transactions.cjs');

const wallet = new Wallet(`0x${'11'.repeat(32)}`);
const recipient = `0x${'22'.repeat(20)}`;

async function signed(overrides = {}) {
  return wallet.signTransaction({
    type: 0,
    chainId: 1337,
    nonce: 7,
    gasLimit: 100_000,
    gasPrice: 2,
    value: 0,
    to: recipient,
    data: '0x1234',
    ...overrides,
  });
}

test('decodes a canonical signed EIP-155 legacy call', async () => {
  const raw = await signed({ value: 42 });
  const decoded = decodeLegacyTransaction(raw, {
    expectedSender: wallet.address,
    expectedChainId: 1337,
  });

  assert.deepEqual(decoded, {
    raw: raw.toLowerCase(),
    hash: Transaction.from(raw).hash,
    type: 0,
    kind: 'call',
    from: wallet.address,
    to: recipient,
    chainId: 1337n,
    nonce: 7,
    gasLimit: 100_000n,
    gasPrice: 2n,
    value: 42n,
    callValue: '42',
    data: '0x1234',
  });
});

test('classifies contract creation and preserves its initcode', async () => {
  const raw = await signed({ to: null, data: '0x6001600055' });
  const decoded = decodeLegacyTransaction(raw, { expectedSender: wallet.address, expectedChainId: 1337n });

  assert.equal(decoded.kind, 'deployment');
  assert.equal(decoded.to, null);
  assert.equal(decoded.data, '0x6001600055');
});

test('rejects malformed, unsigned, typed, and unprotected transactions', async t => {
  await t.test('malformed', () => {
    assert.throws(
      () => decodeLegacyTransaction('0x1234', { expectedSender: wallet.address, expectedChainId: 1337 }),
      /malformed/i,
    );
  });

  await t.test('unsigned', () => {
    const unsigned = Transaction.from({
      type: 0,
      chainId: 1337,
      nonce: 0,
      gasLimit: 21_000,
      gasPrice: 1,
      to: recipient,
    }).unsignedSerialized;
    assert.throws(
      () => decodeLegacyTransaction(unsigned, { expectedSender: wallet.address, expectedChainId: 1337 }),
      /signed/i,
    );
  });

  await t.test('typed EIP-2930', async () => {
    const raw = await signed({ type: 1, accessList: [] });
    assert.throws(
      () => decodeLegacyTransaction(raw, { expectedSender: wallet.address, expectedChainId: 1337 }),
      /legacy|type/i,
    );
  });

  await t.test('typed EIP-1559', async () => {
    const raw = await wallet.signTransaction({
      type: 2,
      chainId: 1337,
      nonce: 0,
      gasLimit: 21_000,
      maxFeePerGas: 2,
      maxPriorityFeePerGas: 1,
      to: recipient,
    });
    assert.throws(
      () => decodeLegacyTransaction(raw, { expectedSender: wallet.address, expectedChainId: 1337 }),
      /legacy|type/i,
    );
  });

  await t.test('unprotected legacy', async () => {
    const raw = await wallet.signTransaction({
      type: 0,
      nonce: 0,
      gasLimit: 21_000,
      gasPrice: 1,
      to: recipient,
    });
    assert.throws(
      () => decodeLegacyTransaction(raw, { expectedSender: wallet.address, expectedChainId: 1337 }),
      /EIP-155|protected/i,
    );
  });
});

test('rejects noncanonical legacy RLP', async () => {
  const raw = await signed();
  const transaction = Transaction.from(raw);
  const signature = transaction.signature;
  const noncanonical = encodeRlp([
    hexlify(toBeArray(transaction.nonce)),
    hexlify(toBeArray(transaction.gasPrice)),
    hexlify(toBeArray(transaction.gasLimit)),
    transaction.to,
    '0x00',
    transaction.data,
    hexlify(toBeArray(signature.v)),
    hexlify(toBeArray(signature.r)),
    hexlify(toBeArray(signature.s)),
  ]);

  // The alternate zero encoding is semantically zero but not canonical for an Ethereum integer.
  assert.notEqual(noncanonical, raw);
  assert.throws(
    () => decodeLegacyTransaction(noncanonical, { expectedSender: wallet.address, expectedChainId: 1337 }),
    /canonical|malformed/i,
  );
});

test('rejects sender and chain mismatches', async () => {
  const raw = await signed();

  assert.throws(
    () => decodeLegacyTransaction(raw, { expectedSender: `0x${'33'.repeat(20)}`, expectedChainId: 1337 }),
    /sender/i,
  );
  assert.throws(() => decodeLegacyTransaction(raw, { expectedSender: wallet.address, expectedChainId: 1 }), /chain/i);
});

test('maps the maximum exact TRON call value and rejects int64 overflow', async () => {
  const maximum = (1n << 63n) - 1n;
  const decoded = decodeLegacyTransaction(await signed({ value: maximum }), {
    expectedSender: wallet.address,
    expectedChainId: 1337,
  });
  assert.equal(decoded.value, maximum);
  assert.equal(decoded.callValue, maximum.toString());

  const overflow = await signed({ value: 1n << 63n });
  assert.throws(
    () =>
      decodeLegacyTransaction(Transaction.from(overflow).serialized, {
        expectedSender: wallet.address,
        expectedChainId: 1337,
      }),
    /int64|value/i,
  );
});

test('requires valid expected sender and chain constraints', async () => {
  const raw = await signed();
  assert.throws(
    () => decodeLegacyTransaction(raw, { expectedSender: 'not-an-address', expectedChainId: 1337 }),
    /sender/i,
  );
  assert.throws(() => decodeLegacyTransaction(raw, { expectedSender: wallet.address, expectedChainId: 0 }), /chain/i);
  assert.throws(
    () => decodeLegacyTransaction(raw, { expectedChainId: 1337 }),
    error => error.code === 'INVALID_EXPECTED_SENDER',
  );
  assert.throws(
    () => decodeLegacyTransaction(raw, { expectedSender: wallet.address }),
    error => error.code === 'INVALID_EXPECTED_CHAIN',
  );
});
