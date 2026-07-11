# RPC adapter security boundaries

The adapter is a local signing service. It accepts Forge-signed legacy Ethereum
transactions, rebuilds equivalent native TRON transactions, signs them with the
configured TRON private key, and broadcasts them only after validation and
simulation succeed. Run it on a trusted workstation and keep the default
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
native transaction bytes, and confirmed receipts. It does not contain the
private key. Atomic state-file creation uses mode `0600`; protect its parent
directory and backups with equivalent permissions. The default
`.openzeppelin-upgrades/` directory and all `.env` variants except the example
are ignored by Git. Never commit either one.

One kernel-backed lock protects each canonical state path. Corrupt or
unsupported state fails closed instead of being reset. Restart recovery queries
or rebroadcasts the already persisted signed native transaction; it never
silently builds a replacement transaction.

## Supported transaction and simulation surface

Only canonical, EIP-155-protected legacy Ethereum transactions from the
configured sender and chain are accepted. Typed transaction envelopes,
unprotected signatures, malformed RLP, `CREATE2`, and ambiguous opaque address
payloads fail before native broadcast.

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

## HTTP boundary

The server accepts strict JSON-RPC 2.0 POST requests with bounded headers,
body size, body time, and shutdown grace. Unsupported paths, methods, media
types, charsets, and content encodings are rejected. Handler exceptions and
serialization errors become generic internal errors so credentials and signed
transactions are not reflected to clients.

Before using a public network, separately review node trust, key custody,
process isolation, filesystem permissions, monitoring, and operational
recovery. The adapter does not provide remote authentication or a hardware
wallet boundary.
