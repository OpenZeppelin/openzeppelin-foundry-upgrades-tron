'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AbiCoder, Interface, getAddress, zeroPadValue } = require('ethers');

const { rewriteAbiValues, rewriteCall, rewriteCalldata, rewriteDeployment } = require('../rewriter.cjs');

const PREDICTED_IMPLEMENTATION = getAddress(`0x${'11'.repeat(20)}`);
const ACTUAL_IMPLEMENTATION = getAddress(`0x${'a1'.repeat(20)}`);
const PREDICTED_OWNER = getAddress(`0x${'22'.repeat(20)}`);
const ACTUAL_OWNER = getAddress(`0x${'a2'.repeat(20)}`);
const PREDICTED_PROXY = getAddress(`0x${'33'.repeat(20)}`);
const ACTUAL_PROXY = getAddress(`0x${'a3'.repeat(20)}`);
const PREDICTED_BEACON = getAddress(`0x${'44'.repeat(20)}`);
const ACTUAL_BEACON = getAddress(`0x${'a4'.repeat(20)}`);
const PREDICTED_LIBRARY = getAddress(`0x${'55'.repeat(20)}`);
const ACTUAL_LIBRARY = getAddress(`0x${'a5'.repeat(20)}`);
const UNMAPPED = getAddress(`0x${'66'.repeat(20)}`);

const records = [
  [PREDICTED_IMPLEMENTATION, ACTUAL_IMPLEMENTATION],
  [PREDICTED_OWNER, ACTUAL_OWNER],
  [PREDICTED_PROXY, ACTUAL_PROXY],
  [PREDICTED_BEACON, ACTUAL_BEACON],
  [PREDICTED_LIBRARY, ACTUAL_LIBRARY],
].map(([predicted, actual]) => ({ predicted: predicted.toLowerCase(), actual: actual.toLowerCase() }));

function fakeAddressMap() {
  return {
    toActual(address) {
      const normalized = address.toLowerCase();
      return records.find(record => record.predicted === normalized)?.actual;
    },
    resolveActual(address) {
      const normalized = address.toLowerCase();
      return records.find(record => record.actual === normalized);
    },
    list() {
      return structuredClone(records);
    },
  };
}

const initializerAbi = [
  'function initialize(address owner,address[][] peers,(address target,(address nested) child) config,(address,uint256)[][2] matrix,bytes32 marker)',
];

function dependencies(overrides = {}) {
  return {
    addressMap: fakeAddressMap(),
    async resolveArtifact(address) {
      if ([PREDICTED_IMPLEMENTATION, ACTUAL_IMPLEMENTATION].includes(getAddress(address))) {
        return { abi: initializerAbi, fullyQualifiedName: 'contracts/Implementation.sol:Implementation' };
      }
      return undefined;
    },
    async resolveBeaconImplementation(address) {
      if (getAddress(address) === ACTUAL_BEACON) return ACTUAL_IMPLEMENTATION;
      return undefined;
    },
    ...overrides,
  };
}

function initializerData({ owner = PREDICTED_OWNER, marker = zeroPadValue(PREDICTED_OWNER, 32) } = {}) {
  return new Interface(initializerAbi).encodeFunctionData('initialize', [
    owner,
    [[PREDICTED_PROXY, ACTUAL_PROXY], [UNMAPPED]],
    [PREDICTED_BEACON, [PREDICTED_OWNER]],
    [
      [
        [PREDICTED_IMPLEMENTATION, 1],
        [ACTUAL_OWNER, 2],
      ],
      [[UNMAPPED, 3]],
    ],
    marker,
  ]);
}

function assertInitializerRewritten(data, expectedOwner = ACTUAL_OWNER) {
  const decoded = new Interface(initializerAbi).decodeFunctionData('initialize', data);
  assert.equal(decoded.owner, expectedOwner);
  assert.equal(decoded.peers[0][0], ACTUAL_PROXY);
  assert.equal(decoded.peers[0][1], ACTUAL_PROXY);
  assert.equal(decoded.peers[1][0], UNMAPPED);
  assert.equal(decoded.config.target, ACTUAL_BEACON);
  assert.equal(decoded.config.child.nested, ACTUAL_OWNER);
  assert.equal(decoded.matrix[0][0].at(0), ACTUAL_IMPLEMENTATION);
  assert.equal(decoded.matrix[0][1].at(0), ACTUAL_OWNER);
  assert.equal(decoded.matrix[1][0].at(0), UNMAPPED);
  assert.equal(decoded.marker, zeroPadValue(PREDICTED_OWNER, 32));
}

