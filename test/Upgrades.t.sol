// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {LinkedLibrary, Options} from "openzeppelin-foundry-upgrades-tron/Options.sol";
import {Upgrades, UnsafeUpgrades} from "openzeppelin-foundry-upgrades-tron/Upgrades.sol";
import {IBeacon} from "openzeppelin-tron-solidity/contracts/proxy/beacon/IBeacon.sol";
import {ProxyAdmin} from "openzeppelin-tron-solidity/contracts/proxy/transparent/ProxyAdmin.sol";

import {Greeter} from "./contracts/Greeter.sol";
import {GreeterV2} from "./contracts/GreeterV2.sol";
import {GreeterProxiable} from "./contracts/GreeterProxiable.sol";
import {GreeterV2Proxiable} from "./contracts/GreeterV2Proxiable.sol";
import {HasOwner} from "./contracts/HasOwner.sol";
import {WithConstructor} from "./contracts/WithConstructor.sol";
import {WithExternalLibrary} from "./contracts/WithExternalLibrary.sol";

// Import validation fixtures so their artifacts are available to upgrades-core.
import "./contracts/Validations.sol";

contract UpgradesTest is Test {
    address private constant OWNER = address(0xA11CE);
    address private constant EXTERNAL_MATH = address(0x1001);

    function testValidatedUUPSDeployAndUpgradeWithCallData() public {
        address proxy = Upgrades.deployUUPSProxy(
            "GreeterProxiable.sol",
            abi.encodeCall(Greeter.initialize, (OWNER, "hello"))
        );
        Greeter instance = Greeter(proxy);
        address implementationV1 = Upgrades.getImplementationAddress(proxy);

        assertEq(instance.owner(), OWNER);
        assertEq(instance.greeting(), "hello");

        Upgrades.upgradeProxy(proxy, "GreeterV2Proxiable.sol", abi.encodeCall(GreeterV2.resetGreeting, ()), OWNER);

        assertNotEq(Upgrades.getImplementationAddress(proxy), implementationV1);
        assertEq(instance.owner(), OWNER);
        assertEq(instance.greeting(), "resetted");
    }

    function testValidatedUUPSUpgradeWithoutCallDataAndWithoutCaller() public {
        address proxy = Upgrades.deployUUPSProxy(
            "GreeterProxiable.sol",
            abi.encodeCall(Greeter.initialize, (address(this), "preserved"))
        );

        Upgrades.upgradeProxy(proxy, "GreeterV2Proxiable.sol", bytes(""));

        assertEq(Greeter(proxy).greeting(), "preserved");
    }

    function testValidatedTransparentDeployAndUpgradeWithCallData() public {
        address proxy = Upgrades.deployTransparentProxy(
            "Greeter.sol",
            OWNER,
            abi.encodeCall(Greeter.initialize, (OWNER, "hello"))
        );
        address admin = Upgrades.getAdminAddress(proxy);
        address implementationV1 = Upgrades.getImplementationAddress(proxy);

        assertNotEq(admin, address(0));
        assertEq(Greeter(proxy).greeting(), "hello");

        Upgrades.upgradeProxy(proxy, "GreeterV2.sol", abi.encodeCall(GreeterV2.resetGreeting, ()), OWNER);

        assertEq(Upgrades.getAdminAddress(proxy), admin);
        assertNotEq(Upgrades.getImplementationAddress(proxy), implementationV1);
        assertEq(Greeter(proxy).greeting(), "resetted");
    }

    function testValidatedTransparentUpgradeWithoutCallDataAndWithoutCaller() public {
        address proxy = Upgrades.deployTransparentProxy(
            "Greeter.sol",
            address(this),
            abi.encodeCall(Greeter.initialize, (address(this), "preserved"))
        );

        Upgrades.upgradeProxy(proxy, "GreeterV2.sol", bytes(""));

        assertEq(Greeter(proxy).greeting(), "preserved");
    }

    function testValidatedBeaconDeployUpgradeAndFleet() public {
        address beacon = Upgrades.deployBeacon("Greeter.sol", OWNER);
        address implementationV1 = IBeacon(beacon).implementation();
        address proxyOne = Upgrades.deployBeaconProxy(beacon, abi.encodeCall(Greeter.initialize, (OWNER, "one")));
        address proxyTwo = Upgrades.deployBeaconProxy(
            beacon,
            abi.encodeCall(Greeter.initialize, (OWNER, "two")),
            _emptyOptions()
        );

        assertEq(Upgrades.getBeaconAddress(proxyOne), beacon);
        assertEq(Upgrades.getBeaconAddress(proxyTwo), beacon);

        Upgrades.upgradeBeacon(beacon, "GreeterV2.sol", OWNER);

        assertNotEq(IBeacon(beacon).implementation(), implementationV1);
        assertEq(Greeter(proxyOne).greeting(), "one");
        assertEq(Greeter(proxyTwo).greeting(), "two");
    }

    function testValidatedBeaconUpgradeWithoutCaller() public {
        address beacon = Upgrades.deployBeacon("Greeter.sol", address(this), _emptyOptions());
        address implementationV1 = IBeacon(beacon).implementation();

        Upgrades.upgradeBeacon(beacon, "GreeterV2.sol");

        assertNotEq(IBeacon(beacon).implementation(), implementationV1);
    }

    function testConstructorDataDeploysExactValidatedArtifact() public {
        Options memory opts;
        opts.constructorData = abi.encode(123);

        address proxy = Upgrades.deployTransparentProxy(
            "WithConstructor.sol:WithConstructor",
            address(this),
            abi.encodeCall(WithConstructor.initialize, (456)),
            opts
        );

        assertEq(WithConstructor(proxy).a(), 123);
        assertEq(WithConstructor(proxy).b(), 456);
    }

    function testDeployImplementationValidatesThenDeploysStandaloneImplementation() public {
        Options memory opts;
        opts.constructorData = abi.encode(789);

        address implementation = Upgrades.deployImplementation("WithConstructor.sol:WithConstructor", opts);

        assertGt(implementation.code.length, 0);
        assertEq(WithConstructor(implementation).a(), 789);
    }

    function testValidatedDeploymentLinksBoundExternalLibraryArtifact() public {
        deployCodeTo("WithExternalLibrary.sol:ExternalMath", EXTERNAL_MATH);
        Options memory opts;
        opts.unsafeAllow = "external-library-linking";
        opts.linkedLibraries = new LinkedLibrary[](1);
        opts.linkedLibraries[0] = LinkedLibrary({
            sourceName: "test/contracts/WithExternalLibrary.sol",
            libraryName: "ExternalMath",
            libraryAddress: EXTERNAL_MATH
        });

        address implementation = Upgrades.deployImplementation("WithExternalLibrary.sol:WithExternalLibrary", opts);
        opts.unsafeSkipAllChecks = true;
        address unboundImplementation = Upgrades.deployImplementation(
            "WithExternalLibrary.sol:WithExternalLibrary",
            opts
        );

        assertEq(WithExternalLibrary(implementation).twice(21), 42);
        assertEq(WithExternalLibrary(unboundImplementation).twice(22), 44);
    }

    function testPrepareUpgradeValidatesAgainstReferenceThenDeploys() public {
        address implementation = Upgrades.prepareUpgrade("GreeterV2.sol", _reference("Greeter.sol"));

        assertGt(implementation.code.length, 0);
    }

    function testIncompatibleUpgradeFailsValidationBeforeConstructorRuns() public {
        Options memory opts = _reference("Validations.sol:LayoutV1");
        opts.constructorData = hex"1234";

        try this.prepareUpgrade("Validations.sol:LayoutV2_Bad", opts) {
            fail();
        } catch Error(string memory reason) {
            assertTrue(vm.contains(reason, "Upgrade safety validation failed:"));
            assertFalse(vm.contains(reason, "Failed to deploy contract"));
        }
    }

    function testUnsafeSkipAllChecksAllowsUnsafeStandaloneDeployment() public {
        Options memory opts;
        opts.unsafeSkipAllChecks = true;

        assertGt(Upgrades.deployImplementation("Validations.sol:Unsafe", opts).code.length, 0);
    }

    function testUnsafeAllowAllowsUnsafeStandaloneDeployment() public {
        Options memory opts;
        opts.unsafeAllow = "delegatecall";

        assertGt(Upgrades.deployImplementation("Validations.sol:Unsafe", opts).code.length, 0);
    }

    function testUnsafeSkipStorageCheckAllowsPreparationWithoutReference() public {
        Options memory opts;
        opts.unsafeSkipStorageCheck = true;

        assertGt(Upgrades.prepareUpgrade("Validations.sol:LayoutV2_Bad", opts).code.length, 0);
    }

    function testUnsafeAllowRenamesAllowsRenamedLayoutPreparation() public {
        Options memory opts = _reference("Validations.sol:LayoutV1");
        opts.unsafeAllowRenames = true;

        assertGt(Upgrades.prepareUpgrade("Validations.sol:LayoutV2_Renamed", opts).code.length, 0);
    }

    function testProxyAdminOwnerPreflightRejectsProxyAdmin() public {
        ProxyAdmin proxyAdmin = new ProxyAdmin(address(this));

        _assertProxyAdminPreflight(address(proxyAdmin));
    }

    function testProxyAdminOwnerPreflightRejectsOwnerLikeContract() public {
        HasOwner hasOwner = new HasOwner(address(this));

        _assertProxyAdminPreflight(address(hasOwner));
    }

    function testUnsafeSkipProxyAdminCheckAllowsOwnerLikeContract() public {
        HasOwner hasOwner = new HasOwner(address(this));
        Options memory opts;
        opts.unsafeSkipProxyAdminCheck = true;

        address proxy = Upgrades.deployTransparentProxy(
            "Greeter.sol",
            address(hasOwner),
            abi.encodeCall(Greeter.initialize, (address(this), "hello")),
            opts
        );

        assertEq(Greeter(proxy).greeting(), "hello");
    }

    function testUnsafeSkipAllChecksAlsoSkipsProxyAdminPreflight() public {
        HasOwner hasOwner = new HasOwner(address(this));
        Options memory opts;
        opts.unsafeSkipAllChecks = true;

        address proxy = Upgrades.deployTransparentProxy(
            "Greeter.sol",
            address(hasOwner),
            abi.encodeCall(Greeter.initialize, (address(this), "hello")),
            opts
        );

        assertEq(Greeter(proxy).greeting(), "hello");
    }

    function testSafeUUPSRejectsEmptyInitializerData() public {
        Options memory opts;
        opts.unsafeSkipAllChecks = true;

        vm.expectRevert(UnsafeUpgrades.TRC1967InitializationRequired.selector);
        this.deployUUPS("Missing.sol:Missing", bytes(""), opts);
    }

    function testSafeTransparentRejectsEmptyInitializerData() public {
        Options memory opts;
        opts.unsafeSkipAllChecks = true;

        vm.expectRevert(UnsafeUpgrades.TRC1967InitializationRequired.selector);
        this.deployTransparent("Missing.sol:Missing", address(this), bytes(""), opts);
    }

    function testSafeBeaconProxyAcceptsEmptyInitializerData() public {
        address beacon = Upgrades.deployBeacon("Greeter.sol", address(this));

        address proxy = Upgrades.deployBeaconProxy(beacon, bytes(""));

        assertEq(Upgrades.getBeaconAddress(proxy), beacon);
        assertEq(Greeter(proxy).owner(), address(0));
    }

    function prepareUpgrade(string memory contractName, Options memory opts) external returns (address) {
        return Upgrades.prepareUpgrade(contractName, opts);
    }

    function deployUUPS(string memory contractName, bytes memory data, Options memory opts) external returns (address) {
        return Upgrades.deployUUPSProxy(contractName, data, opts);
    }

    function deployTransparent(
        string memory contractName,
        address initialOwner,
        bytes memory data,
        Options memory opts
    ) external returns (address) {
        return Upgrades.deployTransparentProxy(contractName, initialOwner, data, opts);
    }

    function _reference(string memory referenceContract) private pure returns (Options memory opts) {
        opts.referenceContract = referenceContract;
    }

    function _assertProxyAdminPreflight(address initialOwner) private {
        try
            this.deployTransparent(
                "Greeter.sol",
                initialOwner,
                abi.encodeCall(Greeter.initialize, (address(this), "hello")),
                _emptyOptions()
            )
        {
            fail();
        } catch Error(string memory reason) {
            assertTrue(vm.contains(reason, "`initialOwner` must not be a ProxyAdmin contract."));
            assertTrue(vm.contains(reason, vm.toString(initialOwner)));
        }
    }

    function _emptyOptions() private pure returns (Options memory opts) {}
}
