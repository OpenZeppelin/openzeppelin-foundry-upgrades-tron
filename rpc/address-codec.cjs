// Address conversion primitives are provided by the shared @openzeppelin/tron-runtime
// package. This module re-exports them so gateway callers keep a stable import path.
const {
  normalizeAddress,
  toBase58Address,
  toEvmAddress,
  toTronHexAddress,
  nativeContractAddress,
} = require('@openzeppelin/tron-runtime');

module.exports = {
  nativeContractAddress,
  normalizeAddress,
  toBase58Address,
  toEvmAddress,
  toTronHexAddress,
};
