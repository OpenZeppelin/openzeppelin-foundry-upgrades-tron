# OpenZeppelin Foundry Upgrades for TRON

Deploy and upgrade **UUPS, Transparent, and Beacon** proxies on TRON using the
*unmodified* OpenZeppelin Foundry upgrades API. You write ordinary Foundry
scripts; a small local adapter makes TRON look like a normal EVM chain to Forge.

## How it works

Forge computes a contract's address *before* deploying (a **predicted** address)
and builds its whole simulation around it. TRON assigns a *different* **actual**
address on-chain, and its RPC differs from Ethereum's. The adapter is a local
JSON-RPC process that sits between Forge and a TRON node and reconciles the two:

```text
  forge script          Adapter                 TRON node
  (Upgrades.sol)  ──▶   predicted ⇄ actual  ──▶  (java-tron)
       ▲                translates reads            │
       └──────────  predicted view  ◀───────────────┘
```

- **You always work with predicted addresses.** The adapter translates code,
  storage slots, call results, logs, and receipts back to the predicted world,
  so Forge stays consistent — you never touch a TRON address inside a script.
- **The adapter must be running**, and Forge must point at it via `--rpc-url`.
- **State is durable.** The predicted↔actual mappings live in a state file —
  back it up like a keystore; it is the only record of your deployments.

## Quickstart

Deploy and upgrade a UUPS proxy against a local TRON node, end to end.

**1 · Install** (keeps the Solidity library and the adapter together):

```sh
forge install OpenZeppelin/openzeppelin-foundry-upgrades-tron
(cd lib/openzeppelin-foundry-upgrades-tron && npm install && npm run build:rpc)
```

Add the remappings:

```text
openzeppelin-foundry-upgrades-tron/=lib/openzeppelin-foundry-upgrades-tron/src/
openzeppelin-tron-solidity/=lib/openzeppelin-foundry-upgrades-tron/lib/openzeppelin-tron-solidity/
```

**2 · Configure `foundry.toml`:**

```toml
ffi = true
ast = true
build_info = true
extra_output = ["storageLayout"]
fs_permissions = [{ access = "read", path = "./" }]
```

**3 · Write an ordinary deploy script** (`script/Deploy.s.sol`):

```solidity
import {Script, console2} from "forge-std/Script.sol";
import {Upgrades} from "openzeppelin-foundry-upgrades-tron/Upgrades.sol";

contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        address proxy = Upgrades.deployUUPSProxy(
            "Box.sol:Box",
            abi.encodeCall(Box.initialize, (msg.sender, 1))
        );
        console2.log("proxy", proxy); // predicted address
        vm.stopBroadcast();
    }
}
```

**4 · Start the adapter** (defaults to a local TRE node):

```sh
npx openzeppelin-foundry-upgrades-tron init    # once — creates the durable state file
npx openzeppelin-foundry-upgrades-tron start   # listens on http://127.0.0.1:8545
```

**5 · Broadcast through the adapter:**

```sh
ETH_RPC_TIMEOUT=300 forge script script/Deploy.s.sol \
  --rpc-url http://127.0.0.1:8545 --broadcast --legacy --slow \
  --disable-block-gas-limit --timeout 300
```

**6 · See the predicted ↔ actual mapping:**

```sh
npx openzeppelin-foundry-upgrades-tron resolve <predicted-address>
npx openzeppelin-foundry-upgrades-tron mappings
```

**To upgrade**, run the same flow with an upgrade script — identify the previous
version with `referenceContract` (or `@custom:oz-upgrades-from`):

```solidity
Options memory opts;
opts.referenceContract = "Box.sol:Box";
Upgrades.upgradeProxy(proxy, "BoxV2.sol:BoxV2", bytes(""), opts);
```

> **Public networks:** set `TRON_NETWORK`, `TRON_RPC_URL`, `TRON_PRIVATE_KEY`,
> and `TRON_CHAIN_ID` explicitly, and read [rpc/SECURITY.md](rpc/SECURITY.md)
> before exposing the adapter beyond loopback.

---

# Reference

The Quickstart above is all most projects need. The sections below are the full
reference — npm install, the complete Solidity API, compiler provenance & FFI
security, adapter behavior & internals, state recovery, and TVM differences.

