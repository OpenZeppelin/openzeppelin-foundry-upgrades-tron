// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {TRC1967Proxy} from "openzeppelin-tron-solidity/contracts/proxy/TRC1967/TRC1967Proxy.sol";
import {TransparentUpgradeableProxy} from "openzeppelin-tron-solidity/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {UpgradeableBeacon} from "openzeppelin-tron-solidity/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "openzeppelin-tron-solidity/contracts/proxy/beacon/BeaconProxy.sol";

import {Core} from "./internal/Core.sol";

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
        _requireTRC1967Initialization(initializerData);
        return address(new TRC1967Proxy(implementation, initializerData));
    }

    function deployTransparentProxy(
        address implementation,
        address initialOwner,
        bytes memory initializerData
    ) internal returns (address) {
        _requireTRC1967Initialization(initializerData);
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

    function _requireTRC1967Initialization(bytes memory initializerData) private pure {
        if (initializerData.length == 0) revert TRC1967InitializationRequired();
    }
}
