// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {TRC1967Proxy} from "openzeppelin-tron-solidity/contracts/proxy/TRC1967/TRC1967Proxy.sol";
import {TransparentUpgradeableProxy} from "openzeppelin-tron-solidity/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {UpgradeableBeacon} from "openzeppelin-tron-solidity/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "openzeppelin-tron-solidity/contracts/proxy/beacon/BeaconProxy.sol";

import {Vm} from "forge-std/Vm.sol";
import {Options} from "./Options.sol";
import {Core} from "./internal/Core.sol";
import {Utils} from "./internal/Utils.sol";

/**
 * @dev Validated deployment and upgrade helpers for TRON Virtual Machine
 * proxies. Requires OpenZeppelin Contracts for TRON v5 or later.
 */
library Upgrades {
    function deployUUPSProxy(
        string memory contractName,
        bytes memory initializerData,
        Options memory opts
    ) internal returns (address) {
        UnsafeUpgrades.requireTRC1967Initialization(initializerData);
        address implementation = deployImplementation(contractName, opts);
        return UnsafeUpgrades.deployUUPSProxy(implementation, initializerData);
    }

    function deployUUPSProxy(string memory contractName, bytes memory initializerData) internal returns (address) {
        Options memory opts;
        return deployUUPSProxy(contractName, initializerData, opts);
    }

    function deployTransparentProxy(
        string memory contractName,
        address initialOwner,
        bytes memory initializerData,
        Options memory opts
    ) internal returns (address) {
        UnsafeUpgrades.requireTRC1967Initialization(initializerData);
        if (!opts.unsafeSkipAllChecks && !opts.unsafeSkipProxyAdminCheck && Core.inferProxyAdmin(initialOwner)) {
            revert(
                string.concat(
                    "`initialOwner` must not be a ProxyAdmin contract. If the contract at address ",
                    Vm(Utils.CHEATCODE_ADDRESS).toString(initialOwner),
                    " is not a ProxyAdmin contract and you are sure that this contract is able to call functions on an actual ProxyAdmin, skip this check with the `unsafeSkipProxyAdminCheck` option."
                )
            );
        }

        address implementation = deployImplementation(contractName, opts);
        return UnsafeUpgrades.deployTransparentProxy(implementation, initialOwner, initializerData);
    }

    function deployTransparentProxy(
        string memory contractName,
        address initialOwner,
        bytes memory initializerData
    ) internal returns (address) {
        Options memory opts;
        return deployTransparentProxy(contractName, initialOwner, initializerData, opts);
    }

    function upgradeProxy(address proxy, string memory contractName, bytes memory data, Options memory opts) internal {
        Core.upgradeProxy(proxy, contractName, data, opts);
    }

    function upgradeProxy(address proxy, string memory contractName, bytes memory data) internal {
        Options memory opts;
        Core.upgradeProxy(proxy, contractName, data, opts);
    }

    function upgradeProxy(
        address proxy,
        string memory contractName,
        bytes memory data,
        Options memory opts,
        address tryCaller
    ) internal {
        Core.upgradeProxy(proxy, contractName, data, opts, tryCaller);
    }

    function upgradeProxy(address proxy, string memory contractName, bytes memory data, address tryCaller) internal {
        Options memory opts;
        Core.upgradeProxy(proxy, contractName, data, opts, tryCaller);
    }

    function deployBeacon(
        string memory contractName,
        address initialOwner,
        Options memory opts
    ) internal returns (address) {
        address implementation = deployImplementation(contractName, opts);
        return UnsafeUpgrades.deployBeacon(implementation, initialOwner);
    }

    function deployBeacon(string memory contractName, address initialOwner) internal returns (address) {
        Options memory opts;
        return deployBeacon(contractName, initialOwner, opts);
    }

    function upgradeBeacon(address beacon, string memory contractName, Options memory opts) internal {
        Core.upgradeBeacon(beacon, contractName, opts);
    }

    function upgradeBeacon(address beacon, string memory contractName) internal {
        Options memory opts;
        Core.upgradeBeacon(beacon, contractName, opts);
    }

    function upgradeBeacon(
        address beacon,
        string memory contractName,
        Options memory opts,
        address tryCaller
    ) internal {
        Core.upgradeBeacon(beacon, contractName, opts, tryCaller);
    }

    function upgradeBeacon(address beacon, string memory contractName, address tryCaller) internal {
        Options memory opts;
        Core.upgradeBeacon(beacon, contractName, opts, tryCaller);
    }

    function deployBeaconProxy(address beacon, bytes memory initializerData) internal returns (address) {
        Options memory opts;
        return deployBeaconProxy(beacon, initializerData, opts);
    }

    function deployBeaconProxy(
        address beacon,
        bytes memory initializerData,
        Options memory
    ) internal returns (address) {
        return UnsafeUpgrades.deployBeaconProxy(beacon, initializerData);
    }

    function validateImplementation(string memory contractName, Options memory opts) internal {
        Core.validateImplementation(contractName, opts);
    }

    function deployImplementation(string memory contractName, Options memory opts) internal returns (address) {
        return Core.deployImplementation(contractName, opts);
    }

    function validateUpgrade(string memory contractName, Options memory opts) internal {
        Core.validateUpgrade(contractName, opts);
    }

    function prepareUpgrade(string memory contractName, Options memory opts) internal returns (address) {
        return Core.prepareUpgrade(contractName, opts);
    }

    function getAdminAddress(address proxy) internal view returns (address) {
        return Core.getAdminAddress(proxy);
    }

    function getImplementationAddress(address proxy) internal view returns (address) {
        return Core.getImplementationAddress(proxy);
    }

    function getBeaconAddress(address proxy) internal view returns (address) {
        return Core.getBeaconAddress(proxy);
    }
}