## Install

The source installation keeps the Solidity library, its TRON proxy contracts,
and the adapter together:

```sh
forge install OpenZeppelin/openzeppelin-foundry-upgrades-tron
(cd lib/openzeppelin-foundry-upgrades-tron && npm install)
```

```text
openzeppelin-foundry-upgrades-tron/=lib/openzeppelin-foundry-upgrades-tron/src/
openzeppelin-tron-solidity/=lib/openzeppelin-foundry-upgrades-tron/lib/openzeppelin-tron-solidity/
```

For an npm consumer, install the library and the exact validation CLI, then add
OpenZeppelin Contracts for TRON and forge-std as Forge dependencies:

```sh
npm install @openzeppelin/foundry-upgrades-tron @openzeppelin/upgrades-core@1.46.0
forge install foundry-rs/forge-std@v1.9.5
forge install OpenZeppelin/tron-contracts@06d69bcfc94ff7ba6824290959b75baf86d91f6c
```

```text
openzeppelin-foundry-upgrades-tron/=node_modules/@openzeppelin/foundry-upgrades-tron/src/
openzeppelin-tron-solidity/=lib/tron-contracts/
forge-std/=lib/forge-std/src/
```

The npm package does not vendor mutable Forge dependencies. Pin the TRON
contracts commit in the consuming repository. Node.js 22 or newer, Bash, and
forge-std 1.9.5 or newer are required. On Windows, set
`OPENZEPPELIN_BASH_PATH` to the absolute forward-slash path of a trusted Bash
executable.

## Configure Foundry

The consuming project's `foundry.toml` must expose validation build data and
allow the upgrades library to invoke the pinned validation CLI:

```toml
ffi = true
ast = true
build_info = true
extra_output = ["storageLayout"]
fs_permissions = [{ access = "read", path = "./" }]
```

Run scripts and tests with `--force`, or run `forge clean` before them, so the
artifact and build-info describe the same compilation. If `out` is customized,
grant read access to that directory and set `FOUNDRY_OUT` to the same relative
or absolute path.

Import the library from Solidity:

```solidity
import { UnsafeUpgrades, Upgrades } from 'openzeppelin-foundry-upgrades-tron/Upgrades.sol';
import { LinkedLibrary, Options } from 'openzeppelin-foundry-upgrades-tron/Options.sol';
```

## Use the modern Solidity API

The validated `Upgrades` library supports UUPS, transparent, and beacon proxies
using OpenZeppelin Contracts for TRON v5. The following examples assume an
implementation contract named `Box` with an `initialize` function. A
`contractName` — and a `referenceContract` without a historical build-info
directory — accepts a Solidity filename (`Box.sol`), a fully qualified name
(`Box.sol:Box`), or an artifact path relative to the project root
(`out/Box.sol/Box.json`).

Deploy a UUPS proxy:

```solidity
address proxy = Upgrades.deployUUPSProxy(
    "Box.sol:Box",
    abi.encodeCall(Box.initialize, (initialOwner, 1))
);
```

Deploy a transparent proxy and assign ownership of its internally-created
ProxyAdmin:

```solidity
address proxy = Upgrades.deployTransparentProxy(
    "Box.sol:Box",
    proxyAdminOwner,
    abi.encodeCall(Box.initialize, (initialOwner, 1))
);
```

Deploy a beacon and one of its proxies:

```solidity
address beacon = Upgrades.deployBeacon("Box.sol:Box", beaconOwner);
address proxy = Upgrades.deployBeaconProxy(
    beacon,
    abi.encodeCall(Box.initialize, (initialOwner, 1))
);
```

TVM's `TRC1967Proxy` requires a non-empty initializer call for UUPS and
transparent deployments; a violating deployment reverts with
`TRC1967InitializationRequired`. Beacon proxies may intentionally use empty
initializer data.

Before an upgrade, identify the previous implementation with either
`@custom:oz-upgrades-from` on the new contract or `referenceContract`:

