const assert = require('node:assert/strict');
const test = require('node:test');

const { utils } = require('tronweb');

const { TronClient, nativeTxIdFromSignedBytes, serializeSignedTransaction } = require('../tron-client.cjs');

const PRIVATE_KEY = 'dd23ca549a97cb330b011aebb674730df8b14acaee42d211ab45692699ab8ba5';
const OWNER = `41${'11'.repeat(20)}`;
const CONTRACT = `41${'22'.repeat(20)}`;

function unsignedTransaction() {
  const transaction = {
    visible: false,
    txID: '',
    raw_data_hex: '',
    raw_data: {
      contract: [
        {
          parameter: {
            value: { owner_address: OWNER, contract_address: CONTRACT, data: 'aabb' },
            type_url: 'type.googleapis.com/protocol.TriggerSmartContract',
          },
          type: 'TriggerSmartContract',
        },
      ],
      ref_block_bytes: '1234',
      ref_block_hash: '0102030405060708',
      expiration: 1_700_000_060_000,
      timestamp: 1_700_000_000_000,
      fee_limit: 1_000_000_000,
    },
  };
  const protobuf = utils.transaction.txJsonToPb(transaction);
  transaction.txID = utils.transaction.txPbToTxID(protobuf).replace(/^0x/, '');
  transaction.raw_data_hex = utils.transaction.txPbToRawDataHex(protobuf).toLowerCase();
  return transaction;
}

function signedFixture() {
  return utils.crypto.signTransaction(PRIVATE_KEY, unsignedTransaction());
}

function fixture(overrides = {}) {
  const calls = [];
  const tronWeb = {
    defaultAddress: { hex: OWNER },
    transactionBuilder: {
      async createSmartContract(options, issuerAddress) {
        calls.push({ method: 'createSmartContract', options, issuerAddress });
        return unsignedTransaction();
      },
      async triggerSmartContract(address, selector, options, parameters, issuerAddress) {
        calls.push({ method: 'triggerSmartContract', address, selector, options, parameters, issuerAddress });
        return { result: { result: true }, transaction: unsignedTransaction() };
      },
    },
    trx: {
      async sign(transaction, privateKey) {
        calls.push({ method: 'sign', privateKey });
        return utils.crypto.signTransaction(privateKey, structuredClone(transaction));
      },
    },
  };
  const transport = {
    async request(path, body) {
      calls.push({ method: 'request', path, body });
      throw new Error(`Unexpected request: ${path}`);
    },
  };
  return {
    calls,
    client: new TronClient({
      config: {
        privateKey: PRIVATE_KEY,
        feeLimit: 1_000_000_000,
        fullHost: 'http://127.0.0.1:9090',
      },
      tronWeb,
      transport,
      ...overrides,
    }),
    transport,
    tronWeb,
  };
}

test('prebuilds and signs a native CreateSmartContract using normalized owner and exact constructor suffix', async () => {
  const { calls, client } = fixture();
  const abi = [{ type: 'constructor', inputs: [{ name: 'value', type: 'uint256' }] }];

  const built = await client.buildCreate({
    abi,
    bytecode: '0x60006000',
    constructorData: '0x'.concat('00'.repeat(31), '2a'),
    ownerAddress: `0x${'11'.repeat(20)}`,
    name: 'Box',
    callValue: 7,
  });

  assert.deepEqual(calls[0], {
    method: 'createSmartContract',
    issuerAddress: OWNER,
    options: {
      abi,
      bytecode: '60006000',
      callValue: 7,
      feeLimit: 1_000_000_000,
      name: 'Box',
      rawParameter: '00'.repeat(31).concat('2a'),
    },
  });
  assert.equal(calls[1].method, 'sign');
  assert.equal(calls[1].privateKey, PRIVATE_KEY);
  assert.match(built.signedNativeTransaction, /^[0-9a-f]+$/);
  assert.equal(built.nativeTransactionId, nativeTxIdFromSignedBytes(built.signedNativeTransaction));
  assert.equal(built.nativeTransactionId, built.transaction.txID);
});

test('prebuilds a raw TriggerSmartContract call without ABI re-encoding', async () => {
  const { calls, client } = fixture();
  const data = `0x12345678${'ab'.repeat(32)}`;

  const built = await client.buildCall({
    contractAddress: `0x${'22'.repeat(20)}`,
    data,
    ownerAddress: OWNER,
    callValue: 11,
  });

  assert.deepEqual(calls[0], {
    method: 'triggerSmartContract',
    address: CONTRACT,
    selector: '',
    options: {
      callValue: 11,
      feeLimit: 1_000_000_000,
      input: data.slice(2),
    },
    parameters: [],
    issuerAddress: OWNER,
  });
  assert.equal(built.nativeTransactionId, nativeTxIdFromSignedBytes(built.signedNativeTransaction));
});

