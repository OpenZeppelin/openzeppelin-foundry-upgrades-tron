# openzeppelin-foundry-upgrades-tron

TRON (TVM) support for [OpenZeppelin Foundry Upgrades](https://github.com/OpenZeppelin/openzeppelin-foundry-upgrades).

> **Status: exploratory — not yet implemented.**

This is a separate repository (rather than a package in the TRON upgrades
monorepo) because Foundry libraries are installed from a repo root via
`forge install`, and imports/remappings use the repo name:

```text
forge install OpenZeppelin/openzeppelin-foundry-upgrades-tron
import "openzeppelin-foundry-upgrades-tron/Upgrades.sol";
```

Mirroring the upstream repo name keeps EVM→TRON migration a mechanical
suffix change.

## Open technical questions

1. Can forge compile with `tron-solidity` — or are stock-solc artifacts close
   enough for validation purposes?
2. Does the FFI → `@openzeppelin/upgrades-core` CLI validation path run over a
   TRON project's build-info? (Requires `ffi = true`, `ast = true`,
   `build_info = true`, `extra_output = ["storageLayout"]`.)
3. What is the deployment story given TRON's JSON-RPC surface — native
   `forge broadcast`, or validation here with deployment through TronWeb-based
   tooling?

## License

MIT
