// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Vm} from "forge-std/Vm.sol";
import {Utils, ContractInfo} from "./Utils.sol";

/**
 * @dev Verifies that a Forge artifact and its unique build-info record came
 * from the same compiler input. Heavy build-info parsing runs in Node through
 * FFI so real Forge build-info files do not exhaust EVM memory.
 */
library ArtifactProvenance {
    error BuildInfoNotFound(string fullyQualifiedName);
    error AmbiguousBuildInfo(string fullyQualifiedName);
    error CreationBytecodeMismatch(string fullyQualifiedName);
    error CompilerVersionMismatch(string artifactVersion, string buildInfoVersion);
    error CompilerBuildMismatch(string artifactVersion, string buildInfoVersion);
    error MissingCompilerIdentity(string buildInfoFile);
    error MissingSource(string sourceName);
    error SourceContentHashMismatch(string sourceName, bytes32 expected, bytes32 actual);
    error ArtifactOutsideOutputDirectory(string artifact, string outputDirectory);
    error BuildInfoIdentityMismatch(string expected, string actual);
    error ProvenanceToolFailure(string reason);

    uint8 private constant BUILD_INFO_NOT_FOUND = 1;
    uint8 private constant AMBIGUOUS_BUILD_INFO = 2;
    uint8 private constant BYTECODE_MISMATCH = 3;
    uint8 private constant COMPILER_VERSION_MISMATCH = 4;
    uint8 private constant MISSING_COMPILER_IDENTITY = 5;
    uint8 private constant MISSING_SOURCE = 6;
    uint8 private constant SOURCE_HASH_MISMATCH = 7;
    uint8 private constant COMPILER_BUILD_MISMATCH = 8;
    uint8 private constant ARTIFACT_OUTSIDE_OUTPUT = 9;
    uint8 private constant BUILD_INFO_IDENTITY_MISMATCH = 10;

    /**
     * @dev Returns keccak256(abi.encode(absoluteOutDir,
     * absoluteBuildInfoFile, artifactCompilerVersion,
     * outputMetadataCompilerVersion, solcVersion, solcLongVersion, FQN,
     * normalizedCreationBytecode, sortedSourceNames, sourceContentKeccaks)).
     * This is a diagnostic/test oracle and is not transported in deployment
     * transactions.
     */
    function assertMatch(string memory contractName, string memory outDir) internal returns (bytes32) {
        ContractInfo memory info = Utils.getContractInfo(contractName, outDir);
        string memory absoluteOutDir = Utils.absoluteOutDir(outDir);

        string[] memory inputs = new string[](9);
        inputs[0] = "node";
        inputs[1] = "-e";
        inputs[2] = Utils.shellQuote(
            "let p;try{p=require.resolve('@openzeppelin/foundry-upgrades-tron/src/internal/artifact-provenance.cjs')}catch{p=require('node:path').resolve('src/internal/artifact-provenance.cjs')}require(p).main(process.argv.slice(1))"
        );
        inputs[3] = Utils.shellQuote(absoluteOutDir);
        inputs[4] = Utils.shellQuote(info.artifactPath);
        inputs[5] = Utils.shellQuote(info.contractPath);
        inputs[6] = Utils.shellQuote(info.shortName);
        inputs[7] = Utils.shellQuote(string.concat(info.contractPath, ":", info.shortName));
        inputs[8] = "2>/dev/null";

        Vm.FfiResult memory result = Utils.runAsBashCommand(inputs);
        if (result.exitCode != 0 || result.stdout.length == 0) {
            revert ProvenanceToolFailure(string(result.stderr));
        }
        (
            uint8 code,
            bytes32 provenanceHash,
            string memory detailA,
            string memory detailB,
            bytes32 expected,
            bytes32 actual
        ) = abi.decode(result.stdout, (uint8, bytes32, string, string, bytes32, bytes32));
        if (code == 0) return provenanceHash;
        if (code == BUILD_INFO_NOT_FOUND) revert BuildInfoNotFound(detailA);
        if (code == AMBIGUOUS_BUILD_INFO) revert AmbiguousBuildInfo(detailA);
        if (code == BYTECODE_MISMATCH) revert CreationBytecodeMismatch(detailA);
        if (code == COMPILER_VERSION_MISMATCH) revert CompilerVersionMismatch(detailA, detailB);
        if (code == MISSING_COMPILER_IDENTITY) revert MissingCompilerIdentity(detailA);
        if (code == MISSING_SOURCE) revert MissingSource(detailA);
        if (code == SOURCE_HASH_MISMATCH) revert SourceContentHashMismatch(detailA, expected, actual);
        if (code == COMPILER_BUILD_MISMATCH) revert CompilerBuildMismatch(detailA, detailB);
        if (code == ARTIFACT_OUTSIDE_OUTPUT) revert ArtifactOutsideOutputDirectory(detailA, detailB);
        if (code == BUILD_INFO_IDENTITY_MISMATCH) revert BuildInfoIdentityMismatch(detailA, detailB);
        revert ProvenanceToolFailure(detailA);
    }
}
