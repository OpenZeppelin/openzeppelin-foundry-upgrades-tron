'use strict';

const { AbiCoder, Interface, ParamType, getAddress } = require('ethers');

const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const ABI_ADDRESS_WORD_PREFIX = '0'.repeat(24);

const PROXY_CONSTRUCTORS = Object.freeze({
  'openzeppelin-tron-solidity/contracts/proxy/TRC1967/TRC1967Proxy.sol:TRC1967Proxy': {
    kind: 'trc1967-proxy',
    types: ['address', 'bytes'],
  },
  'openzeppelin-tron-solidity/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy':
    {
      kind: 'transparent-proxy',
      types: ['address', 'address', 'bytes'],
    },
  'openzeppelin-tron-solidity/contracts/proxy/beacon/UpgradeableBeacon.sol:UpgradeableBeacon': {
    kind: 'upgradeable-beacon',
    types: ['address', 'address'],
  },
  'openzeppelin-tron-solidity/contracts/proxy/beacon/BeaconProxy.sol:BeaconProxy': {
    kind: 'beacon-proxy',
    types: ['address', 'bytes'],
  },
});

const UUPS_INTERFACE = new Interface([
  'function upgradeTo(address newImplementation)',
  'function upgradeToAndCall(address newImplementation,bytes data)',
]);
const PROXY_ADMIN_INTERFACE = new Interface([
  'function upgrade(address proxy,address implementation)',
  'function upgradeAndCall(address proxy,address implementation,bytes data)',
]);
const BEACON_INTERFACE = new Interface(['function upgradeTo(address newImplementation)']);

class RewriteError extends Error {
  constructor(code, message, details = {}, options) {
    super(message, options);
    this.name = 'RewriteError';
    this.code = code;
    this.details = details;
  }
}

function requireDependencies(deps) {
  if (deps === null || typeof deps !== 'object' || deps.addressMap === null || typeof deps.addressMap !== 'object') {
    throw new RewriteError('INVALID_DEPENDENCIES', 'Address rewrite dependencies require an addressMap');
  }
  if (
    typeof deps.addressMap.toActual !== 'function' ||
    typeof deps.addressMap.resolveActual !== 'function' ||
    typeof deps.addressMap.list !== 'function'
  ) {
    throw new RewriteError('INVALID_DEPENDENCIES', 'Address map does not expose the required lookup API');
  }
  return deps;
}

function requireBytes(value, field) {
  if (typeof value !== 'string' || !HEX_BYTES.test(value)) {
    throw new RewriteError('INVALID_BYTES', `${field} must be even-length hexadecimal bytes`);
  }
  return value;
}

async function mapAddress(address, deps) {
  requireDependencies(deps);
  try {
    getAddress(address);
  } catch (error) {
    throw new RewriteError('INVALID_ADDRESS', 'ABI address value is invalid', { address }, { cause: error });
  }
  const mapped = await deps.addressMap.toActual(address);
  if (mapped !== undefined) return mapped;
  const actual = await deps.addressMap.resolveActual(address);
  return actual === undefined ? address : address;
}

async function predictedAddressWords(deps) {
  requireDependencies(deps);
  const records = await deps.addressMap.list();
  if (!Array.isArray(records)) {
    throw new RewriteError('INVALID_DEPENDENCIES', 'Address map list must return an array');
  }
  return records.map(record => {
    if (record === null || typeof record !== 'object') {
      throw new RewriteError('INVALID_DEPENDENCIES', 'Address map contains an invalid mapping record');
    }
    let predicted;
    try {
      predicted = getAddress(record.predicted).slice(2).toLowerCase();
    } catch (error) {
      throw new RewriteError(
        'INVALID_DEPENDENCIES',
        'Address map contains an invalid predicted address',
        {},
        { cause: error },
      );
    }
    return `${ABI_ADDRESS_WORD_PREFIX}${predicted}`;
  });
}

async function assertOpaqueBytesSafe(value, deps) {
  const bytes = requireBytes(value, 'Opaque payload').slice(2).toLowerCase();
  for (const word of await predictedAddressWords(deps)) {
    let offset = bytes.indexOf(word);
    while (offset !== -1) {
      if (offset % 2 === 0) {
        throw new RewriteError(
          'OPAQUE_PREDICTED_ADDRESS',
          'Opaque bytes contain a known predicted address in a complete ABI word',
          { byteOffset: offset / 2 },
        );
      }
      offset = bytes.indexOf(word, offset + 1);
    }
  }
  return value;
}