```solidity
Options memory opts;
opts.referenceContract = "Box.sol:Box";
Upgrades.upgradeProxy(proxy, "BoxV2.sol:BoxV2", bytes(""), opts);
// Or: Upgrades.upgradeBeacon(beacon, "BoxV2.sol:BoxV2", opts);
```

For a historical build, set `referenceBuildInfoDir` — an absolute path, or a
path relative to the Foundry project root — and prefix the reference with that
directory's unique short name, for example
`build-info-v1:contracts/Box.sol:Box`. Historical build-info is trusted release
input and should be retained and reviewed like source code.

`validateImplementation` and `validateUpgrade` perform checks without a chain
write. `deployImplementation` validates and deploys a standalone
implementation. `prepareUpgrade` validates against a reference and deploys the
implementation for an administrator-controlled later upgrade. The TRC1967
admin, implementation, and beacon slots are exposed through the three
`get*Address` helpers. The overloads ending in `tryCaller` are for tests;
broadcast scripts configure the sender through Forge instead.

### Options and linked libraries

`constructorData` contains implementation constructor arguments; it is not
proxy initializer data. `exclude` controls source-path glob patterns passed to
upgrades-core; reference contracts are not excluded. `unsafeAllow` — a
comma-separated list of upgrades-core validation errors to waive —
`unsafeAllowRenames`, `unsafeSkipProxyAdminCheck`, and `unsafeSkipStorageCheck`
waive individual safety checks. `unsafeSkipAllChecks` also bypasses compiler
provenance binding and should be a last resort.

Unlinked artifacts require an exact `LinkedLibrary` for every compiler link
reference:

```solidity
Options memory opts;
opts.linkedLibraries = new LinkedLibrary[](1);
opts.linkedLibraries[0] = LinkedLibrary({
    sourceName: "src/Math.sol",
    libraryName: "Math",
    libraryAddress: deployedMath
});
```

Source and library names are case-sensitive. Every mapping must match at least
one reference, repeated placeholders reuse the same mapping identity, the
address must contain code, and duplicate or extra mappings are rejected. A
prelinked artifact must not receive a mapping.

`UnsafeUpgrades` accepts already-deployed implementation addresses and runs no
upgrade-safety, storage-layout, or compiler-provenance validation. It is useful
for local tests and coverage, but should not replace validated deployment
scripts.

### Existing OpenZeppelin Contracts v4 upgrades

`LegacyUpgrades.sol` provides the upstream upgrade-only interface for existing
deployments built with OpenZeppelin Contracts v4. It intentionally has no proxy
or beacon deployment helpers and no general-purpose `deployImplementation` or
`validateImplementation` helpers. Its `prepareUpgrade` function does validate
and deploy an implementation as part of an upgrade workflow. New deployments
use `Upgrades.sol` with OpenZeppelin Contracts for TRON v5.

```solidity
import {
    Upgrades as LegacyUpgrades,
    UnsafeUpgrades as UnsafeLegacyUpgrades
} from "openzeppelin-foundry-upgrades-tron/LegacyUpgrades.sol";

Options memory opts;
opts.referenceContract = "BoxV1.sol:BoxV1";
LegacyUpgrades.upgradeProxy(proxy, "BoxV2.sol:BoxV2", bytes(""), opts);
```

