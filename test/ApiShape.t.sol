// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {LinkedLibrary, Options} from "openzeppelin-foundry-upgrades-tron/Options.sol";
import {UnsafeUpgrades, Upgrades} from "openzeppelin-foundry-upgrades-tron/Upgrades.sol";

/// @dev Compile-only consumer that locks every supported modern overload.
contract ModernApiShape {
    // Upgrades: 23 supported functions and overloads.
    function validatedDeployUUPSWithOptions(
        string memory contractName,
        bytes memory initializerData,
        Options memory opts
    ) external returns (address) {
        return Upgrades.deployUUPSProxy(contractName, initializerData, opts);
    }

    function validatedDeployUUPS(string memory contractName, bytes memory initializerData) external returns (address) {
        return Upgrades.deployUUPSProxy(contractName, initializerData);
    }

    function validatedDeployTransparentWithOptions(
        string memory contractName,
        address initialOwner,
        bytes memory initializerData,
        Options memory opts
    ) external returns (address) {
        return Upgrades.deployTransparentProxy(contractName, initialOwner, initializerData, opts);
    }

    function validatedDeployTransparent(
        string memory contractName,
        address initialOwner,
        bytes memory initializerData
    ) external returns (address) {
        return Upgrades.deployTransparentProxy(contractName, initialOwner, initializerData);
    }

    function validatedUpgradeProxyWithOptions(
        address proxy,
        string memory contractName,
        bytes memory data,
        Options memory opts
    ) external {
        Upgrades.upgradeProxy(proxy, contractName, data, opts);
    }

    function validatedUpgradeProxy(address proxy, string memory contractName, bytes memory data) external {
        Upgrades.upgradeProxy(proxy, contractName, data);
    }

    function validatedUpgradeProxyWithOptionsAndCaller(
        address proxy,
        string memory contractName,
        bytes memory data,
        Options memory opts,
        address tryCaller
    ) external {
        Upgrades.upgradeProxy(proxy, contractName, data, opts, tryCaller);
    }

    function validatedUpgradeProxyWithCaller(
        address proxy,
        string memory contractName,
        bytes memory data,
        address tryCaller
    ) external {
        Upgrades.upgradeProxy(proxy, contractName, data, tryCaller);
    }

    function validatedDeployBeaconWithOptions(
        string memory contractName,
        address initialOwner,
        Options memory opts
    ) external returns (address) {
        return Upgrades.deployBeacon(contractName, initialOwner, opts);
    }

    function validatedDeployBeacon(string memory contractName, address initialOwner) external returns (address) {
        return Upgrades.deployBeacon(contractName, initialOwner);
    }

    function validatedUpgradeBeaconWithOptions(
        address beacon,
        string memory contractName,
        Options memory opts
    ) external {
        Upgrades.upgradeBeacon(beacon, contractName, opts);
    }

    function validatedUpgradeBeacon(address beacon, string memory contractName) external {
        Upgrades.upgradeBeacon(beacon, contractName);
    }

    function validatedUpgradeBeaconWithOptionsAndCaller(
        address beacon,
        string memory contractName,
        Options memory opts,
        address tryCaller
    ) external {
        Upgrades.upgradeBeacon(beacon, contractName, opts, tryCaller);
    }

    function validatedUpgradeBeaconWithCaller(address beacon, string memory contractName, address tryCaller) external {
        Upgrades.upgradeBeacon(beacon, contractName, tryCaller);
    }

    function validatedDeployBeaconProxy(address beacon, bytes memory initializerData) external returns (address) {
        return Upgrades.deployBeaconProxy(beacon, initializerData);
    }

    function validatedDeployBeaconProxyWithOptions(
        address beacon,
        bytes memory initializerData,
        Options memory opts
    ) external returns (address) {
        return Upgrades.deployBeaconProxy(beacon, initializerData, opts);
    }

    function validatedImplementation(string memory contractName, Options memory opts) external {
        Upgrades.validateImplementation(contractName, opts);
    }

    function validatedDeployImplementation(string memory contractName, Options memory opts) external returns (address) {
        return Upgrades.deployImplementation(contractName, opts);
    }

    function validatedUpgrade(string memory contractName, Options memory opts) external {
        Upgrades.validateUpgrade(contractName, opts);
    }

    function validatedPrepareUpgrade(string memory contractName, Options memory opts) external returns (address) {
        return Upgrades.prepareUpgrade(contractName, opts);
    }

    function validatedAdminAddress(address proxy) external view returns (address) {
        return Upgrades.getAdminAddress(proxy);
    }

    function validatedImplementationAddress(address proxy) external view returns (address) {
        return Upgrades.getImplementationAddress(proxy);
    }

    function validatedBeaconAddress(address proxy) external view returns (address) {
        return Upgrades.getBeaconAddress(proxy);
    }

    // UnsafeUpgrades: 11 supported functions and overloads.
    function unsafeDeployUUPS(address implementation, bytes memory initializerData) external returns (address) {
        return UnsafeUpgrades.deployUUPSProxy(implementation, initializerData);
    }

    function unsafeDeployTransparent(
        address implementation,
        address initialOwner,
        bytes memory initializerData
    ) external returns (address) {
        return UnsafeUpgrades.deployTransparentProxy(implementation, initialOwner, initializerData);
    }

    function unsafeUpgradeProxy(address proxy, address newImplementation, bytes memory data) external {
        UnsafeUpgrades.upgradeProxy(proxy, newImplementation, data);
    }

    function unsafeUpgradeProxyWithCaller(
        address proxy,
        address newImplementation,
        bytes memory data,
        address tryCaller
    ) external {
        UnsafeUpgrades.upgradeProxy(proxy, newImplementation, data, tryCaller);
    }

    function unsafeDeployBeacon(address implementation, address initialOwner) external returns (address) {
        return UnsafeUpgrades.deployBeacon(implementation, initialOwner);
    }

    function unsafeUpgradeBeacon(address beacon, address newImplementation) external {
        UnsafeUpgrades.upgradeBeacon(beacon, newImplementation);
    }

    function unsafeUpgradeBeaconWithCaller(address beacon, address newImplementation, address tryCaller) external {
        UnsafeUpgrades.upgradeBeacon(beacon, newImplementation, tryCaller);
    }

    function unsafeDeployBeaconProxy(address beacon, bytes memory initializerData) external returns (address) {
        return UnsafeUpgrades.deployBeaconProxy(beacon, initializerData);
    }

    function unsafeAdminAddress(address proxy) external view returns (address) {
        return UnsafeUpgrades.getAdminAddress(proxy);
    }

    function unsafeImplementationAddress(address proxy) external view returns (address) {
        return UnsafeUpgrades.getImplementationAddress(proxy);
    }

    function unsafeBeaconAddress(address proxy) external view returns (address) {
        return UnsafeUpgrades.getBeaconAddress(proxy);
    }

    /// @dev A named-field literal makes any unsupported addition or removal a compile error.
    function exactOptionsShape(address libraryAddress) external pure returns (Options memory) {
        string[] memory exclude = new string[](1);
        exclude[0] = "contracts/helpers/**/*.sol";
        LinkedLibrary[] memory linkedLibraries = new LinkedLibrary[](1);
        linkedLibraries[0] = LinkedLibrary({
            sourceName: "contracts/Math.sol",
            libraryName: "Math",
            libraryAddress: libraryAddress
        });
        return
            Options({
                referenceContract: "build-info-v1:ContractV1",
                referenceBuildInfoDir: "previous-builds/build-info-v1",
                constructorData: hex"1234",
                exclude: exclude,
                unsafeAllow: "delegatecall,selfdestruct",
                unsafeAllowRenames: true,
                unsafeSkipProxyAdminCheck: true,
                unsafeSkipStorageCheck: true,
                unsafeSkipAllChecks: true,
                linkedLibraries: linkedLibraries
            });
    }
}

