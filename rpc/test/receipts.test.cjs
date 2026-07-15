const assert = require('node:assert/strict');
const test = require('node:test');

const { internalCreateAttempts, internalCreateTransactions, translateReceipt } = require('../receipts.cjs');

const SOURCE_HASH = `0x${'aa'.repeat(32)}`;
const NATIVE_TXID = 'bb'.repeat(32);
const OWNER = `41${'11'.repeat(20)}`;
const ACTUAL_CONTRACT = `41${'22'.repeat(20)}`;
const PREDICTED_CONTRACT = `0x${'33'.repeat(20)}`;

function nativeTransaction(type = 'CreateSmartContract') {
  const value = {
    owner_address: OWNER,
    ...(type === 'TriggerSmartContract' ? { contract_address: ACTUAL_CONTRACT } : {}),
  };
  return {
    txID: NATIVE_TXID,
    raw_data: {
      contract: [{ type, parameter: { value } }],
    },
    ret: [{ contractRet: 'SUCCESS' }],
  };
}

function confirmedInfo(overrides = {}) {
  return {
    id: NATIVE_TXID,
    blockNumber: 42,
    transactionIndex: 2,
    blockTimeStamp: 1_700_000_000_000,
    blockHash: 'cc'.repeat(32),
    contract_address: ACTUAL_CONTRACT,
    receipt: {
      result: 'SUCCESS',
      energy_usage_total: 21_000,
      energy_fee: 42_000,
      net_fee: 1_000,
    },
    fee: 43_000,
    log: [
      {
        address: ACTUAL_CONTRACT.slice(2),
        topics: ['dd'.repeat(32)],
        data: '1234',
      },
    ],
    internal_transactions: [
      {
        hash: 'ee'.repeat(32),
        caller_address: OWNER,
        transferTo_address: ACTUAL_CONTRACT,
        note: Buffer.from('create').toString('hex'),
        rejected: false,
        callValueInfo: [{ callValue: 0 }],
      },
    ],
    ...overrides,
  };
}

test('translates a successful native deployment receipt including block, contract, logs, internal creates, energy, and fees', () => {
  const receipt = translateReceipt(
    { transaction: nativeTransaction(), info: confirmedInfo() },
    {
      sourceTransactionHash: SOURCE_HASH,
      predictedContractAddress: PREDICTED_CONTRACT,
      resolveAddress(address) {
        return address.toLowerCase() === `0x${'22'.repeat(20)}` ? PREDICTED_CONTRACT : undefined;
      },
    },
  );

  assert.deepEqual(receipt, {
    transactionHash: SOURCE_HASH,
    transactionIndex: '0x2',
    blockHash: `0x${'cc'.repeat(32)}`,
    blockNumber: '0x2a',
    from: `0x${'11'.repeat(20)}`,
    to: null,
    cumulativeGasUsed: '0x5208',
    gasUsed: '0x5208',
    contractAddress: PREDICTED_CONTRACT,
    logs: [
      {
        address: PREDICTED_CONTRACT,
        topics: [`0x${'dd'.repeat(32)}`],
        data: '0x1234',
        blockNumber: '0x2a',
        transactionHash: SOURCE_HASH,
        transactionIndex: '0x2',
        blockHash: `0x${'cc'.repeat(32)}`,
        logIndex: '0x0',
        removed: false,
      },
    ],
    logsBloom: `0x${'00'.repeat(256)}`,
    status: '0x1',
    type: '0x0',
    effectiveGasPrice: '0x2',
    tron: {
      nativeTransactionId: NATIVE_TXID,
      actualContractAddress: `0x${'22'.repeat(20)}`,
      energyUsageTotal: '0x5208',
      energyFee: '0xa410',
      netFee: '0x3e8',
      fee: '0xa7f8',
      blockTimestamp: '0x18bcfe56800',
      result: 'SUCCESS',
      resultMessage: null,
      internalTransactions: [
        {
          hash: `0x${'ee'.repeat(32)}`,
          callerAddress: `0x${'11'.repeat(20)}`,
          transferToAddress: PREDICTED_CONTRACT,
          note: 'create',
          rejected: false,
          callValueInfo: [{ callValue: 0 }],
        },
      ],
    },
  });
});

test('keeps internal transaction addresses native when reconciliation supplies a distinct resolver', () => {
  const child = `41${'44'.repeat(20)}`;
  const info = confirmedInfo();
  info.internal_transactions[0].caller_address = ACTUAL_CONTRACT;
  info.internal_transactions[0].transferTo_address = child;

  const receipt = translateReceipt(
    { transaction: nativeTransaction(), info },
    {
      sourceTransactionHash: SOURCE_HASH,
      predictedContractAddress: PREDICTED_CONTRACT,
      resolveAddress: () => PREDICTED_CONTRACT,
      resolveInternalAddress: address => address,
    },
  );

  assert.equal(receipt.logs[0].address, PREDICTED_CONTRACT);
  assert.equal(receipt.tron.internalTransactions[0].callerAddress, `0x${'22'.repeat(20)}`);
  assert.equal(receipt.tron.internalTransactions[0].transferToAddress, `0x${'44'.repeat(20)}`);
});

