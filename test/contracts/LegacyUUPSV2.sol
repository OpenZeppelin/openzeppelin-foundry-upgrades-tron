// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {LegacyUUPS} from "./LegacyUUPS.sol";

contract LegacyUUPSV2 is LegacyUUPS {
    uint256 public revision;

    function increment() external {
        ++value;
        revision = 2;
    }
}