/**
 * @dev Deploys and manages upgradeable contracts from Forge tests without
 * running upgrade-safety or storage-compatibility validations.
 *
 * WARNING: This library is intended for tests. Use the validated `Upgrades`
 * API for deployment scripts.
 */
library UnsafeUpgrades {
    /**
     * @dev TRC1967Proxy rejects empty constructor initialization data. This
     * error exposes that requirement at the library boundary for both UUPS and
     * transparent deployments.
     */
    error TRC1967InitializationRequired();

    function deployUUPSProxy(address implementation, bytes memory initializerData) internal returns (address) {
        requireTRC1967Initialization(initializerData);
        return address(new TRC1967Proxy(implementation, initializerData));
    }

    function deployTransparentProxy(
        address implementation,
        address initialOwner,
        bytes memory initializerData
    ) internal returns (address) {
        requireTRC1967Initialization(initializerData);
        return address(new TransparentUpgradeableProxy(implementation, initialOwner, initializerData));
    }

    function upgradeProxy(address proxy, address newImplementation, bytes memory data) internal {
        Core.upgradeProxyTo(proxy, newImplementation, data);
    }

    function upgradeProxy(address proxy, address newImplementation, bytes memory data, address tryCaller) internal {
        Core.upgradeProxyTo(proxy, newImplementation, data, tryCaller);
    }

    function deployBeacon(address implementation, address initialOwner) internal returns (address) {
        return address(new UpgradeableBeacon(implementation, initialOwner));
    }

    function upgradeBeacon(address beacon, address newImplementation) internal {
        Core.upgradeBeaconTo(beacon, newImplementation);
    }

    function upgradeBeacon(address beacon, address newImplementation, address tryCaller) internal {
        Core.upgradeBeaconTo(beacon, newImplementation, tryCaller);
    }

    function deployBeaconProxy(address beacon, bytes memory initializerData) internal returns (address) {
        return address(new BeaconProxy(beacon, initializerData));
    }

    function getAdminAddress(address proxy) internal view returns (address) {
        return Core.getAdminAddress(proxy);
    }

    function getImplementationAddress(address proxy) internal view returns (address) {
        return Core.getImplementationAddress(proxy);
    }

    function getBeaconAddress(address proxy) internal view returns (address) {
        return Core.getBeaconAddress(proxy);
    }

    function requireTRC1967Initialization(bytes memory initializerData) internal pure {
        if (initializerData.length == 0) revert TRC1967InitializationRequired();
    }
}