test('serializes the complete signed protobuf and derives a signature-independent stable transaction ID', () => {
  const signed = signedFixture();
  const serialized = serializeSignedTransaction(signed);
  const withRepeatedSignature = structuredClone(signed);
  withRepeatedSignature.signature.push(withRepeatedSignature.signature[0]);

  assert.notEqual(serializeSignedTransaction(withRepeatedSignature), serialized);
  assert.equal(nativeTxIdFromSignedBytes(serialized), signed.txID);
  assert.equal(nativeTxIdFromSignedBytes(serializeSignedTransaction(withRepeatedSignature)), signed.txID);
  assert.throws(() => nativeTxIdFromSignedBytes('00'), /raw_data|protobuf/i);
});

test('simulates the exact signed transaction and returns a complete ordered child-attempt trace', async () => {
  const signedBytes = serializeSignedTransaction(signedFixture());
  const txid = nativeTxIdFromSignedBytes(signedBytes);
  const requests = [];
  const { client } = fixture({
    transport: {
      async request(path, body) {
        requests.push({ path, body });
        return {
          result: { result: true },
          txid,
          trace_complete: true,
          energy_used: 901,
          child_create_attempts: [
            { caller_address: OWNER, created_address: CONTRACT, success: true },
            { caller_address: CONTRACT, created_address: `0x${'00'.repeat(20)}`, success: false },
          ],
        };
      },
    },
  });

  assert.deepEqual(await client.simulateSigned(signedBytes, txid), {
    nativeTransactionId: txid,
    energyUsed: 901,
    childCreateAttempts: [
      {
        index: 0,
        callerAddress: `0x${'11'.repeat(20)}`,
        createdAddress: `0x${'22'.repeat(20)}`,
        success: true,
      },
      {
        index: 1,
        callerAddress: `0x${'22'.repeat(20)}`,
        createdAddress: `0x${'00'.repeat(20)}`,
        success: false,
      },
    ],
  });
  assert.deepEqual(requests, [
    {
      path: 'wallet/simulatesignedtransaction',
      body: { transaction: signedBytes },
    },
  ]);
});

test('refuses exact simulation when the capability is unavailable, mismatched, or incomplete', async t => {
  const signedBytes = serializeSignedTransaction(signedFixture());
  const txid = nativeTxIdFromSignedBytes(signedBytes);
  const cases = [
    {
      name: 'unavailable',
      response: Promise.reject(Object.assign(new Error('404'), { status: 404 })),
      pattern: /exact.*simulation.*unavailable/i,
    },
    {
      name: 'wrong txid',
      response: Promise.resolve({ result: { result: true }, txid: 'ff'.repeat(32), trace_complete: true }),
      pattern: /transaction id/i,
    },
    {
      name: 'no completeness marker',
      response: Promise.resolve({ result: { result: true }, txid, child_create_attempts: [] }),
      pattern: /complete.*trace/i,
    },
    {
      name: 'malformed child attempt',
      response: Promise.resolve({
        result: { result: true },
        txid,
        trace_complete: true,
        child_create_attempts: [{ caller_address: OWNER, success: true }],
      }),
      pattern: /child.*trace/i,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const { client } = fixture({ transport: { request: () => item.response } });
      await assert.rejects(() => client.simulateSigned(signedBytes, txid), item.pattern);
    });
  }
});

test('queries an existing native transaction and distinguishes unconfirmed and absent results', async () => {
  const transaction = unsignedTransaction();
  const txid = transaction.txID;
  const responses = [transaction, {}, {}, {}];
  const requests = [];
  const { client } = fixture({
    transport: {
      async request(path, body) {
        requests.push({ path, body });
        return responses.shift();
      },
    },
  });

  assert.deepEqual(await client.getTransaction(`0x${txid.toUpperCase()}`), {
    transaction,
    info: null,
    confirmed: false,
  });
  assert.equal(await client.getTransaction(txid), null);
  assert.deepEqual(
    requests.map(request => request.path),
    [
      'wallet/gettransactionbyid',
      'wallet/gettransactioninfobyid',
      'wallet/gettransactionbyid',
      'wallet/gettransactioninfobyid',
    ],
  );
  assert.ok(requests.every(request => request.body.value === txid));
});

