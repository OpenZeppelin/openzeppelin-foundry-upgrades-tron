# RPC adapter security boundaries

The adapter is a local signing service. It accepts Forge-signed legacy Ethereum
transactions, rebuilds equivalent native TRON transactions, signs them with the
configured TRON private key, and broadcasts them only after transaction-shape
validation and simulation succeed. Run it on a trusted workstation and keep the default
loopback binding. A non-loopback listener requires an explicit CLI opt-in and
should be placed behind authentication, network filtering, and transport
security appropriate for a signing service.

## Credentials and durable state

Configure endpoints and keys through environment variables, not command-line
arguments. Public networks require an explicit endpoint and private key, and
reject every deterministic account from the bundled ten-account TRE fixture.
Startup and HTTP errors are sanitized, but process owners can still inspect
environment variables and memory.

The state file contains address provenance, transaction journals, exact signed
native transaction bytes, confirmed receipts, and the immutable verified
artifact snapshots captured at deployment or adoption — or reconstructed later
under the same provenance check by startup recovery or `repair`. It does not
contain the private key.
The `init` command creates the file explicitly at mode `0600` and refuses to
overwrite an existing one; every state-opening command (`start`, `resolve`,
`mappings`, `adopt`, `repair`) refuses to run against a missing state file
rather than silently starting from an empty deployment history. Initialize the file once,
protect its parent directory and backups with equivalent permissions, and treat
it like a keystore: losing it loses every mapping for its chain, recoverable
only by restoring a backup or re-registering deployments with `adopt`. The
default `.openzeppelin-upgrades/` directory and all `.env` variants except the
example are ignored by Git. Never commit either one.

A single advisory lock protects each canonical (realpath) state path. It is a
loopback TCP reservation, local to the host's network namespace — not a
filesystem or cross-host lock — keyed on a hash of the canonical state path, so
relative or symlinked aliases resolve to the same lock. The durable store reads
and writes that same canonical state path, and every state mutation re-asserts
that the lock is still held before it commits, so no write lands after the lock
is released or taken over. Corrupt or unsupported state fails closed instead of
being reset. Restart recovery queries or rebroadcasts the already persisted
signed native transaction; it never silently builds a replacement transaction.

## Supported transaction and simulation surface

Only canonical, EIP-155-protected legacy Ethereum transactions from the
configured sender and chain are accepted. Typed transaction envelopes,
unprotected signatures, malformed RLP, `CREATE2`, and ambiguous opaque address
payloads fail before native broadcast, with one narrow exception: opaque
calldata matching a recognized upgrade entrypoint — UUPS `upgradeToAndCall`,
ProxyAdmin `upgradeAndCall`, or UpgradeableBeacon `upgradeTo` — whose
implementation argument is a known predicted address is rewritten instead of
rejected, and only after the adapter has confirmed that implementation's
predicted-to-actual mapping, resolved its intact artifact provenance, and
verified the target's live on-chain topology for the entrypoint's proxy kind.
Only the implementation argument is rewritten, and the final safety scan still
runs on the rewritten bytes. All other opaque bytes are rejected when they
contain a known predicted address in packed 20-byte, fixed-bytes, or padded ABI
form. A mapped contract's ABI comes from a verified deployment artifact and
nothing else: the live on-disk artifact when its current provenance still
matches the deployment, or the immutable snapshot — captured at deployment or
adoption, or reconstructed under the same provenance check — when the on-disk
artifact is missing or has been replaced in place. A changed disk
artifact is never adopted as the deployed one, and a legacy deployment with no
snapshot still fails closed when its on-disk provenance no longer matches. A
derived ProxyAdmin is the one exception: it has no deployment of its own, so
its metadata is bound instead through its parent transparent proxy's deployment.

Stock TRE does not serve historical state for numbered block tags. The adapter
retries numbered balance, code, storage, and call reads against `latest` only
when the upstream node returns TRE's exact unsupported-quantity error. This
compatibility path is read-only and intended to hydrate a Forge script at the
current head; it does not provide archival state or EVM fork semantics.

Exact signed-transaction simulation is preferred when the node exposes the
nonstandard capability. Stock java-tron uses constant payload simulation only
after a bounded, non-broadcasting probe proves ordered successful and rejected
child `CREATE` traces. Constant payload simulation cannot distinguish `CREATE`
from `CREATE2`; it is restricted to operations with no child creation and the
canonical TRON v5 transparent proxy's single root-created `ProxyAdmin`.
Initializer-created, nested, extra, and otherwise ambiguous children require
exact simulation and fail closed on stock nodes.

Simulation never publishes a mapping. Predicted-to-actual mappings, child
metadata, counters, and receipts are committed atomically only after a
successful solid receipt matches the source transaction, sender, target,
status, ordered child-attempt topology, and rejection markers. A post-broadcast
mismatch is irreversible on-chain, so the adapter retains the receipt and
reports a fatal failure without publishing partial mappings.

Besides the deployment flow, state is written only by the local `adopt` and
`repair` commands. Neither is an RPC method, and both hold the exclusive state
lock so they cannot race a live gateway. `adopt` writes nothing until it has
provenance-verified the named artifact from `FOUNDRY_OUT`, matched the on-chain
runtime code at the declared address against that artifact's runtime bytecode,
and, for a proxy kind, matched the TRC-1967 implementation, admin, or beacon
slot against the declared reference; any mismatch is refused. It re-registers a
deployment for ABI-aware operation but does not reconstruct historical nonces
or receipts. `repair` has a narrower contract: it backfills per-deployment role
descriptors, fills in snapshot immutable offsets, and rebuilds an artifact
snapshot the confirm flow lost to a crash — always under the deployment's
recorded provenance — and never creates or changes an address mapping.

## HTTP boundary

The server accepts strict JSON-RPC 2.0 POST requests with bounded headers,
body size, body time, and shutdown grace. Unsupported paths, methods, media
types, charsets, and content encodings are rejected. Handler exceptions and
serialization errors become generic internal errors so credentials and signed
transactions are not reflected to clients.

Before using a public network, separately review node trust, key custody,
process isolation, filesystem permissions, monitoring, and operational
recovery. The adapter does not provide remote authentication or a hardware
wallet boundary, and it performs no upgrade-safety or storage-layout validation
of its own: those checks run only when a transaction comes from the validated
`Upgrades`/`LegacyUpgrades` Solidity paths — `UnsafeUpgrades` and directly
signed transactions bypass them, and the adapter accepts both.
