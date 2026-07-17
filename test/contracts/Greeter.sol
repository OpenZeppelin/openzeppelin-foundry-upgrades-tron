// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "openzeppelin-tron-solidity/contracts/proxy/utils/Initializable.sol";

contract Greeter is Initializable {
    error Unauthorized(address account);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    address public owner;
    string public greeting;

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized(msg.sender);
        _;
    }

    function initialize(address initialOwner, string memory initialGreeting) public initializer {
        owner = initialOwner;
        greeting = initialGreeting;
    }
}