async function rewriteParam(param, value, deps) {
  if (param.baseType === 'address') return mapAddress(value, deps);

  if (param.baseType === 'array') {
    if (!Array.isArray(value)) {
      throw new RewriteError('INVALID_ABI_VALUE', `Expected an array for ${param.format('sighash')}`);
    }
    return Promise.all(value.map(item => rewriteParam(param.arrayChildren, item, deps)));
  }

  if (param.baseType === 'tuple') {
    if (Array.isArray(value)) {
      if (value.length !== param.components.length) {
        throw new RewriteError('INVALID_ABI_VALUE', `Tuple value length does not match ${param.format('sighash')}`);
      }
      return Promise.all(param.components.map((component, index) => rewriteParam(component, value[index], deps)));
    }
    if (value !== null && typeof value === 'object') {
      const rewritten = { ...value };
      for (const component of param.components) {
        if (!component.name || !(component.name in value)) {
          throw new RewriteError(
            'INVALID_ABI_VALUE',
            `Tuple value is missing component ${component.name || '<unnamed>'}`,
          );
        }
        rewritten[component.name] = await rewriteParam(component, value[component.name], deps);
      }
      return rewritten;
    }
    throw new RewriteError('INVALID_ABI_VALUE', `Expected a tuple for ${param.format('sighash')}`);
  }

  if (param.baseType === 'bytes') return assertOpaqueBytesSafe(value, deps);
  return value;
}

async function rewriteAbiValues(parameters, values, deps) {
  requireDependencies(deps);
  if (!Array.isArray(parameters) || !Array.isArray(values) || parameters.length !== values.length) {
    throw new RewriteError('INVALID_ABI_VALUES', 'ABI parameters and values must be equal-length arrays');
  }
  const params = parameters.map(parameter => ParamType.from(parameter));
  return Promise.all(params.map((param, index) => rewriteParam(param, values[index], deps)));
}

function decodeCalldata(data, abi) {
  requireBytes(data, 'Calldata');
  if (!Array.isArray(abi)) throw new RewriteError('INVALID_ABI', 'Contract ABI must be an array');
  let iface;
  let parsed;
  try {
    iface = new Interface(abi);
    parsed = iface.parseTransaction({ data });
  } catch (error) {
    throw new RewriteError(
      'UNDECODABLE_CALLDATA',
      'Calldata cannot be decoded with the selected ABI',
      {},
      { cause: error },
    );
  }
  if (parsed === null) {
    throw new RewriteError('UNDECODABLE_CALLDATA', 'Calldata cannot be decoded with the selected ABI');
  }
  if (iface.encodeFunctionData(parsed.fragment, parsed.args).toLowerCase() !== data.toLowerCase()) {
    throw new RewriteError('UNDECODABLE_CALLDATA', 'Calldata is not canonically encoded for the selected ABI');
  }
  return { iface, parsed };
}

async function rewriteCalldata(data, abi, deps) {
  const { iface, parsed } = decodeCalldata(data, abi);
  const values = await rewriteAbiValues(parsed.fragment.inputs, parsed.args.toArray(), deps);
  return iface.encodeFunctionData(parsed.fragment, values);
}

function artifactAbi(artifactResult) {
  const abi = artifactResult?.abi ?? artifactResult?.artifact?.abi;
  return Array.isArray(abi) ? abi : undefined;
}

async function rewriteNestedPayload(payload, implementationAddress, deps) {
  requireBytes(payload, 'Nested payload');
  if (payload === '0x') return payload;
  if (typeof deps.resolveArtifact !== 'function') {
    throw new RewriteError('MISSING_ARTIFACT_METADATA', 'Implementation artifact metadata resolver is required');
  }
  const artifact = await deps.resolveArtifact(implementationAddress);
  const abi = artifactAbi(artifact);
  if (abi === undefined) {
    throw new RewriteError('MISSING_ARTIFACT_METADATA', 'Implementation artifact metadata is unavailable', {
      implementationAddress,
    });
  }
  try {
    return await rewriteCalldata(payload, abi, deps);
  } catch (error) {
    if (!(error instanceof RewriteError) || error.code !== 'UNDECODABLE_CALLDATA') throw error;
    await assertOpaqueBytesSafe(payload, deps);
    return payload;
  }
}

function constructorDefinition(match) {
  const abi = match?.abi ?? match?.artifact?.abi;
  if (!Array.isArray(abi)) throw new RewriteError('INVALID_ARTIFACT', 'Deployment artifact ABI is unavailable');
  const constructors = abi.filter(entry => entry?.type === 'constructor');
  if (constructors.length > 1) {
    throw new RewriteError('INVALID_ARTIFACT', 'Deployment artifact has multiple constructors');
  }
  return constructors[0] ?? { type: 'constructor', inputs: [] };
}

