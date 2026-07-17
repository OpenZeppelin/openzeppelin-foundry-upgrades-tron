// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {Options} from "openzeppelin-foundry-upgrades-tron/Options.sol";
import {UnsafeUpgrades as ModernUnsafeUpgrades} from "openzeppelin-foundry-upgrades-tron/Upgrades.sol";
import {
    UnsafeUpgrades as UnsafeLegacyUpgrades,
    Upgrades as LegacyUpgrades
} from "openzeppelin-foundry-upgrades-tron/LegacyUpgrades.sol";
import {IBeacon} from "openzeppelin-tron-solidity/contracts/proxy/beacon/IBeacon.sol";

import {Greeter} from "./contracts/Greeter.sol";
import {GreeterV2} from "./contracts/GreeterV2.sol";
import {GreeterProxiable} from "./contracts/GreeterProxiable.sol";
import {GreeterV2Proxiable} from "./contracts/GreeterV2Proxiable.sol";
import {LegacyProxyAdmin, LegacyTransparentProxy, LegacyUUPS} from "./contracts/LegacyUUPS.sol";
import {LegacyUUPSV2} from "./contracts/LegacyUUPSV2.sol";

contract LegacyUpgradesTest is Test {
    address private constant OWNER = address(0xA11CE);

    function testValidatedLegacyUUPSDispatchesToUpgradeTo() public {
        address proxy = ModernUnsafeUpgrades.deployUUPSProxy(
            address(new LegacyUUPS()),
            abi.encodeCall(LegacyUUPS.initialize, (OWNER, 10))
        );
        Options memory opts;
        opts.unsafeSkipAllChecks = true;

        LegacyUpgrades.upgradeProxy(proxy, "LegacyUUPSV2.sol:LegacyUUPSV2", bytes(""), opts, OWNER);

        assertEq(LegacyUpgrades.getImplementationAddress(proxy).code.length > 0, true);
        assertEq(LegacyUUPS(proxy).owner(), OWNER);
        assertEq(LegacyUUPS(proxy).value(), 10);
        LegacyUUPSV2(proxy).increment();
        assertEq(LegacyUUPS(proxy).value(), 11);
        assertEq(LegacyUUPSV2(proxy).revision(), 2);
    }

    function testUnsafeLegacyUUPSDispatchesToUpgradeTo() public {
        address proxy = ModernUnsafeUpgrades.deployUUPSProxy(
            address(new LegacyUUPS()),
            abi.encodeCall(LegacyUUPS.initialize, (OWNER, 20))
        );
        address implementationV2 = address(new LegacyUUPSV2());

        UnsafeLegacyUpgrades.upgradeProxy(proxy, implementationV2, bytes(""), OWNER);

        assertEq(UnsafeLegacyUpgrades.getImplementationAddress(proxy), implementationV2);
        assertEq(LegacyUUPS(proxy).value(), 20);
    }

    function testUnsafeLegacyProxyAdminDispatchesToUpgrade() public {
        LegacyProxyAdmin admin = new LegacyProxyAdmin(OWNER);
        LegacyTransparentProxy proxy = new LegacyTransparentProxy(
            address(new LegacyUUPS()),
            address(admin),
            abi.encodeCall(LegacyUUPS.initialize, (OWNER, 30))
        );
        address implementationV2 = address(new LegacyUUPSV2());

        UnsafeLegacyUpgrades.upgradeProxy(address(proxy), implementationV2, bytes(""), OWNER);

        assertEq(admin.upgradeCalls(), 1);
        assertEq(admin.upgradeAndCallCalls(), 0);
        assertEq(UnsafeLegacyUpgrades.getAdminAddress(address(proxy)), address(admin));
        assertEq(UnsafeLegacyUpgrades.getImplementationAddress(address(proxy)), implementationV2);
        assertEq(LegacyUUPS(address(proxy)).value(), 30);
    }

    function testUnsafeLegacyProxyAdminDispatchesToUpgradeAndCallWhenDataIsPresent() public {
        LegacyProxyAdmin admin = new LegacyProxyAdmin(OWNER);
        LegacyTransparentProxy proxy = new LegacyTransparentProxy(
            address(new LegacyUUPS()),
            address(admin),
            abi.encodeCall(LegacyUUPS.initialize, (OWNER, 40))
        );
        address implementationV2 = address(new LegacyUUPSV2());

        UnsafeLegacyUpgrades.upgradeProxy(
            address(proxy),
            implementationV2,
            abi.encodeCall(LegacyUUPSV2.increment, ()),
            OWNER
        );

        assertEq(admin.upgradeCalls(), 0);
        assertEq(admin.upgradeAndCallCalls(), 1);
        assertEq(LegacyUUPS(address(proxy)).value(), 41);
        assertEq(LegacyUUPSV2(address(proxy)).revision(), 2);
    }

    function testLegacyEntryPointKeepsV5UUPSDispatchStrict() public {
        address proxy = ModernUnsafeUpgrades.deployUUPSProxy(
            address(new GreeterProxiable()),
            abi.encodeCall(Greeter.initialize, (address(this), "preserved"))
        );
        address implementationV2 = address(new GreeterV2Proxiable());

        UnsafeLegacyUpgrades.upgradeProxy(proxy, implementationV2, bytes(""));

        assertEq(UnsafeLegacyUpgrades.getImplementationAddress(proxy), implementationV2);
        assertEq(Greeter(proxy).greeting(), "preserved");
    }

    function testLegacyBeaconUpgradeAndGetters() public {
        address implementationV1 = address(new Greeter());
        address beacon = ModernUnsafeUpgrades.deployBeacon(implementationV1, OWNER);
        address proxy = ModernUnsafeUpgrades.deployBeaconProxy(
            beacon,
            abi.encodeCall(Greeter.initialize, (OWNER, "preserved"))
        );
        address implementationV2 = address(new GreeterV2());

        UnsafeLegacyUpgrades.upgradeBeacon(beacon, implementationV2, OWNER);

        assertEq(IBeacon(beacon).implementation(), implementationV2);
        assertEq(UnsafeLegacyUpgrades.getBeaconAddress(proxy), beacon);
        assertEq(Greeter(proxy).greeting(), "preserved");
    }
}
