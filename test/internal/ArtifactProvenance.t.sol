// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {LinkedLibrary} from "openzeppelin-foundry-upgrades-tron/Options.sol";
import {ArtifactProvenance} from "openzeppelin-foundry-upgrades-tron/internal/ArtifactProvenance.sol";
import {MyContractName} from "../contracts/MyContractFile.sol";
import {WithExternalLibrary} from "../contracts/WithExternalLibrary.sol";

contract ArtifactProvenanceTest is Test {
    ProvenanceInvoker private invoker;

    function setUp() public {
        invoker = new ProvenanceInvoker();
    }

    function testValidFixtureReturnsDeterministicParityReadyHash() public {
        string memory outDir = _fixture("valid/out");
        bytes32 first = ArtifactProvenance.assertMatch("Widget.sol:Widget", outDir);
        bytes32 second = ArtifactProvenance.assertMatch("Widget.sol:Widget", outDir);
        assertEq(first, second);

        string[] memory sources = new string[](1);
        sources[0] = "contracts/Widget.sol";
        bytes32[] memory sourceHashes = new bytes32[](1);
        sourceHashes[0] = 0xe6d94a5da9fc80f4f65ce5851cd4be0091f7e773bce34524b632c227e7b9758e;
        bytes32 expected = keccak256(
            abi.encode(
                outDir,
                string.concat(outDir, "/build-info/build.json"),
                "0.8.22+commit.4fc1097e",
                "0.8.22+commit.4fc1097e",
                "0.8.22",
                "0.8.22",
                "contracts/Widget.sol:Widget",
                "6001600055",
                // The deployed runtime template, bound alongside creation bytecode; the valid fixture
                // declares no deployedBytecode, so the empty string participates.
                "",
                sources,
                sourceHashes
            )
        );
        assertEq(first, expected);
    }

    function testDetailedResultIncludesArtifactAndNormalizedCreationBytecodeHash() public {
        string memory outDir = _fixture("valid/out");
        ArtifactProvenance.Result memory result = ArtifactProvenance.assertMatchDetailed("Widget.sol:Widget", outDir);

        assertEq(result.provenanceHash, ArtifactProvenance.assertMatch("Widget.sol:Widget", outDir));
        assertEq(result.creationBytecodeHash, keccak256(bytes("6001600055")));
        assertEq(
            result.artifactSnapshotHash,
            keccak256(bytes(vm.readFile(string.concat(outDir, "/Widget.sol/Widget.json"))))
        );
        assertEq(result.artifactPath, string.concat(outDir, "/Widget.sol/Widget.json"));
        assertFalse(result.requiresLinking);
    }

    function testRejectsChangedProvenanceBinding() public {
        ArtifactProvenance.Result memory beforeValidation = ArtifactProvenance.Result({
            provenanceHash: bytes32(uint256(1)),
            creationBytecodeHash: bytes32(uint256(2)),
            artifactSnapshotHash: bytes32(uint256(4)),
            artifactPath: "/tmp/out/Widget.json",
            requiresLinking: false
        });
        ArtifactProvenance.Result memory afterValidation = ArtifactProvenance.Result({
            provenanceHash: bytes32(uint256(3)),
            creationBytecodeHash: bytes32(uint256(2)),
            artifactSnapshotHash: bytes32(uint256(4)),
            artifactPath: "/tmp/out/Widget.json",
            requiresLinking: false
        });

        vm.expectPartialRevert(ArtifactProvenance.ProvenanceChanged.selector);
        invoker.assertUnchanged(beforeValidation, afterValidation);
    }

    function testParsesCreationCodeFromOneBoundArtifactSnapshot() public view {
        string memory artifact = vm.readFile(_fixture("valid/out/Widget.sol/Widget.json"));

        bytes memory creationCode = ArtifactProvenance.creationCodeFromSnapshot(
            artifact,
            keccak256(bytes("6001600055"))
        );

        assertEq(creationCode, hex"6001600055");
    }

    function testRejectsArtifactSnapshotCreationCodeHashMismatch() public {
        string memory artifact = vm.readFile(_fixture("valid/out/Widget.sol/Widget.json"));

        vm.expectPartialRevert(ArtifactProvenance.CreationBytecodeSnapshotMismatch.selector);
        invoker.creationCodeFromSnapshot(artifact, bytes32(uint256(1)));
    }

    function testOptionalHexPrefixIsNormalized() public {
        assertNotEq(ArtifactProvenance.assertMatch("Widget.sol:Widget", _fixture("prefixed/out")), bytes32(0));
    }

    function testIdenticalUnlinkedPlaceholdersMatchExactly() public {
        ArtifactProvenance.Result memory result = ArtifactProvenance.assertMatchDetailed(
            "Linked.sol:Linked",
            _fixture("linked/out")
        );
        assertNotEq(result.provenanceHash, bytes32(0));
        assertTrue(result.requiresLinking);
    }

    function testRejectsMalformedNonHexWithoutValidLinkReferences() public {
        vm.expectPartialRevert(ArtifactProvenance.InvalidLinkReferences.selector);
        invoker.assertMatch("Linked.sol:Linked", _fixture("malformed-linked/out"));
    }

    function testRejectsArtifactSnapshotChangedWhileLinking() public {
        vm.expectPartialRevert(ArtifactProvenance.ArtifactSnapshotChanged.selector);
        invoker.assertArtifactSnapshotUnchanged('{"bytecode":"before"}', '{"bytecode":"after"}');
    }

    function testClassifiesHardhat3TopLevelLinkReferences() public view {
        assertTrue(
            ArtifactProvenance.requiresLinkingFromSnapshot(
                '{"bytecode":"0x73__$e1f6544c3e26610222126859ceeb977ca1$__6000","linkReferences":{"contracts/External.sol":{"External":[{"start":1,"length":20}]}}}'
            )
        );
    }

    function testRejectsOverflowingLinkReferenceStartWithoutPanic() public {
        string memory artifact = string.concat(
            '{"bytecode":{"object":"0x73__$e1f6544c3e26610222126859ceeb977ca1$__6000","linkReferences":{"contracts/External.sol":{"External":[{"start":',
            vm.toString(type(uint256).max),
            ',"length":20}]}}}}'
        );

        vm.expectPartialRevert(ArtifactProvenance.InvalidLinkReferences.selector);
        invoker.requiresLinkingFromSnapshot(artifact);
    }

    function testLinkedSnapshotRequiresExactLiveMapping() public {
        string memory artifact = vm.readFile(
            string.concat(vm.projectRoot(), "/out/WithExternalLibrary.sol/WithExternalLibrary.json")
        );
        LinkedLibrary[] memory mappings = new LinkedLibrary[](0);

        vm.expectPartialRevert(ArtifactProvenance.MissingLinkedLibrary.selector);
        invoker.creationCodeFromSnapshotWithLibraries(artifact, mappings);
    }

    function testLinkedSnapshotMappingIdentityIsCaseSensitive() public {
        string memory artifact = vm.readFile(
            string.concat(vm.projectRoot(), "/out/WithExternalLibrary.sol/WithExternalLibrary.json")
        );
        address libraryAddress = address(0x1001);
        vm.etch(libraryAddress, hex"00");
        LinkedLibrary[] memory mappings = new LinkedLibrary[](1);
        mappings[0] = LinkedLibrary("test/contracts/WithExternalLibrary.sol", "externalMath", libraryAddress);

        vm.expectPartialRevert(ArtifactProvenance.MissingLinkedLibrary.selector);
        invoker.creationCodeFromSnapshotWithLibraries(artifact, mappings);
    }

    function testRepeatedReferencesReuseOneExactMapping() public {
        string memory placeholder = "__$e1f6544c3e26610222126859ceeb977ca1$__";
        string memory artifact = string.concat(
            '{"bytecode":"0x73',
            placeholder,
            "6000",
            placeholder,
            '","linkReferences":{"contracts/External.sol":{"External":[{"start":1,"length":20},{"start":23,"length":20}]}}}'
        );
        address libraryAddress = address(0x1001);
        vm.etch(libraryAddress, hex"00");
        LinkedLibrary[] memory mappings = new LinkedLibrary[](1);
        mappings[0] = LinkedLibrary("contracts/External.sol", "External", libraryAddress);

        bytes memory linked = invoker.creationCodeFromSnapshotWithLibraries(artifact, mappings);

        assertEq(
            linked,
            vm.parseBytes("0x73000000000000000000000000000000000000100160000000000000000000000000000000000000001001")
        );
    }

    function testLinkedSnapshotRejectsDuplicateMapping() public {
        string memory artifact = vm.readFile(
            string.concat(vm.projectRoot(), "/out/WithExternalLibrary.sol/WithExternalLibrary.json")
        );
        address libraryAddress = address(0x1001);
        vm.etch(libraryAddress, hex"00");
        LinkedLibrary[] memory mappings = new LinkedLibrary[](2);
        mappings[0] = _externalMath(libraryAddress);
        mappings[1] = _externalMath(libraryAddress);

        vm.expectPartialRevert(ArtifactProvenance.DuplicateLinkedLibrary.selector);
        invoker.creationCodeFromSnapshotWithLibraries(artifact, mappings);
    }

    function testLinkedSnapshotRejectsUnusedMapping() public {
        string memory artifact = vm.readFile(
            string.concat(vm.projectRoot(), "/out/WithExternalLibrary.sol/WithExternalLibrary.json")
        );
        address libraryAddress = address(0x1001);
        address unusedAddress = address(0x1002);
        vm.etch(libraryAddress, hex"00");
        vm.etch(unusedAddress, hex"00");
        LinkedLibrary[] memory mappings = new LinkedLibrary[](2);
        mappings[0] = _externalMath(libraryAddress);
        mappings[1] = LinkedLibrary("test/contracts/Unused.sol", "Unused", unusedAddress);

        vm.expectPartialRevert(ArtifactProvenance.UnusedLinkedLibrary.selector);
        invoker.creationCodeFromSnapshotWithLibraries(artifact, mappings);
    }

    function testLinkedSnapshotRejectsZeroAndCodelessAddresses() public {
        string memory artifact = vm.readFile(
            string.concat(vm.projectRoot(), "/out/WithExternalLibrary.sol/WithExternalLibrary.json")
        );
        LinkedLibrary[] memory mappings = new LinkedLibrary[](1);
        mappings[0] = _externalMath(address(0));

        vm.expectPartialRevert(ArtifactProvenance.InvalidLinkedLibraryAddress.selector);
        invoker.creationCodeFromSnapshotWithLibraries(artifact, mappings);

        mappings[0] = _externalMath(address(0xBEEF));
        vm.expectPartialRevert(ArtifactProvenance.LinkedLibraryHasNoCode.selector);
        invoker.creationCodeFromSnapshotWithLibraries(artifact, mappings);
    }

    function testPrelinkedSnapshotRejectsAnyMappingAsUnused() public {
        string memory artifact = vm.readFile(_fixture("valid/out/Widget.sol/Widget.json"));
        address libraryAddress = address(0x1001);
        vm.etch(libraryAddress, hex"00");
        LinkedLibrary[] memory mappings = new LinkedLibrary[](1);
        mappings[0] = _externalMath(libraryAddress);

        vm.expectPartialRevert(ArtifactProvenance.UnusedLinkedLibrary.selector);
        invoker.creationCodeFromSnapshotWithLibraries(artifact, mappings);
    }

    function testRejectsCreationBytecodeMismatch() public {
        vm.expectPartialRevert(ArtifactProvenance.CreationBytecodeMismatch.selector);
        invoker.assertMatch("Widget.sol:Widget", _fixture("bytecode-mismatch/out"));
    }

    function testRejectsMetadataCompilerVersionMismatch() public {
        vm.expectPartialRevert(ArtifactProvenance.CompilerVersionMismatch.selector);
        invoker.assertMatch("Widget.sol:Widget", _fixture("compiler-mismatch/out"));
    }

    function testRejectsSameSemverWithDifferentCompilerBuild() public {
        vm.expectPartialRevert(ArtifactProvenance.CompilerBuildMismatch.selector);
        invoker.assertMatch("Widget.sol:Widget", _fixture("compiler-build-mismatch/out"));
    }

    function testRejectsOutputMetadataCompilerBuildMismatchWhenTopLevelIsSemanticOnly() public {
        vm.expectPartialRevert(ArtifactProvenance.CompilerBuildMismatch.selector);
        invoker.assertMatch("Widget.sol:Widget", _fixture("output-compiler-mismatch/out"));
    }

    function testSupportsHardhat3SplitBuildInfoAndCanonicalSourceMapping() public {
        assertNotEq(
            ArtifactProvenance.assertMatch("Widget.sol:Widget", _fixture("hh3-valid/artifacts/contracts")),
            bytes32(0)
        );
    }

    function testRejectsHardhat3OutputWithMismatchedBuildInfoId() public {
        vm.expectPartialRevert(ArtifactProvenance.BuildInfoIdentityMismatch.selector);
        invoker.assertMatch("Widget.sol:Widget", _fixture("hh3-mismatched-output/artifacts/contracts"));
    }

    function testRejectsMissingCompilerBuildIdentity() public {
        vm.expectPartialRevert(ArtifactProvenance.MissingCompilerIdentity.selector);
        invoker.assertMatch("Widget.sol:Widget", _fixture("compiler-identity-missing/out"));
    }

    function testMatchesRealForgeArtifactShape() public {
        assertNotEq(ArtifactProvenance.assertMatch("MyContractFile.sol:MyContractName", "out"), bytes32(0));
    }

    function testVerifiesEveryMetadataSourceContentHash() public {
        vm.expectPartialRevert(ArtifactProvenance.SourceContentHashMismatch.selector);
        invoker.assertMatch("Widget.sol:Widget", _fixture("source-mismatch/out"));
    }

    function testRejectsMissingBuildInfoSource() public {
        vm.expectPartialRevert(ArtifactProvenance.MissingSource.selector);
        invoker.assertMatch("Widget.sol:Widget", _fixture("missing-source/out"));
    }

    function testRejectsMissingBuildInfoTarget() public {
        vm.expectPartialRevert(ArtifactProvenance.BuildInfoNotFound.selector);
        invoker.assertMatch("Widget.sol:Widget", _fixture("missing-target/out"));
    }

    function testRejectsAmbiguousBuildInfoIncludingSameSemverDifferentBuild() public {
        vm.expectPartialRevert(ArtifactProvenance.AmbiguousBuildInfo.selector);
        invoker.assertMatch("Widget.sol:Widget", _fixture("ambiguous/out"));
    }

    function testAbsoluteFoundryOutIsPartOfHash() public {
        bytes32 validHash = ArtifactProvenance.assertMatch("Widget.sol:Widget", _fixture("valid/out"));
        bytes32 copyHash = ArtifactProvenance.assertMatch("Widget.sol:Widget", _fixture("valid-copy/out"));
        assertNotEq(validHash, copyHash);
    }

    function testRejectsArtifactFromDifferentAbsoluteFoundryOut() public {
        vm.expectPartialRevert(ArtifactProvenance.ArtifactOutsideOutputDirectory.selector);
        invoker.assertMatch("test/fixtures/provenance/valid/out/Widget.sol/Widget.json", _fixture("valid-copy/out"));
    }

    function testResolvesLocalAndInstalledRemappingTargets() public pure {
        string memory root = "/tmp/consumer project";
        assertEq(
            ArtifactProvenance.resolveHelperPathFromRemappings(
                "openzeppelin-foundry-upgrades-tron/=src/\nforge-std/=lib/forge-std/src/\n",
                root
            ),
            "/tmp/consumer project/src/internal/artifact-provenance.cjs"
        );
        assertEq(
            ArtifactProvenance.resolveHelperPathFromRemappings(
                "openzeppelin-foundry-upgrades-tron/=lib/openzeppelin-foundry-upgrades-tron/src/\n",
                root
            ),
            "/tmp/consumer project/lib/openzeppelin-foundry-upgrades-tron/src/internal/artifact-provenance.cjs"
        );
        assertEq(
            ArtifactProvenance.resolveHelperPathFromRemappings(
                "openzeppelin-foundry-upgrades-tron/=lib/openzeppelin-foundry-upgrades-tron/src/\r\n",
                "C:\\consumer project"
            ),
            "C:\\consumer project\\lib\\openzeppelin-foundry-upgrades-tron\\src\\internal\\artifact-provenance.cjs"
        );
    }

    function testRejectsMissingOrAmbiguousProvenanceRemapping() public {
        vm.expectPartialRevert(ArtifactProvenance.ProvenanceRemappingNotFound.selector);
        invoker.resolveHelperPathFromRemappings("forge-std/=lib/forge-std/src/\n", "/tmp/project");

        vm.expectPartialRevert(ArtifactProvenance.AmbiguousProvenanceRemapping.selector);
        invoker.resolveHelperPathFromRemappings(
            "openzeppelin-foundry-upgrades-tron/=src/\nopenzeppelin-foundry-upgrades-tron/=lib/package/src/\n",
            "/tmp/project"
        );
    }

    function testResolvedHelperExistsForCurrentCheckout() public view {
        assertEq(
            ArtifactProvenance.resolveHelperPath(),
            string.concat(vm.projectRoot(), "/src/internal/artifact-provenance.cjs")
        );
    }

    function testResolvesHelperFromProjectRemappingsFileWithoutNestedForge() public view {
        assertEq(
            ArtifactProvenance.resolveHelperPathFromProjectRoot(vm.projectRoot(), ""),
            string.concat(vm.projectRoot(), "/src/internal/artifact-provenance.cjs")
        );
    }

    function testExplicitPackageSourcePathSupportsNonFileRemappingSetups() public view {
        assertEq(
            ArtifactProvenance.resolveHelperPathFromProjectRoot("/tmp/consumer", "/opt/package/src/"),
            "/opt/package/src/internal/artifact-provenance.cjs"
        );
    }

    function testResolvesForgeInstallWithoutRemappingsFile() public view {
        string memory root = _helperFixture("forge-install");
        assertEq(
            ArtifactProvenance.resolveHelperPathFromProjectRoot(root, ""),
            string.concat(root, "/lib/openzeppelin-foundry-upgrades-tron/src/internal/artifact-provenance.cjs")
        );
    }

    function testUnrelatedRemappingsFileFallsBackToStandardForgeInstall() public view {
        string memory root = _helperFixture("unrelated-remappings");
        assertEq(
            ArtifactProvenance.resolveHelperPathFromProjectRoot(root, ""),
            string.concat(root, "/lib/openzeppelin-foundry-upgrades-tron/src/internal/artifact-provenance.cjs")
        );
    }

    function testResolvesNpmInstallWithoutRemappingsFile() public view {
        string memory root = _helperFixture("npm-install");
        assertEq(
            ArtifactProvenance.resolveHelperPathFromProjectRoot(root, ""),
            string.concat(
                root,
                "/node_modules/@openzeppelin/foundry-upgrades-tron/src/internal/artifact-provenance.cjs"
            )
        );
    }

    function testResolvesPackageLocalHelperWithoutRemappingsFile() public view {
        string memory root = _helperFixture("package-local");
        assertEq(
            ArtifactProvenance.resolveHelperPathFromProjectRoot(root, ""),
            string.concat(root, "/src/internal/artifact-provenance.cjs")
        );
    }

    function testRejectsAmbiguousStandardInstallCandidates() public {
        vm.expectPartialRevert(ArtifactProvenance.AmbiguousProvenanceHelperCandidates.selector);
        invoker.resolveHelperPathFromProjectRoot(_helperFixture("ambiguous"), "");
    }

    function testAmbiguousPackageRemappingsFailBeforeStandardCandidateDiscovery() public {
        vm.expectPartialRevert(ArtifactProvenance.AmbiguousProvenanceRemapping.selector);
        invoker.resolveHelperPathFromProjectRoot(_helperFixture("ambiguous-remappings"), "");
    }

    function testRejectsMissingStandardInstallCandidate() public {
        vm.expectPartialRevert(ArtifactProvenance.ProvenanceHelperCandidatesNotFound.selector);
        invoker.resolveHelperPathFromProjectRoot(_fixture("valid/out"), "");
    }

    function _fixture(string memory suffix) private view returns (string memory) {
        return string.concat(vm.projectRoot(), "/test/fixtures/provenance/", suffix);
    }

    function _helperFixture(string memory suffix) private view returns (string memory) {
        return string.concat(vm.projectRoot(), "/test/fixtures/helper-resolution/", suffix);
    }

    function _externalMath(address libraryAddress) private pure returns (LinkedLibrary memory) {
        return
            LinkedLibrary({
                sourceName: "test/contracts/WithExternalLibrary.sol",
                libraryName: "ExternalMath",
                libraryAddress: libraryAddress
            });
    }
}