function decodeConstructor(match, constructor) {
  const data = requireBytes(match.constructorData, 'Constructor data');
  const inputs = Array.isArray(constructor.inputs) ? constructor.inputs : [];
  const types = inputs.map(input => ParamType.from(input));
  let decoded;
  try {
    decoded = AbiCoder.defaultAbiCoder().decode(types, data);
    const canonical = AbiCoder.defaultAbiCoder().encode(types, decoded);
    if (canonical.toLowerCase() !== data.toLowerCase()) throw new Error('Noncanonical constructor encoding');
  } catch (error) {
    throw new RewriteError(
      'UNDECODABLE_CONSTRUCTOR',
      'Constructor data cannot be decoded canonically',
      {},
      { cause: error },
    );
  }
  return { inputs, values: decoded.toArray() };
}

function requireCanonicalShape(metadata, inputs) {
  const actual = inputs.map(input => ParamType.from(input).format('sighash'));
  if (actual.length !== metadata.types.length || actual.some((type, index) => type !== metadata.types[index])) {
    throw new RewriteError(
      'INVALID_PROXY_CONSTRUCTOR',
      'Canonical proxy constructor shape does not match its metadata',
    );
  }
}

async function rewriteConstructorValues(match, inputs, values, deps) {
  const canonicalName =
    typeof match.fullyQualifiedName === 'string' && match.fullyQualifiedName.startsWith('lib/')
      ? match.fullyQualifiedName.slice(4)
      : match.fullyQualifiedName;
  const metadata = PROXY_CONSTRUCTORS[canonicalName];
  if (metadata === undefined) return rewriteAbiValues(inputs, values, deps);
  requireCanonicalShape(metadata, inputs);

  switch (metadata.kind) {
    case 'trc1967-proxy':
      return [await mapAddress(values[0], deps), await rewriteNestedPayload(values[1], values[0], deps)];
    case 'transparent-proxy':
      return [
        await mapAddress(values[0], deps),
        await mapAddress(values[1], deps),
        await rewriteNestedPayload(values[2], values[0], deps),
      ];
    case 'upgradeable-beacon':
      return [await mapAddress(values[0], deps), await mapAddress(values[1], deps)];
    case 'beacon-proxy': {
      const actualBeacon = await mapAddress(values[0], deps);
      if (values[1] === '0x') return [actualBeacon, values[1]];
      if (typeof deps.resolveBeaconImplementation !== 'function') {
        throw new RewriteError('MISSING_BEACON_METADATA', 'Beacon implementation resolver is required');
      }
      // Dependency contract: resolveBeaconImplementation receives the mapped
      // actual beacon and returns its actual implementation as an EVM address string.
      const implementation = await deps.resolveBeaconImplementation(actualBeacon);
      if (implementation === undefined) {
        throw new RewriteError('MISSING_BEACON_METADATA', 'Beacon implementation metadata is unavailable');
      }
      if (typeof implementation !== 'string') {
        throw new RewriteError(
          'INVALID_BEACON_METADATA',
          'Beacon implementation resolver must return an address string',
        );
      }
      try {
        getAddress(implementation);
      } catch (error) {
        throw new RewriteError(
          'INVALID_BEACON_METADATA',
          'Beacon implementation resolver returned an invalid address string',
          {},
          { cause: error },
        );
      }
      return [actualBeacon, await rewriteNestedPayload(values[1], implementation, deps)];
    }
    default:
      throw new RewriteError('INVALID_PROXY_METADATA', 'Unsupported canonical proxy metadata');
  }
}

function linkReferences(artifact) {
  if (typeof artifact?.bytecode === 'string') return artifact.linkReferences;
  return artifact?.bytecode?.linkReferences;
}

function templateBytecode(artifact) {
  return typeof artifact?.bytecode === 'string' ? artifact.bytecode : artifact?.bytecode?.object;
}