function constructorMatch({ fullyQualifiedName, inputs, values, creationBytecode = '0x60006000', artifact = {} }) {
  return {
    fullyQualifiedName,
    abi: [{ type: 'constructor', inputs }],
    artifact: { abi: [{ type: 'constructor', inputs }], ...artifact },
    creationBytecode,
    constructorData: AbiCoder.defaultAbiCoder().encode(inputs, values),
    requiresLinking: false,
  };
}

test('recursively rewrites direct, multidimensional, fixed-array, and tuple addresses', async () => {
  const parameters = [
    { type: 'address' },
    { type: 'address[][]' },
    {
      type: 'tuple[2]',
      components: [
        { name: 'owner', type: 'address' },
        { name: 'members', type: 'address[]' },
      ],
    },
  ];
  const values = [
    PREDICTED_OWNER,
    [[PREDICTED_PROXY, ACTUAL_PROXY], [UNMAPPED]],
    [
      [PREDICTED_OWNER, [PREDICTED_IMPLEMENTATION]],
      [ACTUAL_OWNER, [UNMAPPED]],
    ],
  ];

  const rewritten = await rewriteAbiValues(parameters, values, dependencies());

  assert.deepEqual(rewritten, [
    ACTUAL_OWNER.toLowerCase(),
    [[ACTUAL_PROXY.toLowerCase(), ACTUAL_PROXY], [UNMAPPED]],
    [
      [ACTUAL_OWNER.toLowerCase(), [ACTUAL_IMPLEMENTATION.toLowerCase()]],
      [ACTUAL_OWNER, [UNMAPPED]],
    ],
  ]);
});

test('rewrites ABI calldata but preserves bytes32 values that look like ABI addresses', async () => {
  const abi = ['function configure(address target,address[] peers,bytes32 marker)'];
  const iface = new Interface(abi);
  const marker = zeroPadValue(PREDICTED_OWNER, 32);
  const original = iface.encodeFunctionData('configure', [PREDICTED_PROXY, [PREDICTED_OWNER], marker]);

  const rewritten = await rewriteCalldata(original, abi, dependencies());
  const decoded = iface.decodeFunctionData('configure', rewritten);

  assert.equal(decoded.target, ACTUAL_PROXY);
  assert.equal(decoded.peers[0], ACTUAL_OWNER);
  assert.equal(decoded.marker, marker);
});

test('rejects malformed calldata instead of guessing a selector', async () => {
  await assert.rejects(
    rewriteCalldata('0x12345678deadbeef', ['function configure(address target)'], dependencies()),
    /calldata|decode/i,
  );
});

test('rejects otherwise-decodable calldata with trailing bytes', async () => {
  const abi = ['function configure(address target)'];
  const canonical = new Interface(abi).encodeFunctionData('configure', [PREDICTED_OWNER]);
  await assert.rejects(rewriteCalldata(`${canonical}deadbeef`, abi, dependencies()), /calldata|canonical|decode/i);
});

for (const proxy of [
  {
    name: 'TRC1967 proxy',
    fullyQualifiedName: 'openzeppelin-tron-solidity/contracts/proxy/TRC1967/TRC1967Proxy.sol:TRC1967Proxy',
    inputs: [
      { name: 'implementation', type: 'address' },
      { name: '_data', type: 'bytes' },
    ],
    values: [PREDICTED_IMPLEMENTATION, initializerData()],
    dataIndex: 1,
  },
  {
    name: 'transparent proxy',
    fullyQualifiedName:
      'openzeppelin-tron-solidity/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy',
    inputs: [
      { name: '_logic', type: 'address' },
      { name: 'initialOwner', type: 'address' },
      { name: '_data', type: 'bytes' },
    ],
    values: [PREDICTED_IMPLEMENTATION, PREDICTED_OWNER, initializerData()],
    dataIndex: 2,
  },
]) {
  test(`rewrites the canonical ${proxy.name} constructor and its initializer`, async () => {
    const match = constructorMatch(proxy);
    const rewritten = await rewriteDeployment(match, dependencies());
    const decoded = AbiCoder.defaultAbiCoder().decode(
      proxy.inputs.map(input => input.type),
      rewritten.constructorData,
    );

    assert.equal(decoded[0], ACTUAL_IMPLEMENTATION);
    if (proxy.dataIndex === 2) assert.equal(decoded[1], ACTUAL_OWNER);
    assertInitializerRewritten(decoded[proxy.dataIndex]);
    assert.equal(rewritten.initcode, `${rewritten.creationBytecode}${rewritten.constructorData.slice(2)}`);
  });
}

