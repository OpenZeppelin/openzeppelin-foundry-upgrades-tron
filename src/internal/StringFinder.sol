// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Vm} from "forge-std/Vm.sol";
import {Utils} from "./Utils.sol";

/**
 * @dev String search helpers backed by Forge cheatcodes.
 */
library StringFinder {
    function contains(string memory subject, string memory search) internal returns (bool) {
        return Vm(Utils.CHEATCODE_ADDRESS).contains(subject, search);
    }

    function startsWith(string memory subject, string memory search) internal pure returns (bool) {
        return Vm(Utils.CHEATCODE_ADDRESS).indexOf(subject, search) == 0;
    }

    function endsWith(string memory subject, string memory search) internal pure returns (bool) {
        string[] memory tokens = Vm(Utils.CHEATCODE_ADDRESS).split(subject, search);
        return tokens.length > 1 && bytes(tokens[tokens.length - 1]).length == 0;
    }

    function count(string memory subject, string memory search) internal pure returns (uint256) {
        return Vm(Utils.CHEATCODE_ADDRESS).split(subject, search).length - 1;
    }
}
