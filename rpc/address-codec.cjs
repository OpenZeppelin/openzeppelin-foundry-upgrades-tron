const { TronWeb } = require('tronweb');

const EVM_HEX_PATTERN = /^(?:0x)?[0-9a-f]{40}$/i;
const TRON_HEX_PATTERN = /^(?:0x)?41[0-9a-f]{40}$/i;

function invalidAddress() {
  return new Error('Invalid TRON address');
}

function tronHexFromAddress(address) {
  if (typeof address !== 'string' || address.length === 0) {
    throw invalidAddress();
  }

  if (TRON_HEX_PATTERN.test(address)) {
    return address.replace(/^0x/i, '').toLowerCase();
  }

  if (EVM_HEX_PATTERN.test(address)) {
    return `41${address.replace(/^0x/i, '').toLowerCase()}`;
  }

  if (TronWeb.isAddress(address)) {
    const tronHex = TronWeb.address.toHex(address).toLowerCase();
    if (TRON_HEX_PATTERN.test(tronHex)) {
      return tronHex;
    }
  }

  throw invalidAddress();
}

function toTronHexAddress(address) {
  return tronHexFromAddress(address);
}

function toEvmAddress(address) {
  return `0x${tronHexFromAddress(address).slice(2)}`;
}

function toBase58Address(address) {
  const base58 = TronWeb.address.fromHex(tronHexFromAddress(address));
  if (!TronWeb.isAddress(base58)) {
    throw invalidAddress();
  }
  return base58;
}

function normalizeAddress(address) {
  const tronHex = tronHexFromAddress(address);
  return {
    evm: `0x${tronHex.slice(2)}`,
    tronHex,
    base58: toBase58Address(tronHex),
  };
}

module.exports = {
  normalizeAddress,
  toBase58Address,
  toEvmAddress,
  toTronHexAddress,
};
