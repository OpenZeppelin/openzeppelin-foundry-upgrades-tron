# Changelog

All notable changes to this project will be documented in this file. The
project follows Semantic Versioning.

## Unreleased

- When installed with `forge install OpenZeppelin/openzeppelin-foundry-upgrades-tron`,
  the bundled OpenZeppelin Contracts for TRON is now the `v5.6.0` release
  (previously an unreleased commit predating the audit fixes).

## 0.1.0 (2026-08-21)

- Add validated and unsafe modern UUPS, transparent, and beacon deployment and
  upgrade APIs for OpenZeppelin Contracts for TRON v5.
- Bind validation and deployment to the same compiler, source, build-info,
  creation-bytecode, linker, and artifact snapshot provenance.
- Add exact `LinkedLibrary` mappings for unlinked Forge artifacts.
- Add reference-based upgrades-core validation, historical build-info support,
  granular unsafe options, and fail-closed validation result handling.
- Add the local Forge-to-TRON JSON-RPC adapter, durable transaction recovery,
  predicted-to-actual address reconciliation, and stock TRE simulation mode.
- Require non-empty initializer data for UUPS and transparent TRC1967 proxy
  deployment; beacon proxies retain empty-data support.
- Document that Defender, Ethereum source verification, Foundry forking,
  generic CREATE2, and typed Ethereum transactions are unsupported.
- Add the upgrade-only `LegacyUpgrades.sol` surface for existing OpenZeppelin
  Contracts v4 deployments, with local v4/v5 dispatch tests. A stock-TRE
  regression against pinned v4.9.6 fixtures is pending and not yet confirmed.
