// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Vm} from "forge-std/Vm.sol";
import {StringFinder} from "./StringFinder.sol";

struct ContractInfo {
    string contractPath;
    string shortName;
    string license;
    string sourceCodeHash;
    string artifactPath;
}

/**
 * @dev Internal Foundry artifact and command helpers.
 */
library Utils {
    using StringFinder for string;

    address internal constant CHEATCODE_ADDRESS = 0x7109709ECfa91a80626fF3989D68f67F5b1DD12D;

    error UnsafeContractName(string name);

    function getFullyQualifiedName(string memory contractName, string memory outDir) internal returns (string memory) {
        ContractInfo memory info = getContractInfo(contractName, outDir);
        return string.concat(info.contractPath, ":", info.shortName);
    }

    function getContractInfo(string memory contractName, string memory outDir) internal returns (ContractInfo memory) {
        _assertSafeContractName(contractName);
        Vm vm = Vm(CHEATCODE_ADDRESS);
        ContractInfo memory info;
        info.shortName = _toShortName(contractName);

        string memory artifactPath;
        if (contractName.endsWith(".json")) {
            artifactPath = absolutePath(contractName);
        } else {
            string memory directPath = string.concat(
                absoluteOutDir(outDir),
                "/",
                _toFileName(contractName),
                "/",
                info.shortName,
                ".json"
            );
            if (vm.exists(directPath)) {
                artifactPath = directPath;
            } else {
                artifactPath = _findArtifactByName(outDir, info.shortName);
            }
        }

        return _processArtifact(info, artifactPath, vm.readFile(artifactPath));
    }

    function _processArtifact(
        ContractInfo memory info,
        string memory artifactPath,
        string memory artifactJson
    ) private view returns (ContractInfo memory) {
        Vm vm = Vm(CHEATCODE_ADDRESS);
        info.artifactPath = artifactPath;
        if (!vm.keyExistsJson(artifactJson, ".ast")) {
            revert(
                string.concat("Could not find AST in artifact ", artifactPath, ". Set `ast = true` in foundry.toml")
            );
        }

        string memory artifactSourceName = vm.parseJsonString(artifactJson, ".ast.absolutePath");
        bool hardhat3 =
            vm.keyExistsJson(artifactJson, "._format") &&
                _equal(vm.parseJsonString(artifactJson, "._format"), "hh3-artifact-1");
        if (hardhat3 && artifactSourceName.startsWith("project/")) {
            info.contractPath = vm.replace(artifactSourceName, "project/", "");
        } else {
            info.contractPath = artifactSourceName;
        }
        if (vm.keyExistsJson(artifactJson, ".ast.license")) {
            info.license = vm.parseJsonString(artifactJson, ".ast.license");
        }
        string memory sourcePath = _jsonKey(".metadata.sources", artifactSourceName);
        info.sourceCodeHash = vm.parseJsonString(artifactJson, string.concat(sourcePath, ".keccak256"));
        return info;
    }

    function _findArtifactByName(string memory outDir, string memory shortName) private returns (string memory) {
        string[] memory inputs = new string[](8);
        inputs[0] = "find";
        inputs[1] = shellQuote(absoluteOutDir(outDir));
        inputs[2] = "-type";
        inputs[3] = "f";
        inputs[4] = "-name";
        inputs[5] = shellQuote(string.concat(shortName, ".json"));
        inputs[6] = "-print";
        inputs[7] = "2>/dev/null";
        Vm.FfiResult memory result = runAsBashCommand(inputs);
        string[] memory matches = _nonEmptyLines(string(result.stdout));
        if (result.exitCode != 0 || matches.length == 0) {
            revert(string.concat("Could not find artifact for contract ", shortName, " in directory ", outDir));
        }
        if (matches.length > 1) {
            revert(
                string.concat(
                    "Found multiple artifacts for contract ",
                    shortName,
                    " in directory ",
                    outDir,
                    ". Specify the Solidity file name and the contract name in the format 'MyContract.sol:MyContract' or use the artifact path."
                )
            );
        }
        return matches[0];
    }

    function getBuildInfoDir(string memory outDir) internal pure returns (string memory) {
        string memory normalized = _trimTrailingSeparators(outDir);
        if (normalized.startsWith("artifacts/contracts") || normalized.startsWith("artifacts\\contracts")) {
            return "artifacts/build-info";
        }
        if (normalized.endsWith("/artifacts/contracts") || normalized.endsWith("\\artifacts\\contracts")) {
            return string.concat(_withoutSuffix(normalized, "contracts"), "build-info");
        }
        return string.concat(normalized, "/build-info");
    }

    function getBuildInfoFile(
        string memory sourceCodeHash,
        string memory contractName,
        string memory outDir
    ) internal returns (string memory) {
        string memory buildInfoDir = absolutePath(getBuildInfoDir(outDir));
        string[] memory inputs = new string[](7);
        inputs[0] = "grep";
        inputs[1] = "-rl";
        inputs[2] = "--include='*.json'";
        inputs[3] = "--fixed-strings";
        inputs[4] = "--";
        inputs[5] = shellQuote(sourceCodeHash);
        inputs[6] = shellQuote(buildInfoDir);
        Vm.FfiResult memory result = runAsBashCommand(inputs);
        string[] memory matches = _nonEmptyLines(string(result.stdout));
        if (result.exitCode != 0 || matches.length == 0) {
            revert(
                string.concat(
                    "Could not find build-info file with matching source code hash for contract ",
                    contractName
                )
            );
        }
        if (matches.length > 1) {
            revert(
                string.concat(
                    "Found multiple build-info files with matching source code hash for contract ",
                    contractName
                )
            );
        }
        return matches[0];
    }

    function getOutDir() internal view returns (string memory) {
        return Vm(CHEATCODE_ADDRESS).envOr("FOUNDRY_OUT", string("out"));
    }

    function absoluteOutDir(string memory outDir) internal view returns (string memory) {
        return absolutePath(_trimTrailingSeparators(outDir));
    }

    function absolutePath(string memory path) internal view returns (string memory) {
        if (bytes(path).length > 0 && bytes(path)[0] == bytes1("/")) {
            return _trimTrailingSeparators(path);
        }
        return string.concat(Vm(CHEATCODE_ADDRESS).projectRoot(), "/", _trimTrailingSeparators(path));
    }

    function findJsonFiles(string memory directory) internal returns (string[] memory) {
        string[] memory inputs = new string[](8);
        inputs[0] = "find";
        inputs[1] = shellQuote(directory);
        inputs[2] = "-type";
        inputs[3] = "f";
        inputs[4] = "-name";
        inputs[5] = shellQuote("*.json");
        inputs[6] = "-print";
        inputs[7] = "2>/dev/null";
        Vm.FfiResult memory result = runAsBashCommand(inputs);
        if (result.exitCode != 0) {
            return new string[](0);
        }
        return _nonEmptyLines(string(result.stdout));
    }

    function _toFileName(string memory name) private pure returns (string memory) {
        if (name.endsWith(".sol")) {
            return name;
        }
        if (name.count(":") == 1) {
            return Vm(CHEATCODE_ADDRESS).split(name, ":")[0];
        }
        revert(_invalidNameMessage(name));
    }

    function _toShortName(string memory name) private pure returns (string memory) {
        Vm vm = Vm(CHEATCODE_ADDRESS);
        if (name.endsWith(".sol") && name.count(".sol") == 1) {
            string[] memory parts = vm.split(name, "/");
            return vm.replace(parts[parts.length - 1], ".sol", "");
        }
        if (name.count(":") == 1) {
            return vm.split(name, ":")[1];
        }
        if (name.endsWith(".json") && name.count(".json") == 1) {
            string[] memory parts = vm.split(name, "/");
            return vm.replace(parts[parts.length - 1], ".json", "");
        }
        revert(_invalidNameMessage(name));
    }

    function _invalidNameMessage(string memory name) private pure returns (string memory) {
        return
            string.concat(
                "Contract name ",
                name,
                " must be in the format MyContract.sol:MyContract or MyContract.sol or out/MyContract.sol/MyContract.json"
            );
    }

    function _assertSafeContractName(string memory name) private pure {
        bytes memory value = bytes(name);
        for (uint256 i = 0; i < value.length; ++i) {
            bytes1 c = value[i];
            bool safe =
                (c >= 0x30 && c <= 0x39) ||
                    (c >= 0x41 && c <= 0x5a) ||
                    (c >= 0x61 && c <= 0x7a) ||
                    c == "_" ||
                    c == "-" ||
                    c == "." ||
                    c == "/" ||
                    c == ":" ||
                    c == "@" ||
                    c == " ";
            if (!safe) revert UnsafeContractName(name);
        }
    }

    function shellQuote(string memory operand) internal pure returns (string memory) {
        bytes memory raw = bytes(operand);
        bytes memory quoted = bytes("'");
        for (uint256 i = 0; i < raw.length; ++i) {
            if (raw[i] == "'") {
                quoted = abi.encodePacked(quoted, "'\\''");
            } else {
                quoted = abi.encodePacked(quoted, raw[i]);
            }
        }
        return string(abi.encodePacked(quoted, "'"));
    }

    function toBashCommand(string[] memory inputs, string memory bashPath) internal pure returns (string[] memory) {
        string memory command;
        for (uint256 i = 0; i < inputs.length; ++i) {
            command = string.concat(command, inputs[i], i + 1 == inputs.length ? "" : " ");
        }
        string[] memory result = new string[](3);
        result[0] = bashPath;
        result[1] = "-c";
        result[2] = command;
        return result;
    }

    function runAsBashCommand(string[] memory inputs) internal returns (Vm.FfiResult memory) {
        Vm vm = Vm(CHEATCODE_ADDRESS);
        string[] memory command = toBashCommand(inputs, vm.envOr("OPENZEPPELIN_BASH_PATH", string("bash")));
        Vm.FfiResult memory result = vm.tryFfi(command);
        if (result.exitCode != 0 && result.stdout.length == 0 && result.stderr.length == 0) {
            revert(string.concat("Failed to run bash command with ", shellQuote(command[0])));
        }
        return result;
    }

    function _nonEmptyLines(string memory value) private pure returns (string[] memory) {
        string[] memory lines = Vm(CHEATCODE_ADDRESS).split(value, "\n");
        uint256 count;
        for (uint256 i = 0; i < lines.length; ++i) {
            if (bytes(lines[i]).length != 0) ++count;
        }
        string[] memory result = new string[](count);
        uint256 cursor;
        for (uint256 i = 0; i < lines.length; ++i) {
            if (bytes(lines[i]).length != 0) result[cursor++] = lines[i];
        }
        return result;
    }

    function _trimTrailingSeparators(string memory value) private pure returns (string memory) {
        bytes memory raw = bytes(value);
        uint256 length = raw.length;
        while (length > 1 && (raw[length - 1] == "/" || raw[length - 1] == "\\")) --length;
        bytes memory trimmed = new bytes(length);
        for (uint256 i = 0; i < length; ++i) trimmed[i] = raw[i];
        return string(trimmed);
    }

    function _withoutSuffix(string memory value, string memory suffix) private pure returns (string memory) {
        bytes memory raw = bytes(value);
        bytes memory ending = bytes(suffix);
        bytes memory result = new bytes(raw.length - ending.length);
        for (uint256 i = 0; i < result.length; ++i) result[i] = raw[i];
        return string(result);
    }

    function _jsonKey(string memory prefix, string memory key) internal pure returns (string memory) {
        return string.concat(prefix, ".['", key, "']");
    }

    function _equal(string memory a, string memory b) private pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
