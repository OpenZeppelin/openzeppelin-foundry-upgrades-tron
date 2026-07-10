// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

contract RawUpgradeVersionResponder {
    bytes private _response;

    constructor(bytes memory response) {
        _response = response;
    }

    fallback(bytes calldata input) external returns (bytes memory output) {
        require(bytes4(input) == bytes4(keccak256("UPGRADE_INTERFACE_VERSION()")));
        return _response;
    }
}

contract LegacyMalformedUpgradeProxy is RawUpgradeVersionResponder {
    address public upgradedTo;

    constructor(bytes memory response) RawUpgradeVersionResponder(response) {}

    function upgradeTo(address newImplementation) external {
        upgradedTo = newImplementation;
    }
}

contract LegacyMalformedProxyAdmin is RawUpgradeVersionResponder {
    address public upgradedProxy;
    address public upgradedTo;

    constructor(bytes memory response) RawUpgradeVersionResponder(response) {}

    function upgrade(address proxy, address newImplementation) external {
        upgradedProxy = proxy;
        upgradedTo = newImplementation;
    }
}

contract LegacyAdminManagedProxy {
    bytes32 private constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    constructor(address admin) {
        assembly {
            sstore(ADMIN_SLOT, admin)
        }
    }
}
