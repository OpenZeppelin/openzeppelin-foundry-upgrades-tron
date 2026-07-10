// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

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
}
