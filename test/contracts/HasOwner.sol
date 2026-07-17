// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Ownable} from "openzeppelin-tron-solidity/contracts/access/Ownable.sol";
import {ITransparentUpgradeableProxy} from "openzeppelin-tron-solidity/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ProxyAdmin} from "openzeppelin-tron-solidity/contracts/proxy/transparent/ProxyAdmin.sol";

// These contracts are for testing only. They are not safe for production use.

contract HasOwner is Ownable {
    constructor(address initialOwner) Ownable(initialOwner) {}

    function upgradeAndCall(
        ProxyAdmin admin,
        ITransparentUpgradeableProxy proxy,
        address implementation,
        bytes memory data
    ) public payable onlyOwner {
        admin.upgradeAndCall{value: msg.value}(proxy, implementation, data);
    }
}

contract NoGetter {}

contract StringOwner {
    string public owner;

    constructor(string memory initialOwner) {
        owner = initialOwner;
    }
}

contract StateChanging {
    bool public triggered;

    function owner() public {
        triggered = true;
    }
}
