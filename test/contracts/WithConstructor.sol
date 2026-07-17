// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// These contracts are for testing only. They are not safe for production use.

contract WithConstructor {
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    uint256 public immutable a;

    uint256 public b;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(uint256 initialA) {
        a = initialA;
    }

    function initialize(uint256 initialB) public {
        b = initialB;
    }
}

contract NoInitializer {
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    uint256 public immutable a;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(uint256 initialA) {
        a = initialA;
    }
}
