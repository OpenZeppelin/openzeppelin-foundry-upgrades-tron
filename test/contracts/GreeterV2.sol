// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "openzeppelin-tron-solidity/contracts/proxy/utils/Initializable.sol";

/// @custom:oz-upgrades-from Greeter
contract GreeterV2 is Initializable {
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

    function resetGreeting() public reinitializer(2) {
        greeting = "resetted";
    }

    function setGreeting(string memory newGreeting) public onlyOwner {
        greeting = newGreeting;
    }
}
