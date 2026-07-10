// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {Utils, ContractInfo} from "openzeppelin-foundry-upgrades-tron/internal/Utils.sol";
import {StringFinder} from "openzeppelin-foundry-upgrades-tron/internal/StringFinder.sol";
import {MyContractName} from "../contracts/MyContractFile.sol";

contract UtilsTest is Test {
    using StringFinder for string;

    UtilsInvoker private invoker;

    function setUp() public {
        invoker = new UtilsInvoker();
    }

    function testGetContractInfoFromFileAndFullyQualifiedName() public {
        ContractInfo memory fromFile = Utils.getContractInfo("MyContractFile.sol", "out");
        ContractInfo memory fromFqn = Utils.getContractInfo("MyContractFile.sol:MyContractName", "out");

        assertEq(fromFile.shortName, "MyContractFile");
        assertEq(fromFqn.shortName, "MyContractName");
        assertEq(fromFqn.contractPath, "test/contracts/MyContractFile.sol");
        assertEq(
            Utils.getFullyQualifiedName("MyContractFile.sol:MyContractName", "out"),
            "test/contracts/MyContractFile.sol:MyContractName"
        );
        assertTrue(fromFqn.artifactPath.startsWith(vm.projectRoot()));
    }

    function testGetContractInfoFromArtifactPath() public {
        ContractInfo memory info = Utils.getContractInfo("out/MyContractFile.sol/MyContractName.json", "out");
        assertEq(info.shortName, "MyContractName");
        assertEq(info.contractPath, "test/contracts/MyContractFile.sol");
    }

    function testRejectsInvalidAndShellUnsafeContractNames() public {
        vm.expectRevert(
            bytes(
                "Contract name Foo must be in the format MyContract.sol:MyContract or MyContract.sol or out/MyContract.sol/MyContract.json"
            )
        );
        invoker.getContractInfo("Foo", "out");

        vm.expectRevert(abi.encodeWithSelector(Utils.UnsafeContractName.selector, "Missing.sol:Missing; touch PWNED"));
        invoker.getContractInfo("Missing.sol:Missing; touch PWNED", "out");
    }

    function testMissingAstExplainsRequiredFoundrySetting() public {
        try invoker.processFixture("test/fixtures/provenance/missing-ast.json") {
            fail();
        } catch Error(string memory reason) {
            assertTrue(reason.contains("Could not find AST in artifact "));
            assertTrue(reason.contains("Set `ast = true` in foundry.toml"));
        }
    }

    function testInvalidOutputDirectoryFails() public {
        vm.expectRevert();
        invoker.getContractInfo("Missing.sol:Missing", "does-not-exist");
    }

    function testGetOutDirDefaultsAndReadsEnvironment() public {
        assertEq(Utils.getOutDir(), "out");
        vm.setEnv("FOUNDRY_OUT", "custom out");
        assertEq(Utils.getOutDir(), "custom out");
    }

    function testBuildInfoDirectorySelection() public pure {
        assertEq(Utils.getBuildInfoDir("out"), "out/build-info");
        assertEq(Utils.getBuildInfoDir("custom-out/"), "custom-out/build-info");
        assertEq(Utils.getBuildInfoDir("artifacts/contracts"), "artifacts/build-info");
        assertEq(Utils.getBuildInfoDir("artifacts\\contracts\\nested"), "artifacts/build-info");
        assertEq(
            Utils.getBuildInfoDir("/tmp/project with spaces/artifacts/contracts"),
            "/tmp/project with spaces/artifacts/build-info"
        );
    }

    function testToBashCommandJoinsInputsExactly() public pure {
        string[] memory inputs = new string[](3);
        inputs[0] = "find";
        inputs[1] = "'path with spaces'";
        inputs[2] = "-type";
        string[] memory command = Utils.toBashCommand(inputs, "/bin/bash");
        assertEq(command[0], "/bin/bash");
        assertEq(command[1], "-c");
        assertEq(command[2], "find 'path with spaces' -type");
    }

    function testShellQuoteProtectsSpacesAndSingleQuotes() public pure {
        assertEq(Utils.shellQuote("path with spaces"), "'path with spaces'");
        assertEq(Utils.shellQuote("it's safe"), "'it'\\''s safe'");
    }

    function testUniqueRecursiveArtifactLookupAndPathWithSpaces() public {
        ContractInfo memory info = Utils.getContractInfo(
            "SpaceWidget.sol:SpaceWidget",
            "test/fixtures/provenance/path with spaces/out"
        );
        assertEq(info.contractPath, "contracts/SpaceWidget.sol");
    }

    function testRecursiveArtifactLookupRejectsAmbiguity() public {
        try invoker.getContractInfo("Duplicate.sol:Duplicate", "test/fixtures/provenance/ambiguous-artifacts/out") {
            fail();
        } catch Error(string memory reason) {
            assertTrue(reason.contains("Found multiple artifacts for contract Duplicate"));
        }
    }

    function testGetBuildInfoFileRequiresUniqueRecursiveMatch() public {
        string memory file = Utils.getBuildInfoFile(
            "0xe6d94a5da9fc80f4f65ce5851cd4be0091f7e773bce34524b632c227e7b9758e",
            "Widget",
            "test/fixtures/provenance/valid/out"
        );
        assertTrue(file.endsWith("/test/fixtures/provenance/valid/out/build-info/build.json"));

        try
            invoker.getBuildInfoFile(
                "0xe6d94a5da9fc80f4f65ce5851cd4be0091f7e773bce34524b632c227e7b9758e",
                "Widget",
                "test/fixtures/provenance/ambiguous/out"
            )
        {
            fail();
        } catch Error(string memory reason) {
            assertTrue(
                reason.contains("Found multiple build-info files with matching source code hash for contract Widget")
            );
        }
    }
}

contract UtilsInvoker {
    function getContractInfo(string memory name, string memory outDir) external returns (ContractInfo memory) {
        return Utils.getContractInfo(name, outDir);
    }

    function getBuildInfoFile(
        string memory hash,
        string memory name,
        string memory outDir
    ) external returns (string memory) {
        return Utils.getBuildInfoFile(hash, name, outDir);
    }

    function processFixture(string memory relativePath) external returns (ContractInfo memory) {
        return Utils.getContractInfo(relativePath, "test/fixtures/provenance");
    }
}