test('recognizes the canonical Forge lib-prefixed TRC1967 artifact identity', async () => {
  const match = constructorMatch({
    fullyQualifiedName: 'lib/openzeppelin-tron-solidity/contracts/proxy/TRC1967/TRC1967Proxy.sol:TRC1967Proxy',
    inputs: [
      { name: 'implementation', type: 'address' },
      { name: '_data', type: 'bytes' },
    ],
    values: [PREDICTED_IMPLEMENTATION, initializerData()],
  });
  const rewritten = await rewriteDeployment(match, dependencies());
  const decoded = AbiCoder.defaultAbiCoder().decode(['address', 'bytes'], rewritten.constructorData);
  assert.equal(decoded[0], ACTUAL_IMPLEMENTATION);
  assertInitializerRewritten(decoded[1]);
});

test('rewrites the canonical beacon constructor and BeaconProxy initializer', async () => {
  const beacon = constructorMatch({
    fullyQualifiedName: 'openzeppelin-tron-solidity/contracts/proxy/beacon/UpgradeableBeacon.sol:UpgradeableBeacon',
    inputs: [
      { name: 'implementation_', type: 'address' },
      { name: 'initialOwner', type: 'address' },
    ],
    values: [PREDICTED_IMPLEMENTATION, PREDICTED_OWNER],
  });
  const rewrittenBeacon = await rewriteDeployment(beacon, dependencies());
  const beaconArgs = AbiCoder.defaultAbiCoder().decode(['address', 'address'], rewrittenBeacon.constructorData);
  assert.deepEqual(beaconArgs.toArray(), [ACTUAL_IMPLEMENTATION, ACTUAL_OWNER]);

  const proxy = constructorMatch({
    fullyQualifiedName: 'openzeppelin-tron-solidity/contracts/proxy/beacon/BeaconProxy.sol:BeaconProxy',
    inputs: [
      { name: 'beacon', type: 'address' },
      { name: 'data', type: 'bytes' },
    ],
    values: [PREDICTED_BEACON, initializerData()],
  });
  const rewrittenProxy = await rewriteDeployment(proxy, dependencies());
  const proxyArgs = AbiCoder.defaultAbiCoder().decode(['address', 'bytes'], rewrittenProxy.constructorData);
  assert.equal(proxyArgs[0], ACTUAL_BEACON);
  assertInitializerRewritten(proxyArgs[1]);
});

test('resolves BeaconProxy metadata through mapped actual beacon and implementation addresses', async () => {
  const seen = { beacon: undefined, implementation: undefined };
  const deps = dependencies({
    async resolveBeaconImplementation(address) {
      seen.beacon = address;
      return ACTUAL_IMPLEMENTATION;
    },
    async resolveArtifact(address) {
      seen.implementation = address;
      return { abi: initializerAbi, fullyQualifiedName: 'contracts/Implementation.sol:Implementation' };
    },
  });
  const proxy = constructorMatch({
    fullyQualifiedName: 'openzeppelin-tron-solidity/contracts/proxy/beacon/BeaconProxy.sol:BeaconProxy',
    inputs: [
      { name: 'beacon', type: 'address' },
      { name: 'data', type: 'bytes' },
    ],
    values: [PREDICTED_BEACON, initializerData()],
  });

  await rewriteDeployment(proxy, deps);

  assert.equal(seen.beacon, ACTUAL_BEACON.toLowerCase());
  assert.equal(seen.implementation, ACTUAL_IMPLEMENTATION);
});

