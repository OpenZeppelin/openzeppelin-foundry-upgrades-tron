const CANONICAL_TRON_ROOT = 'openzeppelin-tron-solidity/';
const SUPPORTED_TRON_ROOTS = Object.freeze([
  CANONICAL_TRON_ROOT,
  `lib/${CANONICAL_TRON_ROOT}`,
  'lib/tron-contracts/',
  `lib/openzeppelin-foundry-upgrades-tron/lib/${CANONICAL_TRON_ROOT}`,
]);
const TRANSPARENT_PROXY_PATH = 'contracts/proxy/transparent/TransparentUpgradeableProxy.sol';
const TRANSPARENT_PROXY_IDENTITY = `${CANONICAL_TRON_ROOT}${TRANSPARENT_PROXY_PATH}:TransparentUpgradeableProxy`;

/** A Hardhat-style fully-qualified contract identity as tracked by the gateway. */
export interface ArtifactIdentity {
  sourceName: string;
  contractName: string;
  fullyQualifiedName: string;
}

function canonicalTronFullyQualifiedName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const separator = value.lastIndexOf(':');
  if (separator <= 0 || separator === value.length - 1) return undefined;
  const sourceName = value.slice(0, separator);
  const contractName = value.slice(separator + 1);
  for (const root of SUPPORTED_TRON_ROOTS) {
    if (sourceName.startsWith(root)) {
      return `${CANONICAL_TRON_ROOT}${sourceName.slice(root.length)}:${contractName}`;
    }
  }
  return undefined;
}

function derivedTronProxyAdminIdentity(identity: unknown): ArtifactIdentity | undefined {
  if (identity === null || typeof identity !== 'object') {
    return undefined;
  }
  const candidate = identity as ArtifactIdentity;
  if (
    candidate.fullyQualifiedName !== `${candidate.sourceName}:${candidate.contractName}` ||
    canonicalTronFullyQualifiedName(candidate.fullyQualifiedName) !== TRANSPARENT_PROXY_IDENTITY ||
    !candidate.sourceName.endsWith(TRANSPARENT_PROXY_PATH)
  ) {
    return undefined;
  }
  const sourceName = `${candidate.sourceName.slice(0, -TRANSPARENT_PROXY_PATH.length)}contracts/proxy/transparent/ProxyAdmin.sol`;
  return { sourceName, contractName: 'ProxyAdmin', fullyQualifiedName: `${sourceName}:ProxyAdmin` };
}

export { CANONICAL_TRON_ROOT, SUPPORTED_TRON_ROOTS, TRANSPARENT_PROXY_IDENTITY, canonicalTronFullyQualifiedName, derivedTronProxyAdminIdentity };
