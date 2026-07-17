#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

scratch="$(mktemp -d "$root/test_artifacts.XXXXXX")"
out_v1="$scratch/out-v1"
out_v2="$scratch/out-v2"
out_v2_bad="$scratch/out-v2-bad"
reference_v1="$scratch/build-info-v1"
cache="$scratch/cache"
mkdir -p "$root/out"
sentinel="$(mktemp "$root/out/.reference-builds-preservation-sentinel.XXXXXX")"

cleanup() {
  rm -rf "$scratch"
  rm -f "$sentinel"
}
trap cleanup EXIT

FOUNDRY_CACHE_PATH="$cache" FOUNDRY_PROFILE=build-info-v1 FOUNDRY_OUT="$out_v1" forge build --force
test "$(find "$out_v1/build-info" -type f -name '*.json' | wc -l | tr -d ' ')" -eq 1
mkdir -p "$reference_v1"
cp "$out_v1"/build-info/*.json "$reference_v1"/

REFERENCE_BUILD_INFO_DIR="$reference_v1" FOUNDRY_CACHE_PATH="$cache" FOUNDRY_PROFILE=build-info-v2 FOUNDRY_OUT="$out_v2" forge test --match-path test-profiles/build-info-v2/test/Validation.t.sol -vvv --ffi --force
REFERENCE_BUILD_INFO_DIR="$reference_v1" FOUNDRY_CACHE_PATH="$cache" FOUNDRY_PROFILE=build-info-v2-bad FOUNDRY_OUT="$out_v2_bad" forge test --match-path test-profiles/build-info-v2-bad/test/Validation.t.sol -vvv --ffi --force

test -f "$sentinel"