test('rejects a BeaconProxy implementation resolver result that is not an address string', async () => {
  const proxy = constructorMatch({
    fullyQualifiedName: 'openzeppelin-tron-solidity/contracts/proxy/beacon/BeaconProxy.sol:BeaconProxy',
    inputs: [
      { name: 'beacon', type: 'address' },
      { name: 'data', type: 'bytes' },
    ],
    values: [PREDICTED_BEACON, initializerData()],
  });

  await assert.rejects(
    rewriteDeployment(
      proxy,
      dependencies({ resolveBeaconImplementation: async () => ({ address: ACTUAL_IMPLEMENTATION }) }),
    ),
    /beacon implementation.*address|string.*address/i,
  );
});

test('rewrites generic constructor addresses recursively', async () => {
  const match = constructorMatch({
    fullyQualifiedName: 'contracts/Widget.sol:Widget',
    inputs: [
      { name: 'owners', type: 'address[]' },
      {
        name: 'config',
        type: 'tuple',
        components: [{ name: 'target', type: 'address' }],
      },
    ],
    values: [[PREDICTED_OWNER, UNMAPPED], [PREDICTED_PROXY]],
  });

  const rewritten = await rewriteDeployment(match, dependencies());
  const decoded = AbiCoder.defaultAbiCoder().decode(['address[]', 'tuple(address)'], rewritten.constructorData);
  assert.equal(decoded[0][0], ACTUAL_OWNER);
  assert.equal(decoded[0][1], UNMAPPED);
  assert.equal(decoded[1][0], ACTUAL_PROXY);
});

test('requires canonical proxy metadata and constructor shape before nested decoding', async () => {
  const badShape = constructorMatch({
    fullyQualifiedName: 'openzeppelin-tron-solidity/contracts/proxy/TRC1967/TRC1967Proxy.sol:TRC1967Proxy',
    inputs: [
      { name: 'implementation', type: 'address' },
      { name: '_data', type: 'bytes32' },
    ],
    values: [PREDICTED_IMPLEMENTATION, zeroPadValue(PREDICTED_OWNER, 32)],
  });
  await assert.rejects(rewriteDeployment(badShape, dependencies()), /canonical|constructor.*shape/i);

  const impostor = constructorMatch({
    fullyQualifiedName: 'contracts/TRC1967Proxy.sol:TRC1967Proxy',
    inputs: [
      { name: 'implementation', type: 'address' },
      { name: '_data', type: 'bytes' },
    ],
    values: [PREDICTED_IMPLEMENTATION, '0x1234'],
  });
  const rewritten = await rewriteDeployment(impostor, dependencies());
  const decoded = AbiCoder.defaultAbiCoder().decode(['address', 'bytes'], rewritten.constructorData);
  assert.equal(decoded[0], ACTUAL_IMPLEMENTATION);
  assert.equal(decoded[1], '0x1234');
});

test('rejects malformed constructor data before returning initcode', async () => {
  const match = constructorMatch({
    fullyQualifiedName: 'contracts/Widget.sol:Widget',
    inputs: [{ name: 'owner', type: 'address' }],
    values: [PREDICTED_OWNER],
  });
  match.constructorData = '0x1234';
  await assert.rejects(rewriteDeployment(match, dependencies()), /constructor|decode/i);
});

test('rewrites UUPS upgrade calls only for a verified UUPS target kind', async () => {
  const iface = new Interface([
    'function upgradeTo(address newImplementation)',
    'function upgradeToAndCall(address newImplementation,bytes data)',
  ]);
  const base = { to: PREDICTED_PROXY, kind: 'call', value: 0n };

  const upgrade = await rewriteCall(
    { ...base, data: iface.encodeFunctionData('upgradeTo', [PREDICTED_IMPLEMENTATION]) },
    { targetKind: 'uups-proxy' },
    dependencies(),
  );
  assert.equal(upgrade.to, ACTUAL_PROXY.toLowerCase());
  assert.equal(iface.decodeFunctionData('upgradeTo', upgrade.data).newImplementation, ACTUAL_IMPLEMENTATION);

  const upgradeAndCall = await rewriteCall(
    {
      ...base,
      data: iface.encodeFunctionData('upgradeToAndCall', [PREDICTED_IMPLEMENTATION, initializerData()]),
    },
    { targetKind: 'uups-proxy' },
    dependencies(),
  );
  const decoded = iface.decodeFunctionData('upgradeToAndCall', upgradeAndCall.data);
  assert.equal(decoded.newImplementation, ACTUAL_IMPLEMENTATION);
  assertInitializerRewritten(decoded.data);
});

