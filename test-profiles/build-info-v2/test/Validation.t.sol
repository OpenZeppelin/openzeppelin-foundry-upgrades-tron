// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {Options} from "openzeppelin-foundry-upgrades-tron/Options.sol";
import {Core} from "openzeppelin-foundry-upgrades-tron/internal/Core.sol";
import {MyContract} from "./contracts/MyContract.sol";

contract HistoricalValidationTest is Test {
    function testCompatibleHistoricalBuildInfo() public {
        MyContract implementation = new MyContract();
        assertEq(implementation.x(), "");

        Options memory opts;
        opts.referenceBuildInfoDir = vm.envString("REFERENCE_BUILD_INFO_DIR");
        Core.validateUpgrade("MyContract.sol", opts);
    }
}
