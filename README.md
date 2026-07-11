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
| `TRON_CHAIN_ID` | `728126428` | Durable state namespace and Forge chain ID |
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

Write translation requires a nonstandard POST
`wallet/simulatesignedtransaction` capability. Its result must contain the
matching native transaction ID, `trace_complete: true`, and ordered
`child_create_attempts`. The stock public java-tron API and current stock TRE
image do not provide this complete capability, so write requests fail closed
before native broadcast on those nodes. Supplying public-network credentials
does not by itself make write translation operational.

Task 10's TRE integration readiness diagnostic must probe this exact simulation
contract before reporting the write adapter ready; ordinary node or `/jsonrpc`
health is not sufficient. Until that gate passes against a capability-enabled
node, the adapter's read path and offline mapping inspection remain usable, but
write support is not claimed for stock TRE or public java-tron deployments.

State is written atomically and keyed by network plus chain ID. Replaying a
Forge transaction reuses the journaled native transaction; restart recovery
queries or rebroadcasts those exact persisted bytes instead of building a new
transaction. Conflicting predicted/actual mappings are rejected.

## Development

```sh
npm test
npm run lint
npm run prepack
```

Run only the adapter suite with `npm run test:rpc`.

## License

MIT
