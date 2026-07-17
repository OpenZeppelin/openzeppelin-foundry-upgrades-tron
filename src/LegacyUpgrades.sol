// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Options} from "./Options.sol";
import {Core} from "./internal/Core.sol";

/**
 * @dev Validated upgrade-only helpers for existing deployments that use the
 * OpenZeppelin Contracts v4 upgrade interfaces. New deployments use
 * `Upgrades.sol` and OpenZeppelin Contracts for TRON v5.
 */
library Upgrades {
    /**
     * @dev Validates, deploys, and upgrades a legacy UUPS or transparent proxy.
     * @param proxy Existing proxy address.
     * @param contractName New implementation contract.
     * @param data Optional call executed during the upgrade.
     * @param opts Reference, validation, constructor, and linking options.
     */
    function upgradeProxy(address proxy, string memory contractName, bytes memory data, Options memory opts) internal {
        Core.upgradeProxy(proxy, contractName, data, opts);
    }

    /**
     * @dev Upgrades a validated legacy proxy with default options.
     * @param proxy Existing proxy address.
     * @param contractName New implementation contract.
     * @param data Optional call executed during the upgrade.
     */
    function upgradeProxy(address proxy, string memory contractName, bytes memory data) internal {
        Options memory opts;
        Core.upgradeProxy(proxy, contractName, data, opts);
    }

    /**
     * @notice The `tryCaller` overload is intended for tests.
     * @dev Validates and upgrades a legacy proxy while using `tryCaller` for
     * the owner-gated upgrade call.
     * @param proxy Existing proxy address.
     * @param contractName New implementation contract.
     * @param data Optional call executed during the upgrade.
     * @param opts Reference, validation, constructor, and linking options.
     * @param tryCaller Address that owns the UUPS proxy or its ProxyAdmin.
     */
    function upgradeProxy(
        address proxy,
        string memory contractName,
        bytes memory data,
        Options memory opts,
        address tryCaller
    ) internal {
        Core.upgradeProxy(proxy, contractName, data, opts, tryCaller);
    }

    /**
     * @notice The `tryCaller` overload is intended for tests.
     * @dev Upgrades a validated legacy proxy with default options.
     * @param proxy Existing proxy address.
     * @param contractName New implementation contract.
     * @param data Optional call executed during the upgrade.
     * @param tryCaller Address that owns the UUPS proxy or its ProxyAdmin.
     */
    function upgradeProxy(address proxy, string memory contractName, bytes memory data, address tryCaller) internal {
        Options memory opts;
        Core.upgradeProxy(proxy, contractName, data, opts, tryCaller);
    }

    /**
     * @dev Validates, deploys, and upgrades an existing upgradeable beacon.
     * @param beacon Existing beacon address.
     * @param contractName New implementation contract.
     * @param opts Reference, validation, constructor, and linking options.
     */
    function upgradeBeacon(address beacon, string memory contractName, Options memory opts) internal {
        Core.upgradeBeacon(beacon, contractName, opts);
    }

    /**
     * @dev Upgrades a validated beacon with default options.
     * @param beacon Existing beacon address.
     * @param contractName New implementation contract.
     */
    function upgradeBeacon(address beacon, string memory contractName) internal {
        Options memory opts;
        Core.upgradeBeacon(beacon, contractName, opts);
    }

    /**
     * @notice The `tryCaller` overload is intended for tests.
     * @dev Validates and upgrades a beacon while using `tryCaller`.
     * @param beacon Existing beacon address.
     * @param contractName New implementation contract.
     * @param opts Reference, validation, constructor, and linking options.
     * @param tryCaller Beacon owner used for the upgrade call.
     */
    function upgradeBeacon(
        address beacon,
        string memory contractName,
        Options memory opts,
        address tryCaller
    ) internal {
        Core.upgradeBeacon(beacon, contractName, opts, tryCaller);
    }

    /**
     * @notice The `tryCaller` overload is intended for tests.
     * @dev Upgrades a validated beacon with default options and `tryCaller`.
     * @param beacon Existing beacon address.
     * @param contractName New implementation contract.
     * @param tryCaller Beacon owner used for the upgrade call.
     */
    function upgradeBeacon(address beacon, string memory contractName, address tryCaller) internal {
        Options memory opts;
        Core.upgradeBeacon(beacon, contractName, opts, tryCaller);
    }

    /**
     * @dev Validates an implementation against its explicit or annotated
     * reference without deploying it.
     * @param contractName New implementation contract.
     * @param opts Reference and validation options.
     */
    function validateUpgrade(string memory contractName, Options memory opts) internal {
        Core.validateUpgrade(contractName, opts);
    }

    /**
     * @dev Validates an implementation against its reference and deploys it for
     * a later administrator-controlled legacy upgrade.
     * @param contractName New implementation contract.
     * @param opts Reference, validation, constructor, and linking options.
     * @return Address predicted by Forge for the implementation deployment.
     */
    function prepareUpgrade(string memory contractName, Options memory opts) internal returns (address) {
        return Core.prepareUpgrade(contractName, opts);
    }

    /**
     * @dev Reads the TRC1967 admin slot of a transparent proxy.
     * @param proxy Existing transparent proxy address.
     * @return ProxyAdmin address stored by the proxy.
     */
    function getAdminAddress(address proxy) internal view returns (address) {
        return Core.getAdminAddress(proxy);
    }

    /**
     * @dev Reads the TRC1967 implementation slot of a proxy.
     * @param proxy Existing UUPS or transparent proxy address.
     * @return Current implementation address.
     */
    function getImplementationAddress(address proxy) internal view returns (address) {
        return Core.getImplementationAddress(proxy);
    }

    /**
     * @dev Reads the TRC1967 beacon slot of a beacon proxy.
     * @param proxy Existing beacon proxy address.
     * @return Upgradeable beacon address.
     */
    function getBeaconAddress(address proxy) internal view returns (address) {
        return Core.getBeaconAddress(proxy);
    }
}

