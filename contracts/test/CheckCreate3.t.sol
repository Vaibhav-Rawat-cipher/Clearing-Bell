// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {HookDeployer} from "src/hooks/HookDeployer.sol";
import {ClearingBellHook} from "src/hooks/ClearingBellHook.sol";

contract CheckCreate3 is Test {
    function testBytecode() public {
        bytes memory creationCode = type(ClearingBellHook).creationCode;
        console.log("Length:", creationCode.length);
        console.logBytes32(keccak256(creationCode));
    }
}
