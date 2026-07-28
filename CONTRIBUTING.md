# Contributing

Thanks for helping improve OpenZeppelin Foundry Upgrades for TRON. Changes must
preserve the boundary between validated Solidity APIs, the local signing
adapter, and real-node evidence.

## Prerequisites

- Node.js 22 or newer
- Foundry with forge-std 1.9.5 or newer
- Bash; on Windows, configure `OPENZEPPELIN_BASH_PATH`
- Docker for opt-in TRE integration tests

Clone with submodules and install the pinned Node dependencies:

```sh
git clone --recurse-submodules https://github.com/OpenZeppelin/openzeppelin-foundry-upgrades-tron.git
cd openzeppelin-foundry-upgrades-tron
npm ci
```

## Tests and formatting

Run the complete local suite and formatting checks before opening a pull
request:

```sh
npm test
npm run lint
npm run prepack
```

Useful focused commands are:

```sh
npm run test:package
npm run test:solidity
npm run test:validation
npm run test:reference-builds
npm run test:rpc
```

`npm run test:rpc:tre` is gated because it starts an isolated Docker container.
It must clean up the container on success, failure, and interruption. Never use
a production key in a test or add a public-network fallback credential.

Add a regression test before changing behavior. Public Solidity changes must
update `test/ApiShape.t.sol`, NatSpec, the README, and the API pages together.
Adapter changes must retain bounded failure behavior, journal recovery, and
address-map invariants.

## Packaging and documentation

Inspect `npm pack --dry-run --json` when changing the publish surface. The
package must contain runtime Solidity and adapter files, but not tests, fixture
build output, Forge dependencies, credentials, local state, or internal plans.

Keep examples executable and distinguish Forge-predicted addresses from actual
TRON addresses. Do not document Defender, Ethereum source verification,
forking, CREATE2, or legacy interfaces as supported unless the corresponding
implementation and real-node acceptance evidence exist.

## Pull requests and security

Keep pull requests focused and explain the validation, TVM, and recovery
invariants they affect. Include the exact commands and environments used for
verification. Do not include private keys, signed production transactions,
state files, workstation paths, or internal planning material.

Report suspected vulnerabilities privately through OpenZeppelin's published
security reporting process instead of opening a public issue.