test('rejects noncanonical trailing bytes on a metadata-selected upgrade call', async () => {
  const iface = new Interface(['function upgradeTo(address newImplementation)']);
  const canonical = iface.encodeFunctionData('upgradeTo', [PREDICTED_IMPLEMENTATION]);
  await assert.rejects(
    rewriteCall(
      { to: PREDICTED_PROXY, kind: 'call', data: `${canonical}00` },
      { targetKind: 'uups-proxy' },
      dependencies(),
    ),
    /calldata|canonical|decode/i,
  );
});

test('rewrites ProxyAdmin upgrade calls and nested upgradeAndCall payloads', async () => {
  const iface = new Interface([
    'function upgrade(address proxy,address implementation)',
    'function upgradeAndCall(address proxy,address implementation,bytes data)',
  ]);
  const base = { to: PREDICTED_OWNER, kind: 'call', value: 0n };

  const upgrade = await rewriteCall(
    { ...base, data: iface.encodeFunctionData('upgrade', [PREDICTED_PROXY, PREDICTED_IMPLEMENTATION]) },
    { targetKind: 'proxy-admin' },
    dependencies(),
  );
  assert.deepEqual(iface.decodeFunctionData('upgrade', upgrade.data).toArray(), [ACTUAL_PROXY, ACTUAL_IMPLEMENTATION]);

  const withCall = await rewriteCall(
    {
      ...base,
      data: iface.encodeFunctionData('upgradeAndCall', [PREDICTED_PROXY, PREDICTED_IMPLEMENTATION, initializerData()]),
    },
    { targetKind: 'proxy-admin' },
    dependencies(),
  );
  const decoded = iface.decodeFunctionData('upgradeAndCall', withCall.data);
  assert.equal(decoded.proxy, ACTUAL_PROXY);
  assert.equal(decoded.implementation, ACTUAL_IMPLEMENTATION);
  assertInitializerRewritten(decoded.data);
});

test('rewrites UpgradeableBeacon upgradeTo with verified target metadata', async () => {
  const iface = new Interface(['function upgradeTo(address newImplementation)']);
  const rewritten = await rewriteCall(
    {
      to: PREDICTED_BEACON,
      kind: 'call',
      data: iface.encodeFunctionData('upgradeTo', [PREDICTED_IMPLEMENTATION]),
    },
    { targetKind: 'upgradeable-beacon' },
    dependencies(),
  );

  assert.equal(rewritten.to, ACTUAL_BEACON.toLowerCase());
  assert.equal(iface.decodeFunctionData('upgradeTo', rewritten.data).newImplementation, ACTUAL_IMPLEMENTATION);
});

test('does not infer proxy semantics from a matching selector alone', async () => {
  const abi = ['function upgradeToAndCall(address newImplementation,bytes data)'];
  const iface = new Interface(abi);
  let artifactLookups = 0;
  const deps = dependencies({
    async resolveArtifact() {
      artifactLookups += 1;
      return { abi: initializerAbi };
    },
  });
  const nested = new Interface(['function ping(uint256 value)']).encodeFunctionData('ping', [7]);
  const rewritten = await rewriteCall(
    {
      to: PREDICTED_PROXY,
      kind: 'call',
      data: iface.encodeFunctionData('upgradeToAndCall', [PREDICTED_IMPLEMENTATION, nested]),
    },
    { targetKind: 'contract', abi },
    deps,
  );
  const decoded = iface.decodeFunctionData('upgradeToAndCall', rewritten.data);

  assert.equal(decoded.newImplementation, ACTUAL_IMPLEMENTATION);
  assert.equal(decoded.data, nested);
  assert.equal(artifactLookups, 0);
});

for (const targetKind of ['transparent-proxy', 'beacon-proxy']) {
  test(`routes ordinary ${targetKind} calls through its verified implementation ABI`, async () => {
    const abi = ['function configure(address owner)'];
    const iface = new Interface(abi);
    const rewritten = await rewriteCall(
      {
        to: PREDICTED_PROXY,
        kind: 'call',
        data: iface.encodeFunctionData('configure', [PREDICTED_OWNER]),
      },
      { targetKind, abi },
      dependencies(),
    );

    assert.equal(iface.decodeFunctionData('configure', rewritten.data).owner, ACTUAL_OWNER);
  });
}