contract ProvenanceInvoker {
    function assertMatch(string memory name, string memory outDir) external returns (bytes32) {
        return ArtifactProvenance.assertMatch(name, outDir);
    }

    function assertUnchanged(
        ArtifactProvenance.Result memory beforeValidation,
        ArtifactProvenance.Result memory afterValidation
    ) external pure {
        ArtifactProvenance.assertUnchanged(beforeValidation, afterValidation);
    }

    function creationCodeFromSnapshot(
        string memory artifact,
        bytes32 expectedBytecodeHash
    ) external view returns (bytes memory) {
        return ArtifactProvenance.creationCodeFromSnapshot(artifact, expectedBytecodeHash);
    }

    function assertArtifactSnapshotUnchanged(string memory beforeLinking, string memory afterLinking) external pure {
        ArtifactProvenance.assertArtifactSnapshotUnchanged(beforeLinking, afterLinking);
    }

    function requiresLinkingFromSnapshot(string memory artifact) external view returns (bool) {
        return ArtifactProvenance.requiresLinkingFromSnapshot(artifact);
    }

    function creationCodeFromSnapshotWithLibraries(
        string memory artifact,
        LinkedLibrary[] memory mappings
    ) external view returns (bytes memory) {
        return ArtifactProvenance.creationCodeFromSnapshot(artifact, bytes32(0), mappings);
    }

    function resolveHelperPathFromRemappings(
        string memory remappings,
        string memory projectRoot
    ) external pure returns (string memory) {
        return ArtifactProvenance.resolveHelperPathFromRemappings(remappings, projectRoot);
    }

    function resolveHelperPathFromProjectRoot(
        string memory projectRoot,
        string memory explicitSourcePath
    ) external view returns (string memory) {
        return ArtifactProvenance.resolveHelperPathFromProjectRoot(projectRoot, explicitSourcePath);
    }
}
