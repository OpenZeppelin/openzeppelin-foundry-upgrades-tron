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
    error ProvenanceRemappingNotFound();
    error AmbiguousProvenanceRemapping();
    error ProvenanceHelperCandidatesNotFound(string projectRoot, string environmentVariable);
    error AmbiguousProvenanceHelperCandidates(string first, string second, string environmentVariable);
    error ProvenanceHelperNotFound(string path);
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
        string memory helperPath = resolveHelperPath();

        string[] memory inputs = new string[](8);
        inputs[0] = "node";
        inputs[1] = Utils.shellQuote(helperPath);
        inputs[2] = Utils.shellQuote(absoluteOutDir);
        inputs[3] = Utils.shellQuote(info.artifactPath);
        inputs[4] = Utils.shellQuote(info.contractPath);
        inputs[5] = Utils.shellQuote(info.shortName);
        inputs[6] = Utils.shellQuote(string.concat(info.contractPath, ":", info.shortName));
        inputs[7] = "2>/dev/null";

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

    function resolveHelperPath() internal view returns (string memory) {
        Vm vm = Vm(Utils.CHEATCODE_ADDRESS);
        string memory helper = resolveHelperPathFromProjectRoot(
            vm.projectRoot(),
            vm.envOr("OPENZEPPELIN_FOUNDRY_UPGRADES_TRON_PATH", string(""))
        );
        if (!vm.exists(helper)) revert ProvenanceHelperNotFound(helper);
        return helper;
    }

    function resolveHelperPathFromProjectRoot(
        string memory projectRoot,
        string memory explicitSourcePath
    ) internal view returns (string memory) {
        if (bytes(explicitSourcePath).length != 0) {
            return
                Utils.joinPath(Utils.resolvePath(explicitSourcePath, projectRoot), "internal/artifact-provenance.cjs");
        }

        Vm vm = Vm(Utils.CHEATCODE_ADDRESS);
        string memory remappingsFile = Utils.joinPath(projectRoot, "remappings.txt");
        if (vm.exists(remappingsFile)) {
            return resolveHelperPathFromRemappings(vm.readFile(remappingsFile), projectRoot);
        }

        string[3] memory candidates = [
            Utils.joinPath(projectRoot, "lib/openzeppelin-foundry-upgrades-tron/src/internal/artifact-provenance.cjs"),
            Utils.joinPath(
                projectRoot,
                "node_modules/@openzeppelin/foundry-upgrades-tron/src/internal/artifact-provenance.cjs"
            ),
            Utils.joinPath(projectRoot, "src/internal/artifact-provenance.cjs")
        ];
        string memory matchPath;
        for (uint256 i = 0; i < candidates.length; ++i) {
            if (vm.exists(candidates[i])) {
                if (bytes(matchPath).length != 0) {
                    revert AmbiguousProvenanceHelperCandidates(
                        matchPath,
                        candidates[i],
                        "OPENZEPPELIN_FOUNDRY_UPGRADES_TRON_PATH"
                    );
                }
                matchPath = candidates[i];
            }
        }
        if (bytes(matchPath).length == 0) {
            revert ProvenanceHelperCandidatesNotFound(projectRoot, "OPENZEPPELIN_FOUNDRY_UPGRADES_TRON_PATH");
        }
        return matchPath;
    }

    function resolveHelperPathFromRemappings(
        string memory remappings,
        string memory projectRoot
    ) internal pure returns (string memory) {
        string memory prefix = "openzeppelin-foundry-upgrades-tron/=";
        string[] memory lines = Vm(Utils.CHEATCODE_ADDRESS).split(remappings, "\n");
        string memory target;
        uint256 matches;
        for (uint256 i = 0; i < lines.length; ++i) {
            if (_startsWith(lines[i], prefix)) {
                target = _trimTrailingWhitespace(_substring(lines[i], bytes(prefix).length));
                ++matches;
            }
        }
        if (matches == 0 || bytes(target).length == 0) revert ProvenanceRemappingNotFound();
        if (matches != 1) revert AmbiguousProvenanceRemapping();
        return Utils.joinPath(Utils.resolvePath(target, projectRoot), "internal/artifact-provenance.cjs");
    }

    function _startsWith(string memory value, string memory prefix) private pure returns (bool) {
        bytes memory subject = bytes(value);
        bytes memory expected = bytes(prefix);
        if (subject.length < expected.length) return false;
        for (uint256 i = 0; i < expected.length; ++i) {
            if (subject[i] != expected[i]) return false;
        }
        return true;
    }

    function _substring(string memory value, uint256 start) private pure returns (string memory) {
        bytes memory subject = bytes(value);
        bytes memory result = new bytes(subject.length - start);
        for (uint256 i = start; i < subject.length; ++i) result[i - start] = subject[i];
        return string(result);
    }

    function _trimTrailingWhitespace(string memory value) private pure returns (string memory) {
        bytes memory subject = bytes(value);
        uint256 length = subject.length;
        while (
            length > 0 && (subject[length - 1] == 0x0d || subject[length - 1] == 0x20 || subject[length - 1] == 0x09)
        ) {
            --length;
        }
        bytes memory result = new bytes(length);
        for (uint256 i = 0; i < length; ++i) result[i] = subject[i];
        return string(result);
    }
}