/**
 * @dev Upgrade-only helpers for controlled tests of existing v4 deployments.
 * This library performs no implementation or storage-layout validation.
 */
library UnsafeUpgrades {
    /**
     * @dev Upgrades a legacy UUPS or transparent proxy without validation.
     * @param proxy Existing proxy address.
     * @param newImplementation Previously deployed implementation address.
     * @param data Optional call executed during the upgrade.
     */
    function upgradeProxy(address proxy, address newImplementation, bytes memory data) internal {
        Core.upgradeProxyTo(proxy, newImplementation, data);
    }

    /**
     * @notice The `tryCaller` overload is intended for tests.
     * @dev Upgrades a legacy proxy without validation while using `tryCaller`.
     * @param proxy Existing proxy address.
     * @param newImplementation Previously deployed implementation address.
     * @param data Optional call executed during the upgrade.
     * @param tryCaller Address that owns the UUPS proxy or its ProxyAdmin.
     */
    function upgradeProxy(address proxy, address newImplementation, bytes memory data, address tryCaller) internal {
        Core.upgradeProxyTo(proxy, newImplementation, data, tryCaller);
    }

    /**
     * @dev Upgrades an existing beacon without validation.
     * @param beacon Existing beacon address.
     * @param newImplementation Previously deployed implementation address.
     */
    function upgradeBeacon(address beacon, address newImplementation) internal {
        Core.upgradeBeaconTo(beacon, newImplementation);
    }

    /**
     * @notice The `tryCaller` overload is intended for tests.
     * @dev Upgrades a beacon without validation while using `tryCaller`.
     * @param beacon Existing beacon address.
     * @param newImplementation Previously deployed implementation address.
     * @param tryCaller Beacon owner used for the upgrade call.
     */
    function upgradeBeacon(address beacon, address newImplementation, address tryCaller) internal {
        Core.upgradeBeaconTo(beacon, newImplementation, tryCaller);
    }

    /**
     * @dev Reads the TRC1967 admin slot of a transparent proxy.
     * @param proxy Existing transparent proxy address.
     * @return ProxyAdmin address stored by the proxy.
     */
    function getAdminAddress(address proxy) internal view returns (address) {
        return Core.getAdminAddress(proxy);
    }

    /**
     * @dev Reads the TRC1967 implementation slot of a proxy.
     * @param proxy Existing UUPS or transparent proxy address.
     * @return Current implementation address.
     */
    function getImplementationAddress(address proxy) internal view returns (address) {
        return Core.getImplementationAddress(proxy);
    }

    /**
     * @dev Reads the TRC1967 beacon slot of a beacon proxy.
     * @param proxy Existing beacon proxy address.
     * @return Upgradeable beacon address.
     */
    function getBeaconAddress(address proxy) internal view returns (address) {
        return Core.getBeaconAddress(proxy);
    }
}