The shared Solidity dispatcher recognizes the v4 UUPS `upgradeTo` entrypoint
and v4 ProxyAdmin `upgrade`/`upgradeAndCall` paths while retaining strict v5
`UPGRADE_INTERFACE_VERSION = "5.0.0"` dispatch. Through the RPC adapter, an
externally-deployed v4 proxy must first be adopted together with its current
implementation before an upgrade with empty data — like the example above —
can be dispatched; see
[TVM differences and unsupported surfaces](#tvm-differences-and-unsupported-surfaces).

Dispatch for pinned `@openzeppelin/contracts@4.9.6` and
`@openzeppelin/contracts-upgradeable@4.9.6` sources is unit-verified. Full live
verification — deploying genuine upstream v4 UUPS, transparent, and beacon
fixtures, upgrading them through `LegacyUpgrades.sol` on stock TRE, and
independently checking state, ownership, and ERC-1967 slots — is a pending
real-node regression step and is not yet confirmed against the current
adapter. These are upstream OpenZeppelin Contracts v4 sources; there is no
TRON-branded v4 package.

## Compiler provenance and FFI security

Validation and deployment consume the same artifact snapshot. Before and after
the pinned upgrades-core CLI runs, the library binds the artifact to its
build-info, exact compiler build, source hashes, creation bytecode, linker
references, output directory, and artifact snapshot hash. A mismatch fails
before deployment. The RPC adapter also rechecks the persisted deployment
provenance before using an artifact ABI for any later address rewrite, so a
changed same-name artifact fails closed. Do not validate stock-solc build-info
and then replace the artifact with bytecode from another compiler pipeline.

The validation path uses Forge FFI to run trusted Bash and Node.js code plus
`@openzeppelin/upgrades-core@1.46.0`. FFI security therefore depends on the
integrity of the installed package, its remapping, build artifacts, historical
references, `PATH`, Bash, Node.js, and npm configuration. Review and pin those
inputs; do not run the library against artifacts or dependencies supplied by an
untrusted party.

## Start the RPC adapter

Install the package dependencies before starting the adapter. When running
from source, build the adapter first; `npm run build:rpc` emits `dist/rpc/`:

```sh
npm install
npm run build:rpc
npm run rpc:init
npm run rpc:start
```

Create the state file once with `init` before the first start. `init` writes an
empty state file at `TRON_STATE_FILE` with mode `0600` and refuses to overwrite
an existing one. Back the file up like a keystore: it is the only record of the
predicted-to-actual address mappings and verified artifact snapshots for its
chain. `start`, `resolve`, and `mappings` refuse to run against a missing state
file rather than presenting an empty deployment history, so a lost or mispointed
path fails loudly. Recover a lost state file by restoring a backup, or
re-register individual on-chain deployments with `adopt`.

The adapter listens on `127.0.0.1:8545` by default. Point Forge at
`http://127.0.0.1:8545` for broadcasts. Startup acquires an exclusive lock for
the state file and completes recovery of durable in-flight transactions before
the readiness record is printed.

Configuration is environment-only so credentials do not appear in shell
history or process arguments:

| Variable           | Default on TRE                                     | Purpose                                                                 |
| ------------------ | -------------------------------------------------- | ----------------------------------------------------------------------- |
| `TRON_NETWORK`     | `tre`                                              | `tre`, `mainnet`, `nile`, or `shasta`                                   |
| `TRON_RPC_URL`     | `http://127.0.0.1:9090`                            | TRON full-node base URL; `/jsonrpc` is derived automatically            |
| `TRON_PRIVATE_KEY` | TRE development key                                | Native transaction signer; mandatory and explicit on public networks    |
| `TRON_CHAIN_ID`    | `3360022319`                                       | Durable state namespace and Forge chain ID; explicit on public networks |
| `TRON_FEE_LIMIT`   | `1000000000`                                       | Native transaction fee limit                                            |
| `TRON_STATE_FILE`  | `<cwd>/.openzeppelin-upgrades/tron-rpc-state.json` | Absolute path required when explicitly set                              |
| `FOUNDRY_OUT`      | `<cwd>/out`                                        | Absolute Foundry artifact directory required when explicitly set        |

Public networks never inherit the TRE endpoint or development key. To bind the
adapter beyond loopback, pass both the host and the explicit acknowledgement:

```sh
npx openzeppelin-foundry-upgrades-tron start --host 0.0.0.0 --port 8545 --allow-non-loopback
```

Only expose the adapter behind controls appropriate for a signing service. It
accepts signed Forge transactions but holds the native TRON key in memory.
See [the RPC security boundaries](rpc/SECURITY.md) before using a public
network or a non-loopback listener.

### Stop and restart the adapter

Stop the adapter with a graceful shutdown signal — `Ctrl-C` (`SIGINT`) in an
interactive shell, or `SIGTERM` from a process manager. There is no separate
`stop` command; shutdown is signal-driven. On either signal the adapter stops
accepting new connections, gives in-flight requests up to a bounded 10-second
grace period to finish, then force-closes any connections still open, releases
the state-file lock, and exits.

A stopped adapter process cannot be resumed in place. To restart, run `npm run
rpc:start` again: it goes through the same startup sequence described above —
re-acquiring the state-file lock and completing recovery of durable in-flight
transactions before printing the readiness record — so it resumes safely from
the persisted state file whether the previous process stopped gracefully or
crashed.

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
{ "jsonrpc": "2.0", "id": 1, "method": "tron_resolveAddress", "params": ["0x1234567890123456789012345678901234567890"] }
```

## Re-register a deployment after state loss

When a state file is lost and no backup exists, `adopt` re-registers a single
on-chain deployment so the adapter can operate it ABI-aware again. It is a
local, offline-signing-free command; it is never exposed over JSON-RPC.

```sh
npm run rpc:adopt -- \
  --predicted 0xEVM... --actual TRON... \
  --artifact contracts/Box.sol:Box --kind uups-proxy --impl 0xEVM...
```

Adoption verifies before it writes anything and refuses on any mismatch. It
resolves and provenance-verifies the named artifact from `FOUNDRY_OUT`, fetches
the on-chain runtime code at `--actual` and requires it to match the artifact's
runtime bytecode, and for a proxy kind reads the TRC-1967 slots and requires
them to match the declared references (`--impl` for `uups-proxy`, `--admin` for
`transparent-proxy`, `--beacon` for `beacon-proxy`; a bare implementation has no
slots). It also cross-checks, against live on-chain state, the controller a proxy
delegates upgrade authority to: a `transparent-proxy`'s ProxyAdmin must answer
`owner()` with `--owner`, and a `beacon-proxy`'s UpgradeableBeacon must answer
`implementation()` with `--impl`. Adopted in their own right, a `proxy-admin`
must answer `owner()` with `--owner` and an `upgradeable-beacon` must answer
`implementation()` with `--impl`. Only then does it record the address mapping,
contract metadata, the verified artifact snapshot, and the deployment's
role-immutable descriptors, and set an optional `--nonce-baseline`. The address
accepts Base58, `41`-hex, or `0x` TRON forms.

Adopt the controller before its proxy. A `transparent-proxy` requires its
ProxyAdmin (kind `proxy-admin`) to be adopted first, and a `beacon-proxy`
requires its UpgradeableBeacon (kind `upgradeable-beacon`) to be adopted first,
so `eth_getCode` can project the proxy's constructor-set controller address into
the predicted world. Adopting a proxy before its controller fails closed with a
naming error before any state is written; adopt the controller (with its
`--owner`/`--impl`) and then re-run the proxy adoption.

`adopt` does not reconstruct historical nonces or receipts. It re-registers a
deployment for ABI-aware operation going forward. Adopt a proxy's implementation
alongside the proxy so calls that resolve through the implementation stay
ABI-aware. Provide `--nonce-baseline` with the sender's already-consumed on-chain
nonce count so Forge does not reuse a spent nonce after re-registration. That
floor also applies to `eth_getTransactionCount` for the configured sender, so
the adapter never reports a nonce below it.

`repair` durably backfills the per-deployment role-immutable descriptors for
already-mapped deployments — legacy deployments predating the descriptor index,
or captures left pending by a transient post-confirmation read failure. It holds
the state lock like `adopt`, reads each deployment's live runtime code, and
completes its descriptor only when the read yields the required role; a
deployment it cannot verify is left pending and retried on a later run.

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

Stock TRE also rejects numbered block tags for `eth_getBalance`, `eth_getCode`,
`eth_getStorageAt`, and `eth_call`. For those read-only methods, the adapter
retries with `latest` only after the node returns TRE's exact unsupported-
quantity error. This is head-state compatibility for Forge script hydration,
not archival or fork support. Stock TRE reports an Ethereum block gas limit of
zero, so Forge broadcasts must include `--disable-block-gas-limit`.
The adapter waits for a solid native receipt before acknowledging a write, so
Forge's HTTP timeout must outlive the adapter's bounded 120-second receipt
window. For TRE integration runs, use `ETH_RPC_TIMEOUT=300` together with
`--timeout 300`:

```sh
ETH_RPC_TIMEOUT=300 forge script script/Deploy.s.sol \
  --rpc-url http://127.0.0.1:8545 --broadcast --legacy --slow \
  --disable-block-gas-limit --timeout 300
```

## TVM differences and unsupported surfaces

Forge returns an Ethereum-style predicted address when a contract is created.
The adapter maps it durably to the actual TRON/TVM address after a successful,
confirmed receipt. Continue using the predicted address inside the same Forge
workflow so calls and ABI address arguments can be rewritten. Resolve the
actual TVM address before passing a deployment to TronWeb, Hardhat, an explorer,
or another process that does not use the adapter.

The modern Solidity function shapes intentionally track OpenZeppelin Foundry
Upgrades v0.4.1, with `LinkedLibrary` as a TVM artifact-provenance extension.
The following EVM features are intentionally outside the supported surface:

- OpenZeppelin Defender deployment and proposal APIs are not supported or
  included.
- Ethereum-style source verification is not translated by the adapter and is
  not supported; use an appropriate TRON verification workflow separately.
- Foundry forking is not supported. Numbered block reads exist only to hydrate
  Forge's immediate broadcast receipts and are not archival or fork support.
- Hardhat manifests, implementation reuse, kind inference, and `forceImport`
  are not part of the Solidity API.
- Typed Ethereum transactions and generic `CREATE2` are rejected by the
  adapter. Stock constant simulation also rejects ambiguous child creation.
- For an upgrade target the adapter holds no metadata for, opaque calldata
  recognition covers exactly three entrypoints: UUPS `upgradeToAndCall` (v4
  and v5 declare the identical signature), ProxyAdmin `upgradeAndCall`, and
  UpgradeableBeacon `upgradeTo`. An externally-deployed v4 UUPS proxy upgraded
  with empty data is not recognized — its bare `upgradeTo(address)` selector is
  indistinguishable from a beacon's, and the beacon topology check cannot pass
  against a UUPS proxy. An externally-deployed v4 transparent proxy upgraded
  with empty data is not recognized either — its ProxyAdmin
  `upgrade(address,address)` entrypoint is outside the recognized set. Both
  fail closed before native broadcast with
  `error.data.code = "OPAQUE_PREDICTED_ADDRESS"`. Adopt such a proxy first —
  kind `uups-proxy`, or the `proxy-admin` and `transparent-proxy` pair —
  together with its current implementation (kind `contract`); the ABI-aware
  path then dispatches all four upgrade entrypoints. Adoption requires a
  byte-exact runtime-code match against a locally compiled artifact.

The upgrade-only `LegacyUpgrades.sol` entrypoint is exported for existing
OpenZeppelin Contracts v4 deployments. Dispatch is unit-verified; a live
stock-TRE regression that deploys and upgrades genuine pinned v4.9.6 UUPS,
transparent, and beacon fixtures is pending and not yet confirmed against the
current adapter. Local lookalikes are used only for focused dispatch tests.

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

## Troubleshooting

**A Forge script times out waiting on the adapter.** The adapter waits for a
solid receipt before acknowledging a write, bounded by a 120-second receipt
window, so Forge's HTTP timeout must outlive it. Broadcast with
`--disable-block-gas-limit` (stock TRE reports an Ethereum block gas limit of
zero), and for TRE integration runs raise both timeouts together:
`ETH_RPC_TIMEOUT=300 forge script ... --timeout 300`.

**`start`, `resolve`, `mappings`, or `adopt` fails because the state file is
missing.** These commands refuse to run against a missing state file rather
than presenting an empty deployment history. Run `npm run rpc:init` once to
create it, restore a backup, or use `npm run rpc:adopt` to re-register
individual on-chain deployments.

**`start` fails because the state file is already locked.** Another adapter
process is already holding the lock for that state path. Stop that process
first (see [Stop and restart the adapter](#stop-and-restart-the-adapter))
before starting a new one against the same state file.

**Validation or a script fails on a stale build-info or artifact mismatch.**
Run scripts and tests with `--force`, or run `forge clean` first, so the
artifact and build-info describe the same compilation.

**FFI or Bash invocation fails on Windows.** Set `OPENZEPPELIN_BASH_PATH` to
the absolute forward-slash path of a trusted Bash executable before running
Forge.

## License

MIT