function flattenLinkRanges(references) {
  if (references === null || typeof references !== 'object' || Array.isArray(references)) {
    throw new RewriteError('INVALID_LINK_RANGES', 'Linked artifact is missing validated link ranges');
  }
  const ranges = [];
  for (const libraries of Object.values(references)) {
    if (libraries === null || typeof libraries !== 'object' || Array.isArray(libraries)) {
      throw new RewriteError('INVALID_LINK_RANGES', 'Linked artifact contains invalid source link ranges');
    }
    for (const entries of Object.values(libraries)) {
      if (!Array.isArray(entries)) {
        throw new RewriteError('INVALID_LINK_RANGES', 'Linked artifact contains invalid library link ranges');
      }
      for (const entry of entries) {
        if (
          entry === null ||
          typeof entry !== 'object' ||
          !Number.isSafeInteger(entry.start) ||
          entry.start < 0 ||
          entry.length !== 20 ||
          !Number.isSafeInteger(entry.start + entry.length)
        ) {
          throw new RewriteError('INVALID_LINK_RANGES', 'Every linked-library range must be a 20-byte safe range');
        }
        ranges.push({ start: entry.start, end: entry.start + entry.length });
      }
    }
  }
  ranges.sort((left, right) => left.start - right.start);
  if (ranges.length === 0)
    throw new RewriteError('INVALID_LINK_RANGES', 'Linked artifact has no linked-library ranges');
  return ranges;
}

async function rewriteLinkedLibraries(match, deps) {
  const creation = requireBytes(match.creationBytecode, 'Creation bytecode').slice(2).toLowerCase();
  if (!match.requiresLinking) return `0x${creation}`;

  const artifact = match.artifact;
  const template = templateBytecode(artifact);
  if (typeof template !== 'string') {
    throw new RewriteError('INVALID_LINK_RANGES', 'Linked artifact template bytecode is unavailable');
  }
  const templateHex = template.replace(/^0x/i, '');
  const ranges = flattenLinkRanges(linkReferences(artifact));
  let previousEnd = 0;
  let rewritten = creation;
  for (const range of ranges) {
    if (range.start < previousEnd || range.end * 2 > creation.length || range.end * 2 > templateHex.length) {
      throw new RewriteError('INVALID_LINK_RANGES', 'Linked-library ranges overlap or exceed creation bytecode');
    }
    const templateSegment = templateHex.slice(range.start * 2, range.end * 2);
    if (!/^__\$[0-9a-fA-F]{34}\$__$/.test(templateSegment)) {
      throw new RewriteError('INVALID_LINK_RANGES', 'Linked-library range does not cover a canonical placeholder');
    }
    const start = range.start * 2;
    const end = range.end * 2;
    const concrete = `0x${creation.slice(start, end)}`;
    const mapped = await deps.addressMap.toActual(concrete);
    if (mapped !== undefined) {
      rewritten = `${rewritten.slice(0, start)}${getAddress(mapped).slice(2).toLowerCase()}${rewritten.slice(end)}`;
    } else if ((await deps.addressMap.resolveActual(concrete)) === undefined) {
      throw new RewriteError('UNRESOLVED_LINKED_LIBRARY', 'Linked library address is unresolved', {
        address: concrete,
      });
    }
    previousEnd = range.end;
  }
  return `0x${rewritten}`;
}

async function rewriteDeployment(match, deps) {
  requireDependencies(deps);
  if (match === null || typeof match !== 'object') {
    throw new RewriteError('INVALID_DEPLOYMENT', 'Verified deployment match is required');
  }
  const constructor = constructorDefinition(match);
  const { inputs, values } = decodeConstructor(match, constructor);
  const rewrittenValues = await rewriteConstructorValues(match, inputs, values, deps);
  const constructorData = AbiCoder.defaultAbiCoder().encode(
    inputs.map(input => ParamType.from(input)),
    rewrittenValues,
  );
  const creationBytecode = await rewriteLinkedLibraries(match, deps);
  return {
    ...match,
    creationBytecode,
    constructorData,
    initcode: `${creationBytecode}${constructorData.slice(2)}`,
  };
}

function selectedFunction(iface, data) {
  requireBytes(data, 'Calldata');
  if (data.length < 10) return undefined;
  try {
    return iface.getFunction(data.slice(0, 10)) ?? undefined;
  } catch {
    return undefined;
  }
}

function decodeCanonicalFunction(iface, functionFragment, data) {
  let decoded;
  try {
    decoded = iface.decodeFunctionData(functionFragment, data);
    if (iface.encodeFunctionData(functionFragment, decoded).toLowerCase() !== data.toLowerCase()) {
      throw new Error('Noncanonical function data');
    }
  } catch (error) {
    throw new RewriteError('UNDECODABLE_CALLDATA', 'Upgrade calldata is not canonically encoded', {}, { cause: error });
  }
  return decoded;
}

