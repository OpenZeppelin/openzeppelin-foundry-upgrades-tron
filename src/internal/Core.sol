// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {console} from "forge-std/console.sol";
import {Vm} from "forge-std/Vm.sol";

import {Options} from "../Options.sol";
import {ArtifactProvenance} from "./ArtifactProvenance.sol";
import {Utils} from "./Utils.sol";
import {Versions} from "./Versions.sol";

/**
 * @dev Internal implementation helpers. Applications should use the public
 * upgrades library rather than importing this library directly.
 */
library Core {
    enum ValidationResult {
        Success,
        ValidationFailure,
        ToolFailure
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

    function _validate(string memory contractName, Options memory opts, bool requireReference) private {
        if (opts.unsafeSkipAllChecks) return;

        string[] memory inputs = buildValidateCommand(contractName, opts, requireReference);
        Vm.FfiResult memory result = Utils.runAsBashCommand(inputs);
        string memory stdout = string(result.stdout);
        Vm vm = Vm(Utils.CHEATCODE_ADDRESS);

        if (result.exitCode == 0 && vm.contains(stdout, "SUCCESS")) {
            _logWarnings(result.stderr);
            return;
        }

        if (result.exitCode != 0 && vm.contains(stdout, "FAILED")) {
            _logWarnings(result.stderr);
            revert(string.concat("Upgrade safety validation failed:\n", stdout));
        }

        string memory diagnostic = result.stderr.length == 0 ? stdout : string(result.stderr);
        revert(string.concat("Failed to run upgrade safety validation: ", diagnostic));
    }

    function _logWarnings(bytes memory warnings) private pure {
        if (warnings.length != 0) console.log(string(warnings));
    }
}
