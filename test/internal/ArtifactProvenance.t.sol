// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ArtifactProvenance} from "openzeppelin-foundry-upgrades-tron/internal/ArtifactProvenance.sol";
import {MyContractName} from "../contracts/MyContractFile.sol";

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
                sources,
                sourceHashes
            )
        );
        assertEq(first, expected);
    }

    function testOptionalHexPrefixIsNormalized() public {
        assertNotEq(ArtifactProvenance.assertMatch("Widget.sol:Widget", _fixture("prefixed/out")), bytes32(0));
    }

    function testIdenticalUnlinkedPlaceholdersMatchExactly() public {
        assertNotEq(ArtifactProvenance.assertMatch("Linked.sol:Linked", _fixture("linked/out")), bytes32(0));
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
}

contract ProvenanceInvoker {
    function assertMatch(string memory name, string memory outDir) external returns (bytes32) {
        return ArtifactProvenance.assertMatch(name, outDir);
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
