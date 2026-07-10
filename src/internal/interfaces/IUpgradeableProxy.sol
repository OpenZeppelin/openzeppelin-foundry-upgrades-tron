// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

interface IUpgradeableProxy {
    function upgradeTo(address newImplementation) external;

    function upgradeToAndCall(address newImplementation, bytes memory data) external payable;
}
