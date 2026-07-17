// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {Options} from "openzeppelin-foundry-upgrades-tron/Options.sol";
import {Core} from "openzeppelin-foundry-upgrades-tron/internal/Core.sol";
import {StringFinder} from "openzeppelin-foundry-upgrades-tron/internal/StringFinder.sol";

// Include every validation fixture in this compilation's artifact/build-info set.
import "./contracts/Validations.sol";

contract ValidationTest is Test {
    using StringFinder for string;

    ValidationInvoker private validator;

    function setUp() public {
        // `vm.setEnv` is process-global, so isolate this suite from utility
        // tests that intentionally exercise a custom FOUNDRY_OUT value.
        vm.setEnv("FOUNDRY_OUT", "out");
        validator = new ValidationInvoker();
    }

    function testRejectsUnsafeImplementation() public {
        Options memory opts;
        _expectValidationFailure("Validations.sol:Unsafe", opts, false, "Use of delegatecall is not allowed");
    }

    function testAcceptsUnsafeOperationAllowedByOption() public {
        Options memory opts;
        opts.unsafeAllow = "delegatecall";
        validator.validateImplementation("Validations.sol:Unsafe", opts);
    }

    function testAcceptsUnsafeOperationAllowedByAnnotation() public {
        Options memory opts;
        validator.validateImplementation("Validations.sol:AnnotatedUnsafe", opts);
    }

    function testAcceptsCompatibleStorageLayoutWithExplicitReference() public {
        Options memory opts;
        opts.referenceContract = "Validations.sol:LayoutV1";
        validator.validateUpgrade("Validations.sol:LayoutV2_Ok", opts);
    }

    function testRejectsIncompatibleStorageLayoutWithExplicitReference() public {
        Options memory opts;
        opts.referenceContract = "Validations.sol:LayoutV1";
        _expectValidationFailure("Validations.sol:LayoutV2_Bad", opts, true, "Inserted `c`");
    }

    function testAcceptsCompatibleStorageLayoutFromAnnotation() public {
        Options memory opts;
        validator.validateUpgrade("Validations.sol:LayoutV2_UpgradesFrom_Ok", opts);
    }

    function testRejectsIncompatibleStorageLayoutFromAnnotation() public {
        Options memory opts;
        _expectValidationFailure("Validations.sol:LayoutV2_UpgradesFrom_Bad", opts, true, "Inserted `c`");
    }

    function testAcceptsCompatibleERC7201NamespacedStorage() public {
        Options memory opts;
        opts.referenceContract = "Validations.sol:NamespacedV1";
        validator.validateUpgrade("Validations.sol:NamespacedV2_Ok", opts);
    }

    function testRejectsIncompatibleERC7201NamespacedStorage() public {
        Options memory opts;
        opts.referenceContract = "Validations.sol:NamespacedV1";
        _expectValidationFailure("Validations.sol:NamespacedV2_Bad", opts, true, "Inserted `c`");
    }

    function testAcceptsCompatibleERC7201NamespacedStorageFromAnnotation() public {
        Options memory opts;
        validator.validateUpgrade("Validations.sol:NamespacedV2_UpgradesFrom_Ok", opts);
    }

    function testRejectsIncompatibleERC7201NamespacedStorageFromAnnotation() public {
        Options memory opts;
        _expectValidationFailure("Validations.sol:NamespacedV2_UpgradesFrom_Bad", opts, true, "Inserted `c`");
    }

    function testUpgradeRequiresReferenceByDefault() public {
        Options memory opts;
        try validator.validateUpgrade("Validations.sol:NamespacedV2_Ok", opts) {
            fail();
        } catch Error(string memory reason) {
            assertTrue(reason.contains("Failed to run upgrade safety validation:"), reason);
            assertTrue(reason.contains("does not specify what contract it upgrades from"), reason);
        }
    }

    function testUnsafeSkipStorageCheckAllowsUpgradeWithoutReference() public {
        Options memory opts;
        opts.unsafeSkipStorageCheck = true;
        validator.validateUpgrade("Validations.sol:NamespacedV2_Ok", opts);
    }

    function testUnsafeSkipStorageCheckAllowsIncompatibleLayout() public {
        Options memory opts;
        opts.unsafeSkipStorageCheck = true;
        validator.validateUpgrade("Validations.sol:NamespacedV2_UpgradesFrom_Bad", opts);
    }

    function testUnsafeAllowRenamesAllowsRenamedVariable() public {
        Options memory opts;
        opts.unsafeAllowRenames = true;
        validator.validateUpgrade("Validations.sol:LayoutV2_Renamed", opts);
    }

    function testUnsafeSkipAllChecksBypassesArtifactProvenanceAndCli() public {
        Options memory opts;
        opts.unsafeSkipAllChecks = true;
        validator.validateImplementation("Missing.sol:Missing", opts);
        validator.validateUpgrade("Missing.sol:Missing", opts);
    }

    function testOtherUnsafeOptionsDoNotBypassArtifactProvenance() public {
        Options memory opts;
        opts.unsafeSkipStorageCheck = true;

        try validator.validateImplementation("Missing.sol:Missing", opts) {
            fail();
        } catch Error(string memory reason) {
            assertTrue(reason.contains("Could not find artifact for contract Missing"), reason);
        }
    }

    function testWarningsDoNotHideValidationErrors() public {
        Options memory opts;
        opts.unsafeAllow = "state-variable-immutable";
        _expectValidationFailure(
            "Validations.sol:HasWarningAndError",
            opts,
            false,
            "Use of delegatecall is not allowed"
        );
    }

    function testToolFailureIsDistinctFromValidationFailure() public {
        Options memory opts;
        opts.referenceContract = "missing:LayoutV1";
        opts.referenceBuildInfoDir = "test/fixtures/does-not-exist";

        try validator.validateUpgrade("Validations.sol:LayoutV2_Ok", opts) {
            fail();
        } catch Error(string memory reason) {
            assertTrue(reason.contains("Failed to run upgrade safety validation:"), reason);
            assertFalse(reason.contains("Upgrade safety validation failed:"), reason);
        }
    }

    function _expectValidationFailure(
        string memory contractName,
        Options memory opts,
        bool upgrade,
        string memory expectedReason
    ) private {
        try validator.validate(contractName, opts, upgrade) {
            fail();
        } catch Error(string memory reason) {
            assertTrue(reason.contains("Upgrade safety validation failed:"), reason);
            assertTrue(reason.contains(expectedReason), reason);
        }
    }
}

contract ValidationInvoker {
    function validateImplementation(string memory contractName, Options memory opts) external {
        Core.validateImplementation(contractName, opts);
    }

    function validateUpgrade(string memory contractName, Options memory opts) external {
        Core.validateUpgrade(contractName, opts);
    }

    function validate(string memory contractName, Options memory opts, bool upgrade) external {
        if (upgrade) {
            Core.validateUpgrade(contractName, opts);
        } else {
            Core.validateImplementation(contractName, opts);
        }
    }
}
