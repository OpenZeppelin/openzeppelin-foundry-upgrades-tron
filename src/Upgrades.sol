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
    /**
     * @dev Validates and deploys `contractName`, then deploys a UUPS TRC1967
     * proxy initialized with `initializerData`. TVM requires non-empty
     * initialization data for this proxy type.
     * @param contractName Foundry contract name, fully-qualified name, or artifact path.
     * @param initializerData ABI-encoded initializer call.
     * @param opts Validation, constructor, and linking options.
     * @return Address predicted by Forge for the proxy deployment.
     */
    function deployUUPSProxy(
        string memory contractName,
        bytes memory initializerData,
        Options memory opts
    ) internal returns (address) {
        _requireTRC1967Initialization(initializerData);
        address implementation = deployImplementation(contractName, opts);
        return UnsafeUpgrades.deployUUPSProxy(implementation, initializerData);
    }

    /**
     * @dev Deploys a validated UUPS proxy with default options.
     * @param contractName Foundry contract name, fully-qualified name, or artifact path.
     * @param initializerData ABI-encoded non-empty initializer call.
     * @return Address predicted by Forge for the proxy deployment.
     */
    function deployUUPSProxy(string memory contractName, bytes memory initializerData) internal returns (address) {
        Options memory opts;
        return deployUUPSProxy(contractName, initializerData, opts);
    }

    /**
     * @dev Validates and deploys `contractName`, then deploys a transparent
     * proxy whose ProxyAdmin is owned by `initialOwner`.
     * @param contractName Foundry contract name, fully-qualified name, or artifact path.
     * @param initialOwner Owner of the internally-created ProxyAdmin.
     * @param initializerData ABI-encoded non-empty initializer call.
     * @param opts Validation, constructor, linking, and owner-check options.
     * @return Address predicted by Forge for the proxy deployment.
     */
    function deployTransparentProxy(
        string memory contractName,
        address initialOwner,
        bytes memory initializerData,
        Options memory opts
    ) internal returns (address) {
        _requireTRC1967Initialization(initializerData);
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

    /**
     * @dev Deploys a validated transparent proxy with default options.
     * @param contractName Foundry contract name, fully-qualified name, or artifact path.
     * @param initialOwner Owner of the internally-created ProxyAdmin.
     * @param initializerData ABI-encoded non-empty initializer call.
     * @return Address predicted by Forge for the proxy deployment.
     */
    function deployTransparentProxy(
        string memory contractName,
        address initialOwner,
        bytes memory initializerData
    ) internal returns (address) {
        Options memory opts;
        return deployTransparentProxy(contractName, initialOwner, initializerData, opts);
    }

    /**
     * @dev Validates `contractName` against its reference, deploys it, and
     * upgrades a UUPS or transparent proxy, optionally executing `data`.
     * @param proxy Proxy address used by the current Forge/adapter session.
     * @param contractName New implementation contract.
     * @param data Optional call executed during the upgrade.
     * @param opts Validation, constructor, and linking options.
     */
    function upgradeProxy(address proxy, string memory contractName, bytes memory data, Options memory opts) internal {
        Core.upgradeProxy(proxy, contractName, data, opts);
    }

    /**
     * @dev Upgrades a validated UUPS or transparent proxy with default options.
     * @param proxy Proxy address used by the current Forge/adapter session.
     * @param contractName New implementation contract.
     * @param data Optional call executed during the upgrade.
     */
    function upgradeProxy(address proxy, string memory contractName, bytes memory data) internal {
        Options memory opts;
        Core.upgradeProxy(proxy, contractName, data, opts);
    }

    /**
     * @notice The `tryCaller` overload is intended for tests. Broadcast scripts
     * should configure the correct sender in Forge.
     * @dev Validates and upgrades a proxy while simulating the upgrade call from
     * `tryCaller`.
     * @param proxy Proxy address.
     * @param contractName New implementation contract.
     * @param data Optional call executed during the upgrade.
     * @param opts Validation, constructor, and linking options.
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
     * @dev Upgrades a validated proxy with default options while using
     * `tryCaller` for the upgrade call.
     * @param proxy Proxy address.
     * @param contractName New implementation contract.
     * @param data Optional call executed during the upgrade.
     * @param tryCaller Address that owns the UUPS proxy or its ProxyAdmin.
     */
    function upgradeProxy(address proxy, string memory contractName, bytes memory data, address tryCaller) internal {
        Options memory opts;
        Core.upgradeProxy(proxy, contractName, data, opts, tryCaller);
    }

    /**
     * @dev Validates and deploys `contractName`, then deploys an upgradeable
     * beacon owned by `initialOwner`.
     * @param contractName Implementation contract.
     * @param initialOwner Owner allowed to upgrade the beacon.
     * @param opts Validation, constructor, and linking options.
     * @return Address predicted by Forge for the beacon deployment.
     */
    function deployBeacon(
        string memory contractName,
        address initialOwner,
        Options memory opts
    ) internal returns (address) {
        address implementation = deployImplementation(contractName, opts);
        return UnsafeUpgrades.deployBeacon(implementation, initialOwner);
    }

    /**
     * @dev Deploys a validated upgradeable beacon with default options.
     * @param contractName Implementation contract.
     * @param initialOwner Owner allowed to upgrade the beacon.
     * @return Address predicted by Forge for the beacon deployment.
     */
    function deployBeacon(string memory contractName, address initialOwner) internal returns (address) {
        Options memory opts;
        return deployBeacon(contractName, initialOwner, opts);
    }

    /**
     * @dev Validates `contractName` against its reference, deploys it, and
     * upgrades `beacon`.
     * @param beacon Upgradeable beacon address.
     * @param contractName New implementation contract.
     * @param opts Validation, constructor, and linking options.
     */
    function upgradeBeacon(address beacon, string memory contractName, Options memory opts) internal {
        Core.upgradeBeacon(beacon, contractName, opts);
    }

    /**
     * @dev Upgrades a validated beacon with default options.
     * @param beacon Upgradeable beacon address.
     * @param contractName New implementation contract.
     */
    function upgradeBeacon(address beacon, string memory contractName) internal {
        Options memory opts;
        Core.upgradeBeacon(beacon, contractName, opts);
    }

    /**
     * @notice The `tryCaller` overload is intended for tests.
     * @dev Validates and upgrades a beacon while using `tryCaller` for the
     * owner-gated upgrade call.
     * @param beacon Upgradeable beacon address.
     * @param contractName New implementation contract.
     * @param opts Validation, constructor, and linking options.
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
     * @param beacon Upgradeable beacon address.
     * @param contractName New implementation contract.
     * @param tryCaller Beacon owner used for the upgrade call.
     */
    function upgradeBeacon(address beacon, string memory contractName, address tryCaller) internal {
        Options memory opts;
        Core.upgradeBeacon(beacon, contractName, opts, tryCaller);
    }

    /**
     * @dev Deploys a beacon proxy initialized with `initializerData`. Unlike
     * TRC1967 proxies, beacon proxies may use empty initialization data.
     * @param beacon Upgradeable beacon address.
     * @param initializerData Optional ABI-encoded initializer call.
     * @return Address predicted by Forge for the beacon proxy deployment.
     */
    function deployBeaconProxy(address beacon, bytes memory initializerData) internal returns (address) {
        Options memory opts;
        return deployBeaconProxy(beacon, initializerData, opts);
    }

    /**
     * @dev Deploys a beacon proxy while retaining the upstream options overload.
     * Non-Defender options do not alter the proxy deployment itself.
     * @param beacon Upgradeable beacon address.
     * @param initializerData Optional ABI-encoded initializer call.
     * @param opts Common options retained for API parity.
     * @return Address predicted by Forge for the beacon proxy deployment.
     */
    function deployBeaconProxy(
        address beacon,
        bytes memory initializerData,
        Options memory opts
    ) internal returns (address) {
        opts;
        return UnsafeUpgrades.deployBeaconProxy(beacon, initializerData);
    }

    /**
     * @dev Validates an implementation without deploying it.
     * @param contractName Implementation contract to validate.
     * @param opts Validation and artifact-linking options.
     */
    function validateImplementation(string memory contractName, Options memory opts) internal {
        Core.validateImplementation(contractName, opts);
    }

    /**
     * @dev Validates and deploys a standalone implementation.
     * @param contractName Implementation contract to deploy.
     * @param opts Validation, constructor, and linking options.
     * @return Address predicted by Forge for the implementation deployment.
     */
    function deployImplementation(string memory contractName, Options memory opts) internal returns (address) {
        return Core.deployImplementation(contractName, opts);
    }

    /**
     * @dev Validates an implementation against the reference selected by
     * `opts` or its custom `oz-upgrades-from` annotation.
     * @param contractName New implementation contract.
     * @param opts Reference and validation options.
     */
    function validateUpgrade(string memory contractName, Options memory opts) internal {
        Core.validateUpgrade(contractName, opts);
    }

    /**
     * @dev Validates an implementation against its reference and deploys it for
     * a later administrator-controlled upgrade.
     * @param contractName New implementation contract.
     * @param opts Validation, constructor, and linking options.
     * @return Address predicted by Forge for the implementation deployment.
     */
    function prepareUpgrade(string memory contractName, Options memory opts) internal returns (address) {
        return Core.prepareUpgrade(contractName, opts);
    }

    /**
     * @dev Reads the TRC1967 admin slot of a transparent proxy.
     * @param proxy Transparent proxy address.
     * @return ProxyAdmin address stored by the proxy.
     */
    function getAdminAddress(address proxy) internal view returns (address) {
        return Core.getAdminAddress(proxy);
    }

    /**
     * @dev Reads the TRC1967 implementation slot of a UUPS or transparent proxy.
     * @param proxy Proxy address.
     * @return Current implementation address.
     */
    function getImplementationAddress(address proxy) internal view returns (address) {
        return Core.getImplementationAddress(proxy);
    }

    /**
     * @dev Reads the TRC1967 beacon slot of a beacon proxy.
     * @param proxy Beacon proxy address.
     * @return Upgradeable beacon address.
     */
    function getBeaconAddress(address proxy) internal view returns (address) {
        return Core.getBeaconAddress(proxy);
    }

    function _requireTRC1967Initialization(bytes memory initializerData) private pure {
        if (initializerData.length == 0) revert UnsafeUpgrades.TRC1967InitializationRequired();
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

    /**
     * @dev Deploys a UUPS TRC1967 proxy without validating `implementation`.
     * @param implementation Previously deployed implementation address.
     * @param initializerData ABI-encoded non-empty initializer call.
     * @return Address predicted by Forge for the proxy deployment.
     */
    function deployUUPSProxy(address implementation, bytes memory initializerData) internal returns (address) {
        _requireTRC1967Initialization(initializerData);
        return address(new TRC1967Proxy(implementation, initializerData));
    }

    /**
     * @dev Deploys a transparent proxy without validating `implementation`.
     * @param implementation Previously deployed implementation address.
     * @param initialOwner Owner of the internally-created ProxyAdmin.
     * @param initializerData ABI-encoded non-empty initializer call.
     * @return Address predicted by Forge for the proxy deployment.
     */
    function deployTransparentProxy(
        address implementation,
        address initialOwner,
        bytes memory initializerData
    ) internal returns (address) {
        _requireTRC1967Initialization(initializerData);
        return address(new TransparentUpgradeableProxy(implementation, initialOwner, initializerData));
    }

    /**
     * @dev Upgrades a UUPS or transparent proxy without safety validation.
     * @param proxy Proxy address.
     * @param newImplementation Previously deployed implementation address.
     * @param data Optional call executed during the upgrade.
     */
    function upgradeProxy(address proxy, address newImplementation, bytes memory data) internal {
        Core.upgradeProxyTo(proxy, newImplementation, data);
    }

    /**
     * @notice The `tryCaller` overload is intended for tests.
     * @dev Upgrades a proxy without safety validation while using `tryCaller`.
     * @param proxy Proxy address.
     * @param newImplementation Previously deployed implementation address.
     * @param data Optional call executed during the upgrade.
     * @param tryCaller Address that owns the UUPS proxy or its ProxyAdmin.
     */
    function upgradeProxy(address proxy, address newImplementation, bytes memory data, address tryCaller) internal {
        Core.upgradeProxyTo(proxy, newImplementation, data, tryCaller);
    }

    /**
     * @dev Deploys an upgradeable beacon without validating `implementation`.
     * @param implementation Previously deployed implementation address.
     * @param initialOwner Owner allowed to upgrade the beacon.
     * @return Address predicted by Forge for the beacon deployment.
     */
    function deployBeacon(address implementation, address initialOwner) internal returns (address) {
        return address(new UpgradeableBeacon(implementation, initialOwner));
    }

    /**
     * @dev Upgrades a beacon without safety validation.
     * @param beacon Upgradeable beacon address.
     * @param newImplementation Previously deployed implementation address.
     */
    function upgradeBeacon(address beacon, address newImplementation) internal {
        Core.upgradeBeaconTo(beacon, newImplementation);
    }

    /**
     * @notice The `tryCaller` overload is intended for tests.
     * @dev Upgrades a beacon without safety validation while using `tryCaller`.
     * @param beacon Upgradeable beacon address.
     * @param newImplementation Previously deployed implementation address.
     * @param tryCaller Beacon owner used for the upgrade call.
     */
    function upgradeBeacon(address beacon, address newImplementation, address tryCaller) internal {
        Core.upgradeBeaconTo(beacon, newImplementation, tryCaller);
    }

    /**
     * @dev Deploys a beacon proxy without implementation validation.
     * @param beacon Upgradeable beacon address.
     * @param initializerData Optional ABI-encoded initializer call.
     * @return Address predicted by Forge for the beacon proxy deployment.
     */
    function deployBeaconProxy(address beacon, bytes memory initializerData) internal returns (address) {
        return address(new BeaconProxy(beacon, initializerData));
    }

    /**
     * @dev Reads the TRC1967 admin slot of a transparent proxy.
     * @param proxy Transparent proxy address.
     * @return ProxyAdmin address stored by the proxy.
     */
    function getAdminAddress(address proxy) internal view returns (address) {
        return Core.getAdminAddress(proxy);
    }

    /**
     * @dev Reads the TRC1967 implementation slot of a UUPS or transparent proxy.
     * @param proxy Proxy address.
     * @return Current implementation address.
     */
    function getImplementationAddress(address proxy) internal view returns (address) {
        return Core.getImplementationAddress(proxy);
    }

    /**
     * @dev Reads the TRC1967 beacon slot of a beacon proxy.
     * @param proxy Beacon proxy address.
     * @return Upgradeable beacon address.
     */
    function getBeaconAddress(address proxy) internal view returns (address) {
        return Core.getBeaconAddress(proxy);
    }

    function _requireTRC1967Initialization(bytes memory initializerData) private pure {
        if (initializerData.length == 0) revert TRC1967InitializationRequired();
    }
}