test('passes empty calldata only when receive or fallback is declared', async () => {
  for (const abi of [
    [{ type: 'receive', stateMutability: 'payable' }],
    [{ type: 'fallback', stateMutability: 'payable' }],
  ]) {
    const rewritten = await rewriteCall(
      { to: PREDICTED_PROXY, kind: 'call', data: '0x' },
      { targetKind: 'transparent-proxy', abi },
      dependencies(),
    );
    assert.equal(rewritten.data, '0x');
  }

  await assert.rejects(
    rewriteCall(
      { to: PREDICTED_PROXY, kind: 'call', data: '0x' },
      { targetKind: 'contract', abi: ['function ping()'] },
      dependencies(),
    ),
    /receive|fallback|calldata/i,
  );
});

test('passes an unknown selector only through a declared fallback after opaque safety scanning', async () => {
  const fallbackAbi = [{ type: 'fallback', stateMutability: 'payable' }];
  const safe = '0x12345678deadbeef';
  for (const targetKind of [
    'contract',
    'uups-proxy',
    'proxy-admin',
    'upgradeable-beacon',
    'transparent-proxy',
    'beacon-proxy',
  ]) {
    const rewritten = await rewriteCall(
      { to: PREDICTED_PROXY, kind: 'call', data: safe },
      { targetKind, abi: fallbackAbi },
      dependencies(),
    );
    assert.equal(rewritten.data, safe);
  }

  const unsafe = `0x12345678ff${zeroPadValue(PREDICTED_OWNER, 32).slice(2)}`;
  await assert.rejects(
    rewriteCall(
      { to: PREDICTED_PROXY, kind: 'call', data: unsafe },
      { targetKind: 'beacon-proxy', abi: fallbackAbi },
      dependencies(),
    ),
    error => error.code === 'OPAQUE_PREDICTED_ADDRESS',
  );

  await assert.rejects(
    rewriteCall(
      { to: PREDICTED_PROXY, kind: 'call', data: safe },
      { targetKind: 'contract', abi: [{ type: 'receive', stateMutability: 'payable' }] },
      dependencies(),
    ),
    /fallback|calldata/i,
  );
});

test('preserves opaque safe bytes and rejects undecodable bytes containing a mapped ABI word at any byte offset', async () => {
  const abi = ['function carry(bytes payload)'];
  const iface = new Interface(abi);
  const safe = iface.encodeFunctionData('carry', ['0x123456']);
  assert.equal(await rewriteCalldata(safe, abi, dependencies()), safe);

  const predictedWord = zeroPadValue(PREDICTED_OWNER, 32).slice(2);
  const unsafePayload = `0xff${predictedWord}00`;
  const unsafe = iface.encodeFunctionData('carry', [unsafePayload]);
  await assert.rejects(rewriteCalldata(unsafe, abi, dependencies()), /opaque|predicted|ABI word/i);
});

test('rejects undecodable canonical proxy initializer containing a mapped ABI word', async () => {
  const unsafeInitializer = `0xff${zeroPadValue(PREDICTED_OWNER, 32).slice(2)}`;
  const match = constructorMatch({
    fullyQualifiedName: 'openzeppelin-tron-solidity/contracts/proxy/TRC1967/TRC1967Proxy.sol:TRC1967Proxy',
    inputs: [
      { name: 'implementation', type: 'address' },
      { name: '_data', type: 'bytes' },
    ],
    values: [PREDICTED_IMPLEMENTATION, unsafeInitializer],
  });

  await assert.rejects(rewriteDeployment(match, dependencies()), /opaque|predicted|ABI word/i);
});

test('rejects canonical proxy nested payloads when implementation metadata is unavailable', async () => {
  const match = constructorMatch({
    fullyQualifiedName: 'openzeppelin-tron-solidity/contracts/proxy/TRC1967/TRC1967Proxy.sol:TRC1967Proxy',
    inputs: [
      { name: 'implementation', type: 'address' },
      { name: '_data', type: 'bytes' },
    ],
    values: [PREDICTED_IMPLEMENTATION, initializerData()],
  });

  await assert.rejects(
    rewriteDeployment(match, dependencies({ resolveArtifact: async () => undefined })),
    /artifact|metadata/i,
  );
});

