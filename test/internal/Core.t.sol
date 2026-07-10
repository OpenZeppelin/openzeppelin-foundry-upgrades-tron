// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {Options} from "openzeppelin-foundry-upgrades-tron/Options.sol";
import {ArtifactProvenance} from "openzeppelin-foundry-upgrades-tron/internal/ArtifactProvenance.sol";
import {Core} from "openzeppelin-foundry-upgrades-tron/internal/Core.sol";
import {Versions} from "openzeppelin-foundry-upgrades-tron/internal/Versions.sol";

import {OptionsApiShape} from "../contracts/Validations.sol";

contract CoreTest is Test {
    string private constant TARGET = "Validations.sol:OptionsApiShape";
    CoreInvoker private invoker;

    function setUp() public {
        invoker = new CoreInvoker();
    }

    function testPinsSupportedUpgradesCoreRange() public pure {
        assertEq(Versions.UPGRADES_CORE, "^1.46.0");
    }

    function testDefinesDistinctValidationResultCategories() public pure {
        assertEq(uint256(Core.ValidationResult.Success), 0);
        assertEq(uint256(Core.ValidationResult.ValidationFailure), 1);
        assertEq(uint256(Core.ValidationResult.ToolFailure), 2);
    }

    function testOptionsApiShapeUsesEverySupportedNonDefenderField() public {
        Options memory opts = new OptionsApiShape().allSupportedOptions();

        assertEq(opts.referenceContract, "build-info-v1:LayoutV1");
        assertEq(opts.referenceBuildInfoDir, "previous-builds/build-info-v1");
        assertEq(opts.constructorData, hex"1234");
        assertEq(opts.exclude.length, 1);
        assertEq(opts.exclude[0], "test/contracts/helpers/**/*.sol");
        assertEq(opts.unsafeAllow, "delegatecall,selfdestruct");
        assertTrue(opts.unsafeAllowRenames);
        assertTrue(opts.unsafeSkipProxyAdminCheck);
        assertTrue(opts.unsafeSkipStorageCheck);
        assertTrue(opts.unsafeSkipAllChecks);
    }

    function testBuildValidateCommandUsesAbsoluteFoundryOutput() public {
        Options memory opts;

        string[] memory expected = new string[](6);
        expected[0] = "npx";
        expected[1] = "@openzeppelin/upgrades-core@^1.46.0";
        expected[2] = "validate";
        expected[3] = _quote(string.concat(vm.projectRoot(), "/out/build-info"));
        expected[4] = "--contract";
        expected[5] = _quote("test/contracts/Validations.sol:OptionsApiShape");

        _assertCommandEq(_buildValidateCommand(opts, false), expected);
    }

    function testBuildValidateCommandResolvesCurrentReferenceContract() public {
        Options memory opts;
        opts.referenceContract = "Validations.sol:LayoutV1";

        string[] memory command = _buildValidateCommand(opts, false);

        assertEq(command.length, 8);
        assertEq(command[6], "--reference");
        assertEq(command[7], _quote("test/contracts/Validations.sol:LayoutV1"));
    }

    function testBuildValidateCommandPreservesHistoricalReferenceNameAndUsesAbsoluteDirectory() public {
        Options memory opts;
        opts.referenceContract = "build-info-v1:LayoutV1";
        opts.referenceBuildInfoDir = "previous builds/build-info-v1";

        string[] memory command = _buildValidateCommand(opts, false);

        assertEq(command.length, 10);
        assertEq(command[6], "--reference");
        assertEq(command[7], _quote("build-info-v1:LayoutV1"));
        assertEq(command[8], "--referenceBuildInfoDirs");
        assertEq(command[9], _quote(string.concat(vm.projectRoot(), "/previous builds/build-info-v1")));
    }

    function testBuildValidateCommandAddsEveryNonEmptyExclude() public {
        Options memory opts;
        opts.exclude = new string[](3);
        opts.exclude[0] = "test/contracts/**/{Foo,Bar}.sol";
        opts.exclude[1] = "";
        opts.exclude[2] = "test/contracts/helpers/**/*.sol";

        string[] memory command = _buildValidateCommand(opts, false);

        assertEq(command.length, 10);
        assertEq(command[6], "--exclude");
        assertEq(command[7], _quote("test/contracts/**/{Foo,Bar}.sol"));
        assertEq(command[8], "--exclude");
        assertEq(command[9], _quote("test/contracts/helpers/**/*.sol"));
    }

    function testBuildValidateCommandRequiresReferenceForUpgradeValidation() public {
        Options memory opts;

        string[] memory command = _buildValidateCommand(opts, true);

        assertEq(command.length, 7);
        assertEq(command[6], "--requireReference");
    }

    function testBuildValidateCommandSkipStorageSupersedesRequireReference() public {
        Options memory opts;
        opts.unsafeSkipStorageCheck = true;

        string[] memory command = _buildValidateCommand(opts, true);

        assertEq(command.length, 7);
        assertEq(command[6], "--unsafeSkipStorageCheck");
    }

    function testBuildValidateCommandAddsUnsafeAllowAndRenameAllowance() public {
        Options memory opts;
        opts.unsafeAllow = "delegatecall,selfdestruct";
        opts.unsafeAllowRenames = true;

        string[] memory command = _buildValidateCommand(opts, false);

        assertEq(command.length, 9);
        assertEq(command[6], "--unsafeAllow");
        assertEq(command[7], _quote("delegatecall,selfdestruct"));
        assertEq(command[8], "--unsafeAllowRenames");
    }

    function testBuildValidateCommandUsesStableOptionOrder() public {
        Options memory opts;
        opts.referenceContract = "build-info-v1:LayoutV1";
        opts.referenceBuildInfoDir = "previous-builds/build-info-v1";
        opts.exclude = new string[](1);
        opts.exclude[0] = "test/contracts/helpers/**/*.sol";
        opts.unsafeAllow = "delegatecall";
        opts.unsafeAllowRenames = true;

        string[] memory command = _buildValidateCommand(opts, true);

        assertEq(
            _join(command),
            string.concat(
                "npx @openzeppelin/upgrades-core@^1.46.0 validate ",
                _quote(string.concat(vm.projectRoot(), "/out/build-info")),
                " --contract 'test/contracts/Validations.sol:OptionsApiShape'",
                " --reference 'build-info-v1:LayoutV1'",
                " --referenceBuildInfoDirs ",
                _quote(string.concat(vm.projectRoot(), "/previous-builds/build-info-v1")),
                " --exclude 'test/contracts/helpers/**/*.sol'",
                " --requireReference --unsafeAllow 'delegatecall' --unsafeAllowRenames"
            )
        );
    }

    function testBuildValidateCommandRejectsBytecodeMismatchBeforeReturningCliArguments() public {
        Options memory opts;

        vm.expectPartialRevert(ArtifactProvenance.CreationBytecodeMismatch.selector);
        invoker.buildValidateCommandForOutDir("Widget.sol:Widget", opts, false, _fixture("bytecode-mismatch/out"));
    }

    function testBuildValidateCommandRejectsCompilerMismatchBeforeReturningCliArguments() public {
        Options memory opts;

        vm.expectPartialRevert(ArtifactProvenance.CompilerVersionMismatch.selector);
        invoker.buildValidateCommandForOutDir("Widget.sol:Widget", opts, false, _fixture("compiler-mismatch/out"));
    }

    function testBuildValidateCommandRejectsSourceMismatchBeforeReturningCliArguments() public {
        Options memory opts;

        vm.expectPartialRevert(ArtifactProvenance.SourceContentHashMismatch.selector);
        invoker.buildValidateCommandForOutDir("Widget.sol:Widget", opts, false, _fixture("source-mismatch/out"));
    }

    function _fixture(string memory suffix) private view returns (string memory) {
        return string.concat(vm.projectRoot(), "/test/fixtures/provenance/", suffix);
    }

    function _buildValidateCommand(Options memory opts, bool requireReference) private returns (string[] memory) {
        return Core.buildValidateCommand(TARGET, opts, requireReference, "out");
    }

    function _assertCommandEq(string[] memory actual, string[] memory expected) private pure {
        assertEq(actual.length, expected.length);
        for (uint256 i = 0; i < expected.length; ++i) {
            assertEq(actual[i], expected[i]);
        }
    }

    function _join(string[] memory values) private pure returns (string memory result) {
        for (uint256 i = 0; i < values.length; ++i) {
            result = string.concat(result, i == 0 ? "" : " ", values[i]);
        }
    }

    function _quote(string memory value) private pure returns (string memory) {
        return string.concat("'", value, "'");
    }
}

contract CoreInvoker {
    function buildValidateCommand(
        string memory contractName,
        Options memory opts,
        bool requireReference
    ) external returns (string[] memory) {
        return Core.buildValidateCommand(contractName, opts, requireReference);
    }

    function buildValidateCommandForOutDir(
        string memory contractName,
        Options memory opts,
        bool requireReference,
        string memory outDir
    ) external returns (string[] memory) {
        return Core.buildValidateCommand(contractName, opts, requireReference, outDir);
    }
}
