// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

contract LegacyUUPS {
    bytes32 private constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    address public owner;
    uint256 public value;

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    function initialize(address initialOwner, uint256 initialValue) external {
        require(owner == address(0), "already initialized");
        owner = initialOwner;
        value = initialValue;
    }

    /// @dev Models the v4 UUPS entrypoint without the v5 interface-version getter.
    function upgradeTo(address newImplementation) external onlyOwner {
        assembly {
            sstore(IMPLEMENTATION_SLOT, newImplementation)
        }
    }

    function setValue(uint256 newValue) external {
        value = newValue;
    }
}

interface ILegacyTransparentProxy {
    function upgradeTo(address newImplementation) external;

    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
}

contract LegacyProxyAdmin {
    address public owner;
    uint256 public upgradeCalls;
    uint256 public upgradeAndCallCalls;

    constructor(address initialOwner) {
        owner = initialOwner;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    function upgrade(address proxy, address newImplementation) external onlyOwner {
        ++upgradeCalls;
        ILegacyTransparentProxy(proxy).upgradeTo(newImplementation);
    }

    function upgradeAndCall(address proxy, address newImplementation, bytes calldata data) external payable onlyOwner {
        ++upgradeAndCallCalls;
        ILegacyTransparentProxy(proxy).upgradeToAndCall{value: msg.value}(newImplementation, data);
    }
}

contract LegacyTransparentProxy {
    bytes32 private constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 private constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    constructor(address implementation, address admin, bytes memory initializerData) payable {
        assembly {
            sstore(IMPLEMENTATION_SLOT, implementation)
            sstore(ADMIN_SLOT, admin)
        }
        if (initializerData.length != 0) _delegateCall(implementation, initializerData);
    }

    function upgradeTo(address newImplementation) external {
        require(msg.sender == _admin(), "not admin");
        assembly {
            sstore(IMPLEMENTATION_SLOT, newImplementation)
        }
    }

    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable {
        require(msg.sender == _admin(), "not admin");
        assembly {
            sstore(IMPLEMENTATION_SLOT, newImplementation)
        }
        if (data.length != 0) _delegateCall(newImplementation, data);
    }

    fallback() external payable {
        _delegate(_implementation());
    }

    receive() external payable {
        _delegate(_implementation());
    }

    function _admin() private view returns (address result) {
        assembly {
            result := sload(ADMIN_SLOT)
        }
    }

    function _implementation() private view returns (address result) {
        assembly {
            result := sload(IMPLEMENTATION_SLOT)
        }
    }

    function _delegateCall(address implementation, bytes memory data) private {
        (bool success, bytes memory returndata) = implementation.delegatecall(data);
        if (!success) _revert(returndata);
    }

    function _delegate(address implementation) private {
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), implementation, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 {
                revert(0, returndatasize())
            }
            default {
                return(0, returndatasize())
            }
        }
    }

    function _revert(bytes memory returndata) private pure {
        assembly {
            revert(add(returndata, 0x20), mload(returndata))
        }
    }
}
