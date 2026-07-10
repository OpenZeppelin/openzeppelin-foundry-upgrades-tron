// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ArtifactProvenance} from "openzeppelin-foundry-upgrades-tron/internal/ArtifactProvenance.sol";

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

    function _fixture(string memory suffix) private view returns (string memory) {
        return string.concat(vm.projectRoot(), "/test/fixtures/provenance/", suffix);
    }
}

contract ProvenanceInvoker {
    function assertMatch(string memory name, string memory outDir) external returns (bytes32) {
        return ArtifactProvenance.assertMatch(name, outDir);
    }
}