test('reconciles one and repeated Forge linked-library ranges', async () => {
  const prefix = '6000';
  const middle = '6001';
  const suffix = '6002';
  const creationBytecode = `0x${prefix}${PREDICTED_LIBRARY.slice(2)}${middle}${PREDICTED_LIBRARY.slice(2)}${suffix}`;
  const match = constructorMatch({
    fullyQualifiedName: 'contracts/Linked.sol:Linked',
    inputs: [],
    values: [],
    creationBytecode,
    artifact: {
      bytecode: {
        object: `0x${prefix}__$${'1'.repeat(34)}$__${middle}__$${'1'.repeat(34)}$__${suffix}`,
        linkReferences: {
          'contracts/Math.sol': {
            Math: [
              { start: 2, length: 20 },
              { start: 24, length: 20 },
            ],
          },
        },
      },
    },
  });
  match.requiresLinking = true;

  const rewritten = await rewriteDeployment(match, dependencies());
  assert.equal(
    rewritten.creationBytecode,
    `0x${prefix}${ACTUAL_LIBRARY.slice(2).toLowerCase()}${middle}${ACTUAL_LIBRARY.slice(2).toLowerCase()}${suffix}`,
  );
});

test('reconciles HH3 top-level linked ranges and preserves already-actual addresses', async () => {
  const creationBytecode = `0x6000${ACTUAL_LIBRARY.slice(2)}6001`;
  const match = constructorMatch({
    fullyQualifiedName: 'contracts/Linked.sol:Linked',
    inputs: [],
    values: [],
    creationBytecode,
    artifact: {
      bytecode: `0x6000__$${'2'.repeat(34)}$__6001`,
      linkReferences: { 'contracts/Math.sol': { Math: [{ start: 2, length: 20 }] } },
    },
  });
  match.requiresLinking = true;

  const rewritten = await rewriteDeployment(match, dependencies());
  assert.equal(rewritten.creationBytecode, creationBytecode.toLowerCase());
});

test('rejects unresolved or malformed linked-library ranges', async t => {
  await t.test('unresolved concrete address', async () => {
    const match = constructorMatch({
      fullyQualifiedName: 'contracts/Linked.sol:Linked',
      inputs: [],
      values: [],
      creationBytecode: `0x6000${UNMAPPED.slice(2)}6001`,
      artifact: {
        bytecode: {
          object: `0x6000__$${'3'.repeat(34)}$__6001`,
          linkReferences: { 'contracts/Math.sol': { Math: [{ start: 2, length: 20 }] } },
        },
      },
    });
    match.requiresLinking = true;
    await assert.rejects(rewriteDeployment(match, dependencies()), /linked library|unresolved/i);
  });

  await t.test('non-20-byte range', async () => {
    const match = constructorMatch({
      fullyQualifiedName: 'contracts/Linked.sol:Linked',
      inputs: [],
      values: [],
      creationBytecode: `0x6000${PREDICTED_LIBRARY.slice(2)}6001`,
      artifact: {
        bytecode: {
          object: `0x6000__$${'4'.repeat(34)}$__6001`,
          linkReferences: { 'contracts/Math.sol': { Math: [{ start: 2, length: 19 }] } },
        },
      },
    });
    match.requiresLinking = true;
    await assert.rejects(rewriteDeployment(match, dependencies()), /link.*range|20-byte/i);
  });

  await t.test('start plus length arithmetic overflow', async () => {
    const match = constructorMatch({
      fullyQualifiedName: 'contracts/Linked.sol:Linked',
      inputs: [],
      values: [],
      creationBytecode: `0x6000${PREDICTED_LIBRARY.slice(2)}6001`,
      artifact: {
        bytecode: {
          object: `0x6000__$${'5'.repeat(34)}$__6001`,
          linkReferences: {
            'contracts/Math.sol': { Math: [{ start: Number.MAX_SAFE_INTEGER - 10, length: 20 }] },
          },
        },
      },
    });
    match.requiresLinking = true;
    await assert.rejects(rewriteDeployment(match, dependencies()), /safe range|integer overflow/i);
  });
});
