// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @dev Exact library link used when the validated creation bytecode contains
 * an unresolved Solidity linker placeholder.
 */
struct LinkedLibrary {
    /// @dev Compiler source name that owns the library.
    string sourceName;
    /// @dev Case-sensitive library name from the artifact link references.
    string libraryName;
    /// @dev Deployed library address. The address must contain code.
    address libraryAddress;
}

/**
 * @dev Common options for validating and deploying upgradeable contracts.
 */
struct Options {
    /**
     * @dev Reference contract used for storage-layout comparisons. When no
     * historical build-info directory is set, Foundry contract-name formats
     * are supported. With a historical directory, use upgrades-core's
     * `<directory-name>:<contract>` reference format.
     */
    string referenceContract;
    /**
     * @dev Absolute path, or a path relative to the Foundry project root, to
     * historical build-info used for storage-layout comparisons.
     */
    string referenceBuildInfoDir;
    /**
     * @dev ABI-encoded implementation constructor arguments.
     */
    bytes constructorData;
    /**
     * @dev Source-path glob patterns excluded from validation.
     */
    string[] exclude;
    /**
     * @dev Comma-separated upgrades-core validation errors to allow.
     */
    string unsafeAllow;
    /**
     * @dev Allows storage variables to be renamed.
     */
    bool unsafeAllowRenames;
    /**
     * @dev Skips the transparent proxy initial-owner safety check.
     */
    bool unsafeSkipProxyAdminCheck;
    /**
     * @dev Skips storage-layout compatibility checks.
     */
    bool unsafeSkipStorageCheck;
    /**
     * @dev Skips every upgrade-safety validation.
     */
    bool unsafeSkipAllChecks;
    /**
     * @dev Exact source/library/address mappings used to link validated
     * creation bytecode in memory. Every mapping must be used.
     */
    LinkedLibrary[] linkedLibraries;
}