test('rebroadcasts exact signed bytes, retries transient sends, and accepts a duplicate response', async () => {
  const signedBytes = serializeSignedTransaction(signedFixture());
  const txid = nativeTxIdFromSignedBytes(signedBytes);
  const attempts = [];
  const responses = [new Error('connection reset'), { result: true, txid }];
  const { client } = fixture({
    maxBroadcastAttempts: 3,
    sleep: async () => {},
    transport: {
      async request(path, body) {
        attempts.push({ path, body });
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return response;
      },
    },
  });

  assert.deepEqual(await client.broadcastSigned(signedBytes, txid), {
    nativeTransactionId: txid,
    duplicate: false,
  });
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every(attempt => attempt.body.transaction === signedBytes));

  const duplicate = fixture({
    transport: {
      async request() {
        return { result: false, code: 'DUP_TRANSACTION_ERROR', txid };
      },
    },
  }).client;
  assert.deepEqual(await duplicate.broadcastSigned(signedBytes, txid), {
    nativeTransactionId: txid,
    duplicate: true,
  });
});

test('refuses a rebroadcast txid mismatch and stops after the configured retry count', async () => {
  const signedBytes = serializeSignedTransaction(signedFixture());
  const txid = nativeTxIdFromSignedBytes(signedBytes);
  const mismatched = fixture({
    transport: { request: async () => ({ result: true, txid: 'ff'.repeat(32) }) },
  }).client;
  await assert.rejects(() => mismatched.broadcastSigned(signedBytes, txid), /transaction id/i);

  let attempts = 0;
  const failing = fixture({
    maxBroadcastAttempts: 2,
    sleep: async () => {},
    transport: {
      async request() {
        attempts += 1;
        throw new Error('offline');
      },
    },
  }).client;
  await assert.rejects(() => failing.broadcastSigned(signedBytes, txid), /offline/);
  assert.equal(attempts, 2);
});

test('polls unconfirmed transactions until a confirmed translated receipt exists', async () => {
  const sourceHash = `0x${'ab'.repeat(32)}`;
  const transaction = unsignedTransaction();
  const txid = transaction.txID;
  const snapshots = [
    { transaction, info: null, confirmed: false },
    {
      transaction,
      info: {
        id: txid,
        blockNumber: 42,
        blockTimeStamp: 1_700_000_000_000,
        blockHash: 'ef'.repeat(32),
        receipt: { result: 'SUCCESS', energy_usage_total: 50, energy_fee: 100 },
        fee: 125,
      },
      confirmed: true,
    },
  ];
  const sleeps = [];
  const { client } = fixture({ sleep: async delay => sleeps.push(delay), pollIntervalMs: 7 });
  client.getTransaction = async () => snapshots.shift();

  const receipt = await client.waitForReceipt(txid, { sourceTransactionHash: sourceHash });

  assert.equal(receipt.transactionHash, sourceHash);
  assert.equal(receipt.blockNumber, '0x2a');
  assert.equal(receipt.status, '0x1');
  assert.deepEqual(sleeps, [7]);
});

test('loads the confirmed block hash while querying a native receipt', async () => {
  const transaction = unsignedTransaction();
  const txid = transaction.txID;
  const requests = [];
  const { client } = fixture({
    transport: {
      async request(path, body) {
        requests.push({ path, body });
        if (path === 'wallet/gettransactionbyid') return transaction;
        if (path === 'wallet/gettransactioninfobyid') {
          return { id: txid, blockNumber: 7, receipt: { result: 'SUCCESS' } };
        }
        if (path === 'wallet/getblockbynum') return { blockID: 'ef'.repeat(32) };
        throw new Error(`Unexpected request: ${path}`);
      },
    },
  });

  const snapshot = await client.getTransaction(txid);

  assert.equal(snapshot.confirmed, true);
  assert.equal(snapshot.info.blockHash, 'ef'.repeat(32));
  assert.deepEqual(requests.at(-1), { path: 'wallet/getblockbynum', body: { num: 7 } });
});

test('times out receipt polling without treating an unconfirmed transaction as failure', async () => {
  let clock = 0;
  const { client } = fixture({
    now: () => clock,
    receiptTimeoutMs: 10,
    pollIntervalMs: 5,
    sleep: async delay => {
      clock += delay;
    },
  });
  client.getTransaction = async () => ({ transaction: unsignedTransaction(), info: null, confirmed: false });

  await assert.rejects(
    () => client.waitForReceipt('cd'.repeat(32), { sourceTransactionHash: `0x${'ab'.repeat(32)}` }),
    /timed out/i,
  );
});
