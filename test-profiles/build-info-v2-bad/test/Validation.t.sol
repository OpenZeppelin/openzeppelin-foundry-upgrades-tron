// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {Options} from "openzeppelin-foundry-upgrades-tron/Options.sol";
import {Core} from "openzeppelin-foundry-upgrades-tron/internal/Core.sol";
import {StringFinder} from "openzeppelin-foundry-upgrades-tron/internal/StringFinder.sol";
import {MyContract} from "./contracts/MyContract.sol";

contract HistoricalValidationBadTest is Test {
    using StringFinder for string;

    function testRejectsIncompatibleHistoricalBuildInfo() public {
        MyContract implementation = new MyContract();
        assertTrue(address(implementation) != address(0));

        Options memory opts;
        opts.referenceBuildInfoDir = vm.envString("REFERENCE_BUILD_INFO_DIR");

        HistoricalValidationInvoker validator = new HistoricalValidationInvoker();
        try validator.validateUpgrade("MyContract.sol", opts) {
            fail();
        } catch Error(string memory reason) {
            assertTrue(reason.contains("Upgrade safety validation failed:"), reason);
            assertTrue(reason.contains("Deleted `x`"), reason);
        }
    }
}

contract HistoricalValidationInvoker {
    function validateUpgrade(string memory contractName, Options memory opts) external {
        Core.validateUpgrade(contractName, opts);
    }
}