contract ApiShapeTest {
    function testModernApiShapeCompiles() public pure {
        assert(true);
    }

    function testOptionsAndLinkedLibraryFieldOrder() public pure {
        string[] memory exclude = new string[](1);
        exclude[0] = "contracts/helpers/**/*.sol";
        LinkedLibrary[] memory linkedLibraries = new LinkedLibrary[](1);
        linkedLibraries[0] = LinkedLibrary({
            sourceName: "contracts/Math.sol",
            libraryName: "Math",
            libraryAddress: address(0x1234)
        });
        Options memory opts = Options({
            referenceContract: "build-info-v1:ContractV1",
            referenceBuildInfoDir: "previous-builds/build-info-v1",
            constructorData: hex"1234",
            exclude: exclude,
            unsafeAllow: "delegatecall,selfdestruct",
            unsafeAllowRenames: true,
            unsafeSkipProxyAdminCheck: false,
            unsafeSkipStorageCheck: true,
            unsafeSkipAllChecks: false,
            linkedLibraries: linkedLibraries
        });

        bytes memory expectedLinkedLibrary = bytes.concat(
            bytes32(uint256(32)),
            abi.encode("contracts/Math.sol", "Math", address(0x1234))
        );
        assert(keccak256(abi.encode(linkedLibraries[0])) == keccak256(expectedLinkedLibrary));

        bytes memory expectedOptions = bytes.concat(
            bytes32(uint256(32)),
            abi.encode(
                "build-info-v1:ContractV1",
                "previous-builds/build-info-v1",
                hex"1234",
                exclude,
                "delegatecall,selfdestruct",
                true,
                false,
                true,
                false,
                linkedLibraries
            )
        );
        assert(keccak256(abi.encode(opts)) == keccak256(expectedOptions));
    }
}
