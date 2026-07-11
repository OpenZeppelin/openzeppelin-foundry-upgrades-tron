# OpenZeppelin Foundry Upgrades for TRON

Foundry library and local JSON-RPC adapter for validating, deploying, and
upgrading proxy contracts on TRON (TVM). The Solidity API follows OpenZeppelin
Foundry Upgrades, while the adapter translates Forge's signed legacy Ethereum
transactions into native TRON transactions.

## Install

Install this repository and add its remapping to your Foundry project:

```sh
forge install OpenZeppelin/openzeppelin-foundry-upgrades-tron
```

```text
openzeppelin-foundry-upgrades-tron/=lib/openzeppelin-foundry-upgrades-tron/src/
openzeppelin-tron-solidity/=lib/openzeppelin-foundry-upgrades-tron/lib/openzeppelin-tron-solidity/
```

The consuming project's `foundry.toml` must expose validation build data and
allow the upgrades library to invoke the pinned validation CLI:

```toml
ffi = true
ast = true
build_info = true
extra_output = ["storageLayout"]
```

Import the library from Solidity:

```solidity
import {Upgrades} from "openzeppelin-foundry-upgrades-tron/Upgrades.sol";
```

## Start the RPC adapter

Install the package dependencies before starting the adapter:

```sh
npm install
npm run rpc:start
```

The adapter listens on `127.0.0.1:8545` by default. Point Forge at
`http://127.0.0.1:8545` for broadcasts. Startup acquires an exclusive lock for
the state file and completes recovery of durable in-flight transactions before
the readiness record is printed.

Configuration is environment-only so credentials do not appear in shell
history or process arguments:

| Variable | Default on TRE | Purpose |
| --- | --- | --- |
| `TRON_NETWORK` | `tre` | `tre`, `mainnet`, `nile`, or `shasta` |
| `TRON_RPC_URL` | `http://127.0.0.1:9090` | TRON full-node base URL; `/jsonrpc` is derived automatically |
| `TRON_PRIVATE_KEY` | TRE development key | Native transaction signer; mandatory and explicit on public networks |
| `TRON_CHAIN_ID` | `3360022319` | Durable state namespace and Forge chain ID; explicit on public networks |
| `TRON_FEE_LIMIT` | `1000000000` | Native transaction fee limit |
| `TRON_STATE_FILE` | `<cwd>/.openzeppelin-upgrades/tron-rpc-state.json` | Absolute path required when explicitly set |
| `FOUNDRY_OUT` | `<cwd>/out` | Absolute Foundry artifact directory required when explicitly set |

Public networks never inherit the TRE endpoint or development key. To bind the
adapter beyond loopback, pass both the host and the explicit acknowledgement:

```sh
npm run rpc:start -- --host 0.0.0.0 --port 8545 --allow-non-loopback
```

Only expose the adapter behind controls appropriate for a signing service. It
accepts signed Forge transactions but holds the native TRON key in memory.
See [the RPC security boundaries](rpc/SECURITY.md) before using a public
network or a non-loopback listener.

## Resolve TVM addresses

Forge predicts Ethereum-style CREATE addresses. TRON assigns a different
on-chain address, so the adapter persists a one-to-one mapping before reporting
a successful deployment. Resolve either side without a private key or a live
network connection:

```sh
npm run rpc:resolve -- 0x1234567890123456789012345678901234567890
npm run rpc:mappings
```

`resolve` returns the predicted and actual EVM-form addresses, TRON hex,
Base58, mapping provenance, and artifact metadata. `mappings` returns all
records sorted by predicted address. Both commands emit stable JSON and only
read `TRON_NETWORK`, `TRON_CHAIN_ID`, and `TRON_STATE_FILE`. Resolving an
unknown nonzero address fails instead of presenting an unverified identity
mapping; the zero address is the only unmapped identity result.

The same lookup is exposed over JSON-RPC:

```json
{"jsonrpc":"2.0","id":1,"method":"tron_resolveAddress","params":["0x1234567890123456789012345678901234567890"]}
```

## Adapter behavior

The adapter forwards compatible reads to the node's read-only `/jsonrpc`
endpoint and translates `eth_sendRawTransaction` into native contract-create or
contract-call transactions. Before broadcast it verifies artifacts and
constructor/call payloads, rewrites mapped ABI address values, journals the
exact signed native transaction, and simulates child `CREATE` operations.

The adapter prefers the nonstandard POST `wallet/simulatesignedtransaction`
capability when a node provides it. The result must bind the matching native
transaction ID and a complete ordered child-`CREATE` trace. If, and only if,
the node explicitly reports that endpoint as absent, the adapter can use the
standard `wallet/triggerconstantcontract` payload simulation supported by
stock TRE and java-tron.

Before opening its listener, the adapter runs a constant, non-broadcasting
capability probe that must expose one successful and one rejected `CREATE` in
order. Payload simulation is derived from the byte-identical signed native
transaction JSON and its echoed contract payload is checked before use. The
selected `exact-signed` or `constant-create` readiness mode is included in the
CLI's ready message. A direct handler invocation performs the same cached probe
before its first write.

Standard payload simulation uses synthetic deployment addresses and cannot
distinguish `CREATE` from `CREATE2`. It therefore supports zero child creations
for ordinary deployments and calls, plus the canonical transparent proxy's
single successful root-created `ProxyAdmin`. Extra, nested, initializer, or
otherwise ambiguous child creations fail before broadcast. Their actual
addresses are bound only from a successful confirmed receipt. A node with the
exact signed-transaction capability retains strict generic child-address and
topology reconciliation.

State is written atomically and keyed by network plus chain ID. Replaying a
Forge transaction reuses the journaled native transaction; restart recovery
queries or rebroadcasts those exact persisted bytes instead of building a new
transaction. Because stock java-tron has no Ethereum account nonce method, the
adapter serves Forge a virtual source nonce derived from that durable journal.
Conflicting predicted/actual mappings are rejected.

## Development

```sh
npm test
npm run lint
npm run prepack
```

Run only the adapter suite with `npm run test:rpc`.

Run `npm run test:rpc:tre` to exercise real sequential deployments, calls,
address resolution, restart, and receipt replay against an isolated
`tronbox/tre:dev` container. The command requires Docker, uses deterministic
development-only accounts, selects an ephemeral loopback port, and removes the
container when the test finishes.

## License

MIT
