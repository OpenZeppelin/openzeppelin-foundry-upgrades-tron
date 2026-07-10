// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {console} from "forge-std/console.sol";
import {Vm} from "forge-std/Vm.sol";

import {Options} from "../Options.sol";
import {ArtifactProvenance} from "./ArtifactProvenance.sol";
import {Utils} from "./Utils.sol";
import {Versions} from "./Versions.sol";
import {IUpgradeableProxy} from "./interfaces/IUpgradeableProxy.sol";
import {IProxyAdmin} from "./interfaces/IProxyAdmin.sol";
import {IUpgradeableBeacon} from "./interfaces/IUpgradeableBeacon.sol";

/**
 * @dev Internal implementation helpers. Applications should use the public
 * upgrades library rather than importing this library directly.
 */
library Core {
    bytes32 private constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 private constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;
    bytes32 private constant BEACON_SLOT = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;

    enum ValidationResult {
        Success,
        ValidationFailure,
        ToolFailure
    }

    function upgradeProxyTo(address proxy, address newImplementation, bytes memory data) internal {
        Vm vm = Vm(Utils.CHEATCODE_ADDRESS);
        address admin = address(uint160(uint256(vm.load(proxy, ADMIN_SLOT))));

        if (admin == address(0)) {
            if (_usesV5UpgradeInterface(proxy) || data.length != 0) {
                IUpgradeableProxy(proxy).upgradeToAndCall(newImplementation, data);
            } else {
                IUpgradeableProxy(proxy).upgradeTo(newImplementation);
            }
        } else if (_usesV5UpgradeInterface(admin) || data.length != 0) {
            IProxyAdmin(admin).upgradeAndCall(proxy, newImplementation, data);
        } else {
            IProxyAdmin(admin).upgrade(proxy, newImplementation);
        }
    }

    function upgradeProxyTo(
        address proxy,
        address newImplementation,
        bytes memory data,
        address tryCaller
    ) internal tryPrank(tryCaller) {
        upgradeProxyTo(proxy, newImplementation, data);
    }

    function upgradeBeaconTo(address beacon, address newImplementation) internal {
        IUpgradeableBeacon(beacon).upgradeTo(newImplementation);
    }

    function upgradeBeaconTo(
        address beacon,
        address newImplementation,
        address tryCaller
    ) internal tryPrank(tryCaller) {
        upgradeBeaconTo(beacon, newImplementation);
    }

    function getAdminAddress(address proxy) internal view returns (address) {
        return address(uint160(uint256(Vm(Utils.CHEATCODE_ADDRESS).load(proxy, ADMIN_SLOT))));
    }

    function getImplementationAddress(address proxy) internal view returns (address) {
        return address(uint160(uint256(Vm(Utils.CHEATCODE_ADDRESS).load(proxy, IMPLEMENTATION_SLOT))));
    }

    function getBeaconAddress(address proxy) internal view returns (address) {
        return address(uint160(uint256(Vm(Utils.CHEATCODE_ADDRESS).load(proxy, BEACON_SLOT))));
    }

    modifier tryPrank(address caller) {
        Vm vm = Vm(Utils.CHEATCODE_ADDRESS);
        try vm.startPrank(caller) {
            _;
            vm.stopPrank();
        } catch {
            _;
        }
    }

    function getUpgradeInterfaceVersion(address target) internal view returns (string memory) {
        (bool success, bytes memory returndata) = target.staticcall(
            abi.encodeWithSignature("UPGRADE_INTERFACE_VERSION()")
        );
        return success && _isCanonicalAbiString(returndata) ? abi.decode(returndata, (string)) : "";
    }

    function _usesV5UpgradeInterface(address target) private view returns (bool) {
        return keccak256(bytes(getUpgradeInterfaceVersion(target))) == keccak256(bytes("5.0.0"));
    }

    function _isCanonicalAbiString(bytes memory encoded) private pure returns (bool) {
        if (encoded.length < 64) return false;

        uint256 offset;
        uint256 stringLength;
        assembly {
            offset := mload(add(encoded, 0x20))
            stringLength := mload(add(encoded, 0x40))
        }

        if (offset != 32 || stringLength > encoded.length - 64) return false;

        uint256 paddedLength = (stringLength + 31) & ~uint256(31);
        if (paddedLength != encoded.length - 64) return false;

        for (uint256 i = 64 + stringLength; i < encoded.length; ++i) {
            if (encoded[i] != 0) return false;
        }
        return true;
    }

    /**
     * @dev Validates that an implementation is upgrade safe. Setting
     * `unsafeSkipAllChecks` is an explicit escape hatch and returns before
     * artifact lookup, provenance verification, or CLI execution.
     */
    function validateImplementation(string memory contractName, Options memory opts) internal {
        _validate(contractName, opts, false);
    }

    /**
     * @dev Validates implementation safety and storage compatibility with an
     * explicit or annotated reference contract.
     */
    function validateUpgrade(string memory contractName, Options memory opts) internal {
        _validate(contractName, opts, true);
    }

    /**
     * @dev Builds an upgrades-core validation command after verifying that the
     * selected artifact and build-info have identical compiler provenance.
     */
    function buildValidateCommand(
        string memory contractName,
        Options memory opts,
        bool requireReference
    ) internal returns (string[] memory) {
        return buildValidateCommand(contractName, opts, requireReference, Utils.getOutDir());
    }

    function buildValidateCommand(
        string memory contractName,
        Options memory opts,
        bool requireReference,
        string memory outDir
    ) internal returns (string[] memory) {
        ArtifactProvenance.assertMatch(contractName, outDir);

        uint256 nonEmptyExcludes;
        for (uint256 j = 0; j < opts.exclude.length; ++j) {
            if (bytes(opts.exclude[j]).length != 0) ++nonEmptyExcludes;
        }

        bool hasReference = bytes(opts.referenceContract).length != 0;
        bool hasReferenceBuildInfo = bytes(opts.referenceBuildInfoDir).length != 0;
        uint256 length =
            6 +
                (hasReference ? 2 : 0) +
                (hasReferenceBuildInfo ? 2 : 0) +
                nonEmptyExcludes * 2 +
                ((opts.unsafeSkipStorageCheck || requireReference) ? 1 : 0) +
                (bytes(opts.unsafeAllow).length != 0 ? 2 : 0) +
                (opts.unsafeAllowRenames ? 1 : 0);

        string[] memory inputs = new string[](length);
        uint256 i;
        inputs[i++] = "npx";
        inputs[i++] = string.concat("@openzeppelin/upgrades-core@", Versions.UPGRADES_CORE);
        inputs[i++] = "validate";
        inputs[i++] = Utils.shellQuote(Utils.getBuildInfoDir(Utils.absoluteOutDir(outDir)));
        inputs[i++] = "--contract";
        inputs[i++] = Utils.shellQuote(Utils.getFullyQualifiedName(contractName, outDir));

        if (hasReference) {
            string memory referenceArg =
                hasReferenceBuildInfo
                    ? opts.referenceContract
                    : Utils.getFullyQualifiedName(opts.referenceContract, outDir);
            inputs[i++] = "--reference";
            inputs[i++] = Utils.shellQuote(referenceArg);
        }

        if (hasReferenceBuildInfo) {
            inputs[i++] = "--referenceBuildInfoDirs";
            inputs[i++] = Utils.shellQuote(Utils.absolutePath(opts.referenceBuildInfoDir));
        }

        for (uint256 j = 0; j < opts.exclude.length; ++j) {
            if (bytes(opts.exclude[j]).length != 0) {
                inputs[i++] = "--exclude";
                inputs[i++] = Utils.shellQuote(opts.exclude[j]);
            }
        }

        if (opts.unsafeSkipStorageCheck) {
            inputs[i++] = "--unsafeSkipStorageCheck";
        } else if (requireReference) {
            inputs[i++] = "--requireReference";
        }

        if (bytes(opts.unsafeAllow).length != 0) {
            inputs[i++] = "--unsafeAllow";
            inputs[i++] = Utils.shellQuote(opts.unsafeAllow);
        }

        if (opts.unsafeAllowRenames) {
            inputs[i] = "--unsafeAllowRenames";
        }

        return inputs;
    }

    /**
     * @dev Classifies upgrades-core output using standalone marker lines. A
     * marker embedded in a contract name, path, or diagnostic is not valid.
     * Conflicting markers and markers paired with the wrong exit code are tool
     * failures.
     */
    function classifyValidationResult(int32 exitCode, bytes memory stdout) internal pure returns (ValidationResult) {
        bool successMarker;
        bool failedMarker;
        uint256 lineStart;

        for (uint256 i = 0; i <= stdout.length; ++i) {
            if (i == stdout.length || stdout[i] == 0x0a) {
                successMarker = successMarker || _lineEquals(stdout, lineStart, i, "SUCCESS");
                failedMarker = failedMarker || _lineEquals(stdout, lineStart, i, "FAILED");
                lineStart = i + 1;
            }
        }

        if (exitCode == 0 && successMarker && !failedMarker) return ValidationResult.Success;
        if (exitCode != 0 && failedMarker && !successMarker) return ValidationResult.ValidationFailure;
        return ValidationResult.ToolFailure;
    }

    function _validate(string memory contractName, Options memory opts, bool requireReference) private {
        if (opts.unsafeSkipAllChecks) return;

        string[] memory inputs = buildValidateCommand(contractName, opts, requireReference);
        Vm.FfiResult memory result = Utils.runAsBashCommand(inputs);
        string memory stdout = string(result.stdout);
        ValidationResult classification = classifyValidationResult(result.exitCode, result.stdout);

        if (classification == ValidationResult.Success) {
            _logWarnings(result.stderr);
            return;
        }

        if (classification == ValidationResult.ValidationFailure) {
            _logWarnings(result.stderr);
            revert(string.concat("Upgrade safety validation failed:\n", stdout));
        }

        string memory diagnostic = result.stderr.length == 0 ? stdout : string(result.stderr);
        revert(string.concat("Failed to run upgrade safety validation: ", diagnostic));
    }

    function _logWarnings(bytes memory warnings) private pure {
        if (warnings.length != 0) console.log(string(warnings));
    }

    function _lineEquals(
        bytes memory output,
        uint256 start,
        uint256 end,
        bytes memory marker
    ) private pure returns (bool) {
        while (start < end && _isLineWhitespace(output[start])) ++start;
        while (end > start && _isLineWhitespace(output[end - 1])) --end;
        if (end - start != marker.length) return false;
        for (uint256 i = 0; i < marker.length; ++i) {
            if (output[start + i] != marker[i]) return false;
        }
        return true;
    }

    function _isLineWhitespace(bytes1 character) private pure returns (bool) {
        return character == 0x20 || character == 0x09 || character == 0x0d;
    }
}