test('translates confirmed native reverts as status zero and preserves the result message', () => {
  const info = confirmedInfo({
    receipt: { result: 'REVERT', energy_usage_total: 9, energy_fee: 27 },
    fee: 27,
    resMessage: Buffer.from('execution reverted').toString('hex'),
    contract_address: undefined,
    log: [],
    internal_transactions: [],
  });
  const transaction = nativeTransaction('TriggerSmartContract');
  transaction.ret[0].contractRet = 'REVERT';

  const receipt = translateReceipt(
    { transaction, info },
    { sourceTransactionHash: SOURCE_HASH, resolveAddress: () => undefined },
  );

  assert.equal(receipt.status, '0x0');
  assert.equal(receipt.contractAddress, null);
  assert.equal(receipt.from, `0x${'11'.repeat(20)}`);
  assert.equal(receipt.to, `0x${'22'.repeat(20)}`);
  assert.equal(receipt.gasUsed, '0x9');
  assert.equal(receipt.effectiveGasPrice, '0x3');
  assert.equal(receipt.tron.result, 'REVERT');
  assert.equal(receipt.tron.resultMessage, 'execution reverted');
});

test('uses total fee per energy unit when the dedicated energy fee is absent and handles zero energy', () => {
  const fromFee = translateReceipt(
    {
      transaction: nativeTransaction('TriggerSmartContract'),
      info: confirmedInfo({
        receipt: { result: 'SUCCESS', energy_usage_total: 3 },
        fee: 10,
        contract_address: undefined,
        log: [],
        internal_transactions: [],
      }),
    },
    { sourceTransactionHash: SOURCE_HASH },
  );
  assert.equal(fromFee.effectiveGasPrice, '0x4');

  const zero = translateReceipt(
    {
      transaction: nativeTransaction('TriggerSmartContract'),
      info: confirmedInfo({
        receipt: { result: 'SUCCESS', energy_usage_total: 0 },
        fee: 10,
        contract_address: undefined,
        log: [],
        internal_transactions: [],
      }),
    },
    { sourceTransactionHash: SOURCE_HASH },
  );
  assert.equal(zero.effectiveGasPrice, '0x0');
});

test('refuses unconfirmed, mismatched, or malformed native receipt data', () => {
  assert.throws(
    () => translateReceipt({ transaction: nativeTransaction(), info: null }, { sourceTransactionHash: SOURCE_HASH }),
    /confirmed.*receipt/i,
  );
  assert.throws(
    () =>
      translateReceipt(
        { transaction: nativeTransaction(), info: confirmedInfo({ id: 'ff'.repeat(32) }) },
        { sourceTransactionHash: SOURCE_HASH },
      ),
    /transaction id/i,
  );
  assert.throws(
    () =>
      translateReceipt(
        { transaction: nativeTransaction(), info: confirmedInfo({ blockNumber: -1 }) },
        { sourceTransactionHash: SOURCE_HASH },
      ),
    /block/i,
  );
  assert.throws(
    () =>
      translateReceipt(
        { transaction: nativeTransaction(), info: confirmedInfo({ blockHash: undefined }) },
        { sourceTransactionHash: SOURCE_HASH },
      ),
    /block hash/i,
  );
  assert.throws(
    () =>
      translateReceipt(
        { transaction: nativeTransaction(), info: confirmedInfo({ transactionIndex: undefined }) },
        { sourceTransactionHash: SOURCE_HASH },
      ),
    /transaction index/i,
  );
  const malformedRejected = confirmedInfo();
  malformedRejected.internal_transactions[0].rejected = 'false';
  assert.throws(
    () =>
      translateReceipt(
        { transaction: nativeTransaction(), info: malformedRejected },
        { sourceTransactionHash: SOURCE_HASH },
      ),
    /rejected/i,
  );
});

test('extracts only successful internal CREATE transactions while preserving receipt order', () => {
  const receipt = {
    tron: {
      internalTransactions: [
        { hash: 'first', note: 'create', rejected: false },
        { hash: 'call', note: 'call', rejected: false },
        { hash: 'failed', note: 'create', rejected: true },
        { hash: 'second', note: 'CREATE', rejected: false },
      ],
    },
  };

  assert.deepEqual(
    internalCreateTransactions(receipt).map(transaction => transaction.hash),
    ['first', 'second'],
  );
  assert.throws(() => internalCreateTransactions({}), /internal transaction/i);
});

test('fails closed on an internal transaction whose note is missing or malformed', () => {
  // A missing/malformed note must be rejected, never silently classified as a non-CREATE.
  for (const note of [undefined, null, 123, {}, ['create']]) {
    assert.throws(
      () => internalCreateAttempts({ tron: { internalTransactions: [{ hash: 'x', note, rejected: false }] } }),
      /note/i,
    );
    assert.throws(
      () => internalCreateTransactions({ tron: { internalTransactions: [{ hash: 'x', note, rejected: false }] } }),
      /note/i,
    );
  }

  // End-to-end: a non-string raw note decodes to null and the classifier rejects it.
  const info = confirmedInfo();
  info.internal_transactions[0].note = 42;
  const translated = translateReceipt(
    { transaction: nativeTransaction(), info },
    { sourceTransactionHash: SOURCE_HASH, predictedContractAddress: PREDICTED_CONTRACT },
  );
  assert.equal(translated.tron.internalTransactions[0].note, null);
  assert.throws(() => internalCreateTransactions(translated), /note/i);
});

test('adopts the runtime note decoder, tolerating an optional 0x prefix on hex markers', () => {
  const prefixed = confirmedInfo();
  prefixed.internal_transactions[0].note = `0x${Buffer.from('create').toString('hex')}`;
  const translated = translateReceipt(
    { transaction: nativeTransaction(), info: prefixed },
    { sourceTransactionHash: SOURCE_HASH, predictedContractAddress: PREDICTED_CONTRACT },
  );
  assert.equal(translated.tron.internalTransactions[0].note, 'create');
  assert.deepEqual(
    internalCreateTransactions(translated).map(transaction => transaction.hash),
    [`0x${'ee'.repeat(32)}`],
  );
});
