// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

interface IUpgradeableBeacon {
    function upgradeTo(address newImplementation) external;
}
