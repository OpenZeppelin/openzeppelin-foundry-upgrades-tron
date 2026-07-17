// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {UUPSUpgradeable} from "openzeppelin-tron-solidity/contracts/proxy/utils/UUPSUpgradeable.sol";

import {Greeter} from "./Greeter.sol";

contract GreeterProxiable is Greeter, UUPSUpgradeable {
    function _authorizeUpgrade(address) internal override onlyOwner {}
}
