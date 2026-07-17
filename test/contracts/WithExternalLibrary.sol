// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

library ExternalMath {
    function twice(uint256 value) external pure returns (uint256) {
        return value * 2;
    }
}

contract WithExternalLibrary {
    function twice(uint256 value) external pure returns (uint256) {
        return ExternalMath.twice(value);
    }
}
