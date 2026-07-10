#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

cleanup() {
  rm -rf test_artifacts
}
trap cleanup EXIT

cleanup
mkdir -p test_artifacts/build-info-v1

forge clean
FOUNDRY_PROFILE=build-info-v1 FOUNDRY_OUT=out forge build --force
cp out/build-info/*.json test_artifacts/build-info-v1/

FOUNDRY_PROFILE=build-info-v2 FOUNDRY_OUT=out forge test --match-path test-profiles/build-info-v2/test/Validation.t.sol -vvv --ffi --force
FOUNDRY_PROFILE=build-info-v2-bad FOUNDRY_OUT=out forge test --match-path test-profiles/build-info-v2-bad/test/Validation.t.sol -vvv --ffi --force

test "$(find test_artifacts/build-info-v1 -type f -name '*.json' | wc -l | tr -d ' ')" -eq 1
