// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {StringFinder} from "openzeppelin-foundry-upgrades-tron/internal/StringFinder.sol";

contract StringFinderTest is Test {
    using StringFinder for string;

    function testContains() public {
        string memory value = "hello world";
        assertTrue(value.contains("ello"));
        assertFalse(value.contains("Ello"));
        assertTrue(value.contains(""));
    }

    function testStartsWith() public pure {
        string memory value = "hello world";
        string memory empty = "";
        assertTrue(value.startsWith("hello"));
        assertFalse(value.startsWith("ello"));
        assertTrue(value.startsWith(""));
        assertFalse(empty.startsWith("a"));
    }

    function testEndsWith() public pure {
        string memory value = "hello world";
        string memory empty = "";
        assertTrue(value.endsWith("world"));
        assertFalse(value.endsWith("worl"));
        assertTrue(value.endsWith(""));
        assertFalse(empty.endsWith("a"));
    }

    function testCountIsNonOverlapping() public pure {
        string memory value = "hello world";
        string memory overlap = "aaa";
        string memory empty = "";
        assertEq(value.count("l"), 3);
        assertEq(overlap.count("aa"), 1);
        assertEq(value.count(""), 12);
        assertEq(empty.count(""), 1);
    }
}
