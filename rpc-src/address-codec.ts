// Address conversion primitives are provided by the shared @openzeppelin/tron-runtime
// package. This module re-exports them so gateway callers keep a stable import path.
import {
  normalizeAddress,
  toBase58Address,
  toEvmAddress,
  toTronHexAddress,
  nativeContractAddress,
} from '@openzeppelin/tron-runtime';

export { nativeContractAddress, normalizeAddress, toBase58Address, toEvmAddress, toTronHexAddress };
