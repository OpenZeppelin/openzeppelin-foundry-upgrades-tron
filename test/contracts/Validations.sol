// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Options} from "openzeppelin-foundry-upgrades-tron/Options.sol";

// These contracts are for testing only. They are not safe for production use.

contract OptionsApiShape {
    function allSupportedOptions() external pure returns (Options memory) {
        string[] memory excludes = new string[](1);
        excludes[0] = "test/contracts/helpers/**/*.sol";
        return
            Options({
                referenceContract: "build-info-v1:LayoutV1",
                referenceBuildInfoDir: "previous-builds/build-info-v1",
                constructorData: hex"1234",
                exclude: excludes,
                unsafeAllow: "delegatecall,selfdestruct",
                unsafeAllowRenames: true,
                unsafeSkipProxyAdminCheck: true,
                unsafeSkipStorageCheck: true,
                unsafeSkipAllChecks: true
            });
    }
}

contract Unsafe {
    function unsafe() public {
        (bool success, ) = msg.sender.delegatecall("");
        success;
    }
}

contract LayoutV1 {
    uint256 private a;
    uint256 private b;
}

contract LayoutV2_Bad {
    uint256 private a;
    uint256 private c;
    uint256 private b;
}

/// @custom:oz-upgrades-from LayoutV1
contract LayoutV2_Renamed {
    uint256 private oldA;
    uint256 private b;
}

/// @custom:oz-upgrades-from LayoutV1
contract LayoutV2_UpgradesFrom_Bad {
    uint256 private a;
    uint256 private c;
    uint256 private b;
}

contract NamespacedV1 {
    /// @custom:storage-location erc7201:validations.storage
    struct Storage {
        uint256 a;
        uint256 b;
    }
}

contract NamespacedV2_Bad {
    /// @custom:storage-location erc7201:validations.storage
    struct Storage {
        uint256 a;
        uint256 c;
        uint256 b;
    }
}

/// @custom:oz-upgrades-from NamespacedV1
contract NamespacedV2_UpgradesFrom_Bad {
    /// @custom:storage-location erc7201:validations.storage
    struct Storage {
        uint256 a;
        uint256 c;
        uint256 b;
    }
}

contract NamespacedV2_Ok {
    /// @custom:storage-location erc7201:validations.storage
    struct Storage {
        uint256 a;
        uint256 b;
        uint256 c;
    }
}

/// @custom:oz-upgrades-from NamespacedV1
contract NamespacedV2_UpgradesFrom_Ok {
    /// @custom:storage-location erc7201:validations.storage
    struct Storage {
        uint256 a;
        uint256 b;
        uint256 c;
    }
}

contract HasWarningAndError {
    uint256 private immutable x = 1;

    function unsafe() public {
        (bool success, ) = msg.sender.delegatecall("");
        success;
    }
}
