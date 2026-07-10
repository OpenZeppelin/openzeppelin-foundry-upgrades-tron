// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {UUPSUpgradeable} from "openzeppelin-tron-solidity/contracts/proxy/utils/UUPSUpgradeable.sol";

import {GreeterV2} from "./GreeterV2.sol";

/// @custom:oz-upgrades-from GreeterProxiable
contract GreeterV2Proxiable is GreeterV2, UUPSUpgradeable {
    function _authorizeUpgrade(address) internal override onlyOwner {}
}