async function rewriteUupsCall(data, deps) {
  const functionFragment = selectedFunction(UUPS_INTERFACE, data);
  if (functionFragment === undefined) return undefined;
  const decoded = decodeCanonicalFunction(UUPS_INTERFACE, functionFragment, data);
  const implementation = decoded.newImplementation;
  if (functionFragment.name === 'upgradeTo') {
    return UUPS_INTERFACE.encodeFunctionData(functionFragment, [await mapAddress(implementation, deps)]);
  }
  return UUPS_INTERFACE.encodeFunctionData(functionFragment, [
    await mapAddress(implementation, deps),
    await rewriteNestedPayload(decoded.data, implementation, deps),
  ]);
}

async function rewriteProxyAdminCall(data, deps) {
  const functionFragment = selectedFunction(PROXY_ADMIN_INTERFACE, data);
  if (functionFragment === undefined) return undefined;
  const decoded = decodeCanonicalFunction(PROXY_ADMIN_INTERFACE, functionFragment, data);
  if (functionFragment.name === 'upgrade') {
    return PROXY_ADMIN_INTERFACE.encodeFunctionData(functionFragment, [
      await mapAddress(decoded.proxy, deps),
      await mapAddress(decoded.implementation, deps),
    ]);
  }
  return PROXY_ADMIN_INTERFACE.encodeFunctionData(functionFragment, [
    await mapAddress(decoded.proxy, deps),
    await mapAddress(decoded.implementation, deps),
    await rewriteNestedPayload(decoded.data, decoded.implementation, deps),
  ]);
}

async function rewriteBeaconCall(data, deps) {
  const functionFragment = selectedFunction(BEACON_INTERFACE, data);
  if (functionFragment === undefined) return undefined;
  const decoded = decodeCanonicalFunction(BEACON_INTERFACE, functionFragment, data);
  return BEACON_INTERFACE.encodeFunctionData(functionFragment, [await mapAddress(decoded.newImplementation, deps)]);
}

function targetInterface(abi) {
  if (!Array.isArray(abi)) {
    throw new RewriteError('MISSING_TARGET_METADATA', 'Target ABI metadata is required for this call');
  }
  try {
    return new Interface(abi);
  } catch (error) {
    throw new RewriteError('INVALID_ABI', 'Target ABI metadata is invalid', {}, { cause: error });
  }
}

function hasReceive(iface) {
  return iface.fragments.some(fragment => fragment.type === 'fallback' && fragment.inputs.length === 0);
}

function hasFallback(iface) {
  return iface.fragments.some(fragment => fragment.type === 'fallback' && fragment.inputs.length > 0);
}

async function rewriteTargetCalldata(data, abi, deps) {
  requireBytes(data, 'Calldata');
  const iface = targetInterface(abi);
  if (data === '0x') {
    if (!hasReceive(iface) && !hasFallback(iface)) {
      throw new RewriteError('UNDECODABLE_CALLDATA', 'Empty calldata requires a declared receive or fallback');
    }
    return data;
  }

  const functionFragment = selectedFunction(iface, data);
  if (functionFragment !== undefined) return rewriteCalldata(data, abi, deps);
  if (!hasFallback(iface)) {
    throw new RewriteError('UNDECODABLE_CALLDATA', 'Unknown calldata selector requires a declared fallback');
  }
  await assertOpaqueBytesSafe(data, deps);
  return data;
}

async function rewriteCall(decoded, context, deps) {
  requireDependencies(deps);
  if (decoded === null || typeof decoded !== 'object' || decoded.to === null || decoded.to === undefined) {
    throw new RewriteError('INVALID_CALL', 'Decoded call transaction with a target is required');
  }
  if (context === null || typeof context !== 'object' || typeof context.targetKind !== 'string') {
    throw new RewriteError('MISSING_TARGET_METADATA', 'Verified target kind metadata is required');
  }

  let data;
  switch (context.targetKind) {
    case 'uups-proxy':
      data = await rewriteUupsCall(decoded.data, deps);
      break;
    case 'proxy-admin':
      data = await rewriteProxyAdminCall(decoded.data, deps);
      break;
    case 'upgradeable-beacon':
      data = await rewriteBeaconCall(decoded.data, deps);
      break;
    case 'transparent-proxy':
    case 'beacon-proxy':
    case 'contract':
      break;
    default:
      throw new RewriteError('UNSUPPORTED_TARGET_KIND', `Unsupported target kind: ${context.targetKind}`);
  }
  if (data === undefined) {
    data = await rewriteTargetCalldata(decoded.data, context.abi, deps);
  }
  return { ...decoded, to: await mapAddress(decoded.to, deps), data };
}

module.exports = {
  RewriteError,
  rewriteAbiValues,
  rewriteCall,
  rewriteCalldata,
  rewriteDeployment,
};
