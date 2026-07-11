// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Vm} from "forge-std/Vm.sol";
import {LinkedLibrary} from "../Options.sol";
import {Utils, ContractInfo} from "./Utils.sol";

/**
 * @dev Verifies that a Forge artifact and its unique build-info record came
 * from the same compiler input. Heavy build-info parsing runs in Node through
 * FFI so real Forge build-info files do not exhaust EVM memory.
 */
library ArtifactProvenance {
    struct LinkReference {
        uint256 length;
        uint256 start;
    }

    struct Result {
        bytes32 provenanceHash;
        bytes32 creationBytecodeHash;
        bytes32 artifactSnapshotHash;
        string artifactPath;
        bool requiresLinking;
    }

    string private constant PROVENANCE_REMAPPING = "openzeppelin-foundry-upgrades-tron/=";

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
    error ProvenanceChanged(bytes32 expected, bytes32 actual);
    error CreationBytecodeSnapshotMismatch(bytes32 expected, bytes32 actual);
    error InvalidLinkReferences(string fullyQualifiedName);
    error ArtifactSnapshotChanged(bytes32 expected, bytes32 actual);
    error MissingLinkedLibrary(string sourceName, string libraryName);
    error DuplicateLinkedLibrary(string sourceName, string libraryName);
    error UnusedLinkedLibrary(string sourceName, string libraryName);
    error InvalidLinkedLibraryAddress(string sourceName, string libraryName);
    error LinkedLibraryHasNoCode(string sourceName, string libraryName, address libraryAddress);

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
    uint8 private constant INVALID_LINK_REFERENCES = 11;

    /**
     * @dev Returns keccak256(abi.encode(absoluteOutDir,
     * absoluteBuildInfoFile, artifactCompilerVersion,
     * outputMetadataCompilerVersion, solcVersion, solcLongVersion, FQN,
     * normalizedCreationBytecode, sortedSourceNames, sourceContentKeccaks)).
     * This is a diagnostic/test oracle and is not transported in deployment
     * transactions.
     */
    function assertMatch(string memory contractName, string memory outDir) internal returns (bytes32) {
        return assertMatchDetailed(contractName, outDir).provenanceHash;
    }

    /**
     * @dev Verifies compiler provenance and returns the artifact identity plus
     * a hash of its normalized creation-bytecode string. Callers can bind a
     * later in-memory artifact snapshot to this result without trusting a
     * second artifact load.
     */
    function assertMatchDetailed(string memory contractName, string memory outDir) internal returns (Result memory) {
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
            bytes32 creationBytecodeHash,
            bytes32 artifactSnapshotHash,
            bool requiresLinking,
            string memory detailA,
            string memory detailB,
            bytes32 expected,
            bytes32 actual
        ) = abi.decode(result.stdout, (uint8, bytes32, bytes32, bytes32, bool, string, string, bytes32, bytes32));
        if (code == 0) {
            return
                Result(provenanceHash, creationBytecodeHash, artifactSnapshotHash, info.artifactPath, requiresLinking);
        }
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
        if (code == INVALID_LINK_REFERENCES) revert InvalidLinkReferences(detailA);
        revert ProvenanceToolFailure(detailA);
    }

    function assertUnchanged(Result memory expected, Result memory actual) internal pure {
        if (
            expected.provenanceHash != actual.provenanceHash ||
            expected.creationBytecodeHash != actual.creationBytecodeHash ||
            expected.artifactSnapshotHash != actual.artifactSnapshotHash ||
            keccak256(bytes(expected.artifactPath)) != keccak256(bytes(actual.artifactPath)) ||
            expected.requiresLinking != actual.requiresLinking
        ) {
            revert ProvenanceChanged(expected.provenanceHash, actual.provenanceHash);
        }
    }

    /**
     * @dev Parses creation code from one already-loaded artifact snapshot.
     * A zero expected hash is the explicit unbound mode used only when
     * `unsafeSkipAllChecks` bypassed validation.
     */
    function creationCodeFromSnapshot(
        string memory artifactJson,
        bytes32 expectedBytecodeHash
    ) internal view returns (bytes memory) {
        LinkedLibrary[] memory linkedLibraries = new LinkedLibrary[](0);
        return creationCodeFromSnapshot(artifactJson, bytes32(0), expectedBytecodeHash, linkedLibraries);
    }

    function creationCodeFromSnapshot(
        string memory artifactJson,
        bytes32 expectedBytecodeHash,
        LinkedLibrary[] memory linkedLibraries
    ) internal view returns (bytes memory) {
        return creationCodeFromSnapshot(artifactJson, bytes32(0), expectedBytecodeHash, linkedLibraries);
    }

    function creationCodeFromSnapshot(
        string memory artifactJson,
        bytes32 expectedArtifactSnapshotHash,
        bytes32 expectedBytecodeHash,
        LinkedLibrary[] memory linkedLibraries
    ) internal view returns (bytes memory) {
        bytes32 actualArtifactSnapshotHash = keccak256(bytes(artifactJson));
        if (expectedArtifactSnapshotHash != bytes32(0) && expectedArtifactSnapshotHash != actualArtifactSnapshotHash) {
            revert ArtifactSnapshotChanged(expectedArtifactSnapshotHash, actualArtifactSnapshotHash);
        }

        Vm vm = Vm(Utils.CHEATCODE_ADDRESS);
        bool forgeArtifact = vm.keyExistsJson(artifactJson, ".bytecode.object");
        string memory bytecode =
            forgeArtifact
                ? vm.parseJsonString(artifactJson, ".bytecode.object")
                : vm.parseJsonString(artifactJson, ".bytecode");
        string memory normalized = _normalizeBytecode(bytecode);
        _assertCreationBytecodeHash(normalized, expectedBytecodeHash);
        bytes memory linkedBytecode = bytes(normalized);
        string memory linkReferencesRoot = forgeArtifact ? ".bytecode.linkReferences" : ".linkReferences";

        if (!requiresLinkingFromSnapshot(artifactJson)) {
            if (linkedLibraries.length != 0) {
                revert UnusedLinkedLibrary(linkedLibraries[0].sourceName, linkedLibraries[0].libraryName);
            }
            return vm.parseBytes(string.concat("0x", string(linkedBytecode)));
        }

        bool[] memory used = _validateLinkedLibraries(linkedLibraries);
        uint256 references = _linkReferences(artifactJson, linkReferencesRoot, linkedBytecode, linkedLibraries, used);
        if (references == 0) revert InvalidLinkReferences("");
        if (!_isHex(linkedBytecode)) revert InvalidLinkReferences("");
        for (uint256 i = 0; i < linkedLibraries.length; ++i) {
            if (!used[i]) {
                revert UnusedLinkedLibrary(linkedLibraries[i].sourceName, linkedLibraries[i].libraryName);
            }
        }
        return vm.parseBytes(string.concat("0x", string(linkedBytecode)));
    }

    function assertCreationBytecodeSnapshot(string memory artifactJson, bytes32 expectedBytecodeHash) internal view {
        Vm vm = Vm(Utils.CHEATCODE_ADDRESS);
        string memory bytecode =
            vm.keyExistsJson(artifactJson, ".bytecode.object")
                ? vm.parseJsonString(artifactJson, ".bytecode.object")
                : vm.parseJsonString(artifactJson, ".bytecode");
        _assertCreationBytecodeHash(_normalizeBytecode(bytecode), expectedBytecodeHash);
    }

    function assertArtifactSnapshotUnchanged(string memory beforeLinking, string memory afterLinking) internal pure {
        bytes32 expected = keccak256(bytes(beforeLinking));
        bytes32 actual = keccak256(bytes(afterLinking));
        if (expected != actual) revert ArtifactSnapshotChanged(expected, actual);
    }

    /**
     * @dev Classifies an artifact snapshot without invoking provenance or the
     * validation CLI. This is used by the explicit `unsafeSkipAllChecks`
     * deployment path. Non-hex bytecode is accepted only when every range in
     * nonempty Solidity linkReferences contains a standard modern placeholder.
     */
    function requiresLinkingFromSnapshot(string memory artifactJson) internal view returns (bool) {
        Vm vm = Vm(Utils.CHEATCODE_ADDRESS);
        bool forgeArtifact = vm.keyExistsJson(artifactJson, ".bytecode.object");
        string memory bytecode =
            forgeArtifact
                ? vm.parseJsonString(artifactJson, ".bytecode.object")
                : vm.parseJsonString(artifactJson, ".bytecode");
        bytes memory normalized = bytes(_normalizeBytecode(bytecode));
        bool initiallyHex = _isHex(normalized);
        string memory linkReferencesRoot = forgeArtifact ? ".bytecode.linkReferences" : ".linkReferences";

        if (!vm.keyExistsJson(artifactJson, linkReferencesRoot)) {
            if (!initiallyHex) revert InvalidLinkReferences("");
            return false;
        }

        uint256 references = _consumeLinkReferences(artifactJson, linkReferencesRoot, normalized);

        if (references == 0) {
            if (!initiallyHex) revert InvalidLinkReferences("");
            return false;
        }
        if (!_isHex(normalized)) revert InvalidLinkReferences("");
        return true;
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
            string memory remappings = vm.readFile(remappingsFile);
            if (_containsProvenanceRemapping(remappings)) {
                return resolveHelperPathFromRemappings(remappings, projectRoot);
            }
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
        string[] memory lines = Vm(Utils.CHEATCODE_ADDRESS).split(remappings, "\n");
        string memory target;
        uint256 matches;
        for (uint256 i = 0; i < lines.length; ++i) {
            if (_startsWith(lines[i], PROVENANCE_REMAPPING)) {
                target = _trimTrailingWhitespace(_substring(lines[i], bytes(PROVENANCE_REMAPPING).length));
                ++matches;
            }
        }
        if (matches == 0 || bytes(target).length == 0) revert ProvenanceRemappingNotFound();
        if (matches != 1) revert AmbiguousProvenanceRemapping();
        return Utils.joinPath(Utils.resolvePath(target, projectRoot), "internal/artifact-provenance.cjs");
    }

    function _containsProvenanceRemapping(string memory remappings) private pure returns (bool) {
        string[] memory lines = Vm(Utils.CHEATCODE_ADDRESS).split(remappings, "\n");
        for (uint256 i = 0; i < lines.length; ++i) {
            if (_startsWith(lines[i], PROVENANCE_REMAPPING)) return true;
        }
        return false;
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

    function _normalizeBytecode(string memory value) private pure returns (string memory) {
        bytes memory raw = bytes(value);
        uint256 start = raw.length >= 2 && raw[0] == "0" && (raw[1] == "x" || raw[1] == "X") ? 2 : 0;
        bytes memory normalized = new bytes(raw.length - start);
        for (uint256 i = start; i < raw.length; ++i) normalized[i - start] = raw[i];
        return string(normalized);
    }

    function _assertCreationBytecodeHash(string memory normalized, bytes32 expectedBytecodeHash) private pure {
        bytes32 actualBytecodeHash = keccak256(bytes(normalized));
        if (expectedBytecodeHash != bytes32(0) && actualBytecodeHash != expectedBytecodeHash) {
            revert CreationBytecodeSnapshotMismatch(expectedBytecodeHash, actualBytecodeHash);
        }
    }

    function _validateLinkedLibraries(
        LinkedLibrary[] memory linkedLibraries
    ) private view returns (bool[] memory used) {
        used = new bool[](linkedLibraries.length);
        for (uint256 i = 0; i < linkedLibraries.length; ++i) {
            LinkedLibrary memory entry = linkedLibraries[i];
            if (entry.libraryAddress == address(0)) {
                revert InvalidLinkedLibraryAddress(entry.sourceName, entry.libraryName);
            }
            if (entry.libraryAddress.code.length == 0) {
                revert LinkedLibraryHasNoCode(entry.sourceName, entry.libraryName, entry.libraryAddress);
            }
            for (uint256 j = 0; j < i; ++j) {
                if (
                    _sameString(entry.sourceName, linkedLibraries[j].sourceName) &&
                    _sameString(entry.libraryName, linkedLibraries[j].libraryName)
                ) {
                    revert DuplicateLinkedLibrary(entry.sourceName, entry.libraryName);
                }
            }
        }
    }

    function _linkReferences(
        string memory artifactJson,
        string memory root,
        bytes memory bytecode,
        LinkedLibrary[] memory linkedLibraries,
        bool[] memory used
    ) private pure returns (uint256 references) {
        Vm vm = Vm(Utils.CHEATCODE_ADDRESS);
        string[] memory sources = vm.parseJsonKeys(artifactJson, root);
        for (uint256 i = 0; i < sources.length; ++i) {
            references += _linkSourceReferences(
                artifactJson,
                _jsonChild(root, sources[i]),
                sources[i],
                bytecode,
                linkedLibraries,
                used
            );
        }
    }

    function _linkSourceReferences(
        string memory artifactJson,
        string memory sourcePath,
        string memory sourceName,
        bytes memory bytecode,
        LinkedLibrary[] memory linkedLibraries,
        bool[] memory used
    ) private pure returns (uint256 references) {
        Vm vm = Vm(Utils.CHEATCODE_ADDRESS);
        string[] memory libraries = vm.parseJsonKeys(artifactJson, sourcePath);
        for (uint256 i = 0; i < libraries.length; ++i) {
            references += _linkLibraryReferences(
                artifactJson,
                _jsonChild(sourcePath, libraries[i]),
                sourceName,
                libraries[i],
                bytecode,
                linkedLibraries,
                used
            );
        }
    }

    function _linkLibraryReferences(
        string memory artifactJson,
        string memory libraryPath,
        string memory sourceName,
        string memory libraryName,
        bytes memory bytecode,
        LinkedLibrary[] memory linkedLibraries,
        bool[] memory used
    ) private pure returns (uint256 references) {
        LinkReference[] memory entries = abi.decode(
            Vm(Utils.CHEATCODE_ADDRESS).parseJson(artifactJson, libraryPath),
            (LinkReference[])
        );
        if (entries.length == 0) revert InvalidLinkReferences("");
        uint256 mappingIndex = _findLinkedLibrary(linkedLibraries, sourceName, libraryName);
        used[mappingIndex] = true;
        address libraryAddress = linkedLibraries[mappingIndex].libraryAddress;
        for (uint256 i = 0; i < entries.length; ++i) {
            if (!_linkPlaceholder(bytecode, entries[i], sourceName, libraryName, libraryAddress)) {
                revert InvalidLinkReferences("");
            }
            ++references;
        }
    }

    function _findLinkedLibrary(
        LinkedLibrary[] memory linkedLibraries,
        string memory sourceName,
        string memory libraryName
    ) private pure returns (uint256) {
        for (uint256 i = 0; i < linkedLibraries.length; ++i) {
            if (
                _sameString(sourceName, linkedLibraries[i].sourceName) &&
                _sameString(libraryName, linkedLibraries[i].libraryName)
            ) return i;
        }
        revert MissingLinkedLibrary(sourceName, libraryName);
    }

    function _linkPlaceholder(
        bytes memory bytecode,
        LinkReference memory entry,
        string memory sourceName,
        string memory libraryName,
        address libraryAddress
    ) private pure returns (bool) {
        if (!_placeholderMatches(bytecode, entry, sourceName, libraryName)) return false;
        uint256 start = entry.start * 2;
        bytes20 rawAddress = bytes20(libraryAddress);
        for (uint256 i = 0; i < 20; ++i) {
            uint8 value = uint8(rawAddress[i]);
            bytecode[start + i * 2] = _hexCharacter(value >> 4);
            bytecode[start + i * 2 + 1] = _hexCharacter(value & 0x0f);
        }
        return true;
    }

    function _consumePlaceholder(
        bytes memory bytecode,
        LinkReference memory entry,
        string memory sourceName,
        string memory libraryName
    ) private pure returns (bool) {
        if (!_placeholderMatches(bytecode, entry, sourceName, libraryName)) return false;
        uint256 start = entry.start * 2;
        for (uint256 i = start; i < start + 40; ++i) bytecode[i] = "0";
        return true;
    }

    function _placeholderMatches(
        bytes memory bytecode,
        LinkReference memory entry,
        string memory sourceName,
        string memory libraryName
    ) private pure returns (bool) {
        if (entry.length != 20) return false;
        if (entry.start > type(uint256).max / 2) return false;
        uint256 start = entry.start * 2;
        if (start > bytecode.length || bytecode.length - start < 40) return false;
        if (bytecode[start] != "_" || bytecode[start + 1] != "_" || bytecode[start + 2] != "$") return false;
        bytes32 identity = keccak256(bytes(string.concat(sourceName, ":", libraryName)));
        for (uint256 i = 0; i < 17; ++i) {
            uint8 value = uint8(identity[i]);
            if (bytecode[start + 3 + i * 2] != _hexCharacter(value >> 4)) return false;
            if (bytecode[start + 4 + i * 2] != _hexCharacter(value & 0x0f)) return false;
        }
        if (bytecode[start + 37] != "$" || bytecode[start + 38] != "_" || bytecode[start + 39] != "_") {
            return false;
        }
        return true;
    }

    function _consumeLinkReferences(
        string memory artifactJson,
        string memory root,
        bytes memory bytecode
    ) private pure returns (uint256 references) {
        Vm vm = Vm(Utils.CHEATCODE_ADDRESS);
        string[] memory sources = vm.parseJsonKeys(artifactJson, root);
        for (uint256 i = 0; i < sources.length; ++i) {
            references += _consumeSourceLinkReferences(
                artifactJson,
                _jsonChild(root, sources[i]),
                sources[i],
                bytecode
            );
        }
    }

    function _consumeSourceLinkReferences(
        string memory artifactJson,
        string memory sourcePath,
        string memory sourceName,
        bytes memory bytecode
    ) private pure returns (uint256 references) {
        Vm vm = Vm(Utils.CHEATCODE_ADDRESS);
        string[] memory libraries = vm.parseJsonKeys(artifactJson, sourcePath);
        for (uint256 i = 0; i < libraries.length; ++i) {
            LinkReference[] memory entries = abi.decode(
                vm.parseJson(artifactJson, _jsonChild(sourcePath, libraries[i])),
                (LinkReference[])
            );
            if (entries.length == 0) revert InvalidLinkReferences("");
            for (uint256 j = 0; j < entries.length; ++j) {
                if (!_consumePlaceholder(bytecode, entries[j], sourceName, libraries[i])) {
                    revert InvalidLinkReferences("");
                }
                ++references;
            }
        }
    }

    function _isHex(bytes memory value) private pure returns (bool) {
        for (uint256 i = 0; i < value.length; ++i) {
            if (!_isHexCharacter(value[i])) return false;
        }
        return true;
    }

    function _isHexCharacter(bytes1 character) private pure returns (bool) {
        return
            (character >= "0" && character <= "9") ||
            (character >= "a" && character <= "f") ||
            (character >= "A" && character <= "F");
    }

    function _hexCharacter(uint8 nibble) private pure returns (bytes1) {
        return bytes1(nibble < 10 ? nibble + 48 : nibble + 87);
    }

    function _sameString(string memory left, string memory right) private pure returns (bool) {
        return keccak256(bytes(left)) == keccak256(bytes(right));
    }

    function _jsonChild(string memory parent, string memory key) private pure returns (string memory) {
        return string.concat(parent, ".['", key, "']");
    }
}
