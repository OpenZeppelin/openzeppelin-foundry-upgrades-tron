// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {UnsafeUpgrades} from "openzeppelin-foundry-upgrades-tron/Upgrades.sol";
import {IBeacon} from "openzeppelin-tron-solidity/contracts/proxy/beacon/IBeacon.sol";

import {Greeter} from "./contracts/Greeter.sol";
import {GreeterV2} from "./contracts/GreeterV2.sol";
import {GreeterProxiable} from "./contracts/GreeterProxiable.sol";
import {GreeterV2Proxiable} from "./contracts/GreeterV2Proxiable.sol";
import {
    LegacyMalformedUpgradeProxy,
    LegacyMalformedProxyAdmin,
    LegacyAdminManagedProxy
} from "./contracts/MalformedUpgradeVersion.sol";

contract UnsafeUpgradesTest is Test {
    address private constant OWNER = address(0xA11CE);

    function testUUPSDeployUpgradeAndSlots() public {
        address implementationV1 = address(new GreeterProxiable());
        address proxy = UnsafeUpgrades.deployUUPSProxy(
            implementationV1,
            abi.encodeCall(Greeter.initialize, (OWNER, "hello"))
        );
        Greeter instance = Greeter(proxy);

        assertEq(UnsafeUpgrades.getImplementationAddress(proxy), implementationV1);
        assertEq(UnsafeUpgrades.getAdminAddress(proxy), address(0));
        assertEq(instance.owner(), OWNER);
        assertEq(instance.greeting(), "hello");

        address implementationV2 = address(new GreeterV2Proxiable());
        UnsafeUpgrades.upgradeProxy(proxy, implementationV2, abi.encodeCall(GreeterV2.resetGreeting, ()), OWNER);

        assertEq(UnsafeUpgrades.getImplementationAddress(proxy), implementationV2);
        assertEq(instance.owner(), OWNER);
        assertEq(instance.greeting(), "resetted");
    }

    function testUUPSV5UpgradeAcceptsEmptyCallData() public {
        address proxy = UnsafeUpgrades.deployUUPSProxy(
            address(new GreeterProxiable()),
            abi.encodeCall(Greeter.initialize, (address(this), "preserved"))
        );
        address implementationV2 = address(new GreeterV2Proxiable());

        UnsafeUpgrades.upgradeProxy(proxy, implementationV2, bytes(""));

        assertEq(UnsafeUpgrades.getImplementationAddress(proxy), implementationV2);
        assertEq(Greeter(proxy).greeting(), "preserved");
    }

    function testUUPSDeploymentRejectsEmptyInitialization() public {
        address implementation = address(new GreeterProxiable());
        vm.expectRevert(UnsafeUpgrades.TRC1967InitializationRequired.selector);
        this.deployUUPSWithoutInitialization(implementation);
    }

    function testTransparentDeployUpgradeAndSlots() public {
        address implementationV1 = address(new Greeter());
        address proxy = UnsafeUpgrades.deployTransparentProxy(
            implementationV1,
            OWNER,
            abi.encodeCall(Greeter.initialize, (OWNER, "hello"))
        );
        Greeter instance = Greeter(proxy);
        address admin = UnsafeUpgrades.getAdminAddress(proxy);

        assertNotEq(admin, address(0));
        assertEq(UnsafeUpgrades.getImplementationAddress(proxy), implementationV1);
        assertEq(instance.owner(), OWNER);
        assertEq(instance.greeting(), "hello");

        address implementationV2 = address(new GreeterV2());
        UnsafeUpgrades.upgradeProxy(proxy, implementationV2, abi.encodeCall(GreeterV2.resetGreeting, ()), OWNER);

        assertEq(UnsafeUpgrades.getAdminAddress(proxy), admin);
        assertEq(UnsafeUpgrades.getImplementationAddress(proxy), implementationV2);
        assertEq(instance.owner(), OWNER);
        assertEq(instance.greeting(), "resetted");
    }

    function testTransparentV5UpgradeAcceptsEmptyCallData() public {
        address proxy = UnsafeUpgrades.deployTransparentProxy(
            address(new Greeter()),
            address(this),
            abi.encodeCall(Greeter.initialize, (address(this), "preserved"))
        );
        address implementationV2 = address(new GreeterV2());

        UnsafeUpgrades.upgradeProxy(proxy, implementationV2, bytes(""));

        assertEq(UnsafeUpgrades.getImplementationAddress(proxy), implementationV2);
        assertEq(Greeter(proxy).greeting(), "preserved");
    }

    function testTransparentDeploymentRejectsEmptyInitialization() public {
        address implementation = address(new Greeter());
        vm.expectRevert(UnsafeUpgrades.TRC1967InitializationRequired.selector);
        this.deployTransparentWithoutInitialization(implementation);
    }

    function testBeaconDeployUpgradeAndFleetState() public {
        address implementationV1 = address(new Greeter());
        address beacon = UnsafeUpgrades.deployBeacon(implementationV1, OWNER);
        address proxyOne = UnsafeUpgrades.deployBeaconProxy(beacon, abi.encodeCall(Greeter.initialize, (OWNER, "one")));
        address proxyTwo = UnsafeUpgrades.deployBeaconProxy(beacon, abi.encodeCall(Greeter.initialize, (OWNER, "two")));

        assertEq(IBeacon(beacon).implementation(), implementationV1);
        assertEq(UnsafeUpgrades.getBeaconAddress(proxyOne), beacon);
        assertEq(UnsafeUpgrades.getBeaconAddress(proxyTwo), beacon);
        assertEq(Greeter(proxyOne).greeting(), "one");
        assertEq(Greeter(proxyTwo).greeting(), "two");

        address implementationV2 = address(new GreeterV2());
        UnsafeUpgrades.upgradeBeacon(beacon, implementationV2, OWNER);

        assertEq(IBeacon(beacon).implementation(), implementationV2);
        assertEq(Greeter(proxyOne).greeting(), "one");
        assertEq(Greeter(proxyTwo).greeting(), "two");

        GreeterV2(proxyOne).resetGreeting();
        vm.prank(OWNER);
        GreeterV2(proxyTwo).setGreeting("two-v2");
        assertEq(Greeter(proxyOne).greeting(), "resetted");
        assertEq(Greeter(proxyTwo).greeting(), "two-v2");
    }

    function testBeaconUpgradeWithoutCallerOverload() public {
        address beacon = UnsafeUpgrades.deployBeacon(address(new Greeter()), address(this));
        address implementationV2 = address(new GreeterV2());

        UnsafeUpgrades.upgradeBeacon(beacon, implementationV2);

        assertEq(IBeacon(beacon).implementation(), implementationV2);
    }

    function testBeaconProxyAcceptsEmptyInitialization() public {
        address beacon = UnsafeUpgrades.deployBeacon(address(new Greeter()), OWNER);

        address proxy = UnsafeUpgrades.deployBeaconProxy(beacon, bytes(""));

        assertEq(UnsafeUpgrades.getBeaconAddress(proxy), beacon);
        assertEq(Greeter(proxy).owner(), address(0));
        assertEq(Greeter(proxy).greeting(), "");
    }

    function testMalformedVersionProbeDoesNotBlockLegacyProxyUpgrade() public {
        LegacyMalformedUpgradeProxy proxy = new LegacyMalformedUpgradeProxy(_badOffsetVersionResponse());
        address newImplementation = address(new Greeter());

        UnsafeUpgrades.upgradeProxy(address(proxy), newImplementation, bytes(""));

        assertEq(proxy.upgradedTo(), newImplementation);
    }

    function testMalformedVersionProbeDoesNotBlockLegacyAdminUpgrade() public {
        LegacyMalformedProxyAdmin admin = new LegacyMalformedProxyAdmin(_badOffsetVersionResponse());
        LegacyAdminManagedProxy proxy = new LegacyAdminManagedProxy(address(admin));
        address newImplementation = address(new Greeter());

        UnsafeUpgrades.upgradeProxy(address(proxy), newImplementation, bytes(""));

        assertEq(admin.upgradedProxy(), address(proxy));
        assertEq(admin.upgradedTo(), newImplementation);
    }

    function deployUUPSWithoutInitialization(address implementation) external returns (address) {
        return UnsafeUpgrades.deployUUPSProxy(implementation, bytes(""));
    }

    function _badOffsetVersionResponse() private pure returns (bytes memory response) {
        response = abi.encode("5.0.0");
        assembly {
            mstore(add(response, 0x20), 0x40)
        }
    }

    function deployTransparentWithoutInitialization(address implementation) external returns (address) {
        return UnsafeUpgrades.deployTransparentProxy(implementation, OWNER, bytes(""));
    }
}
