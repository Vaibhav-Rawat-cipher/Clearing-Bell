// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {HookDeployer} from "src/hooks/HookDeployer.sol";
import {ClearingBellHook} from "src/hooks/ClearingBellHook.sol";

contract CheckCreate2 is Test {
    function testAddress() public {
        address poolManager = address(1);
        address auctionEngine = address(2);
        address deployer = address(3);
        
        bytes memory initCode = abi.encodePacked(
            type(ClearingBellHook).creationCode,
            abi.encode(poolManager, auctionEngine)
        );
        
        bytes32 salt = bytes32(uint256(0x3088)); // Example salt
        
        address computed = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), deployer, salt, keccak256(initCode))
                    )
                )
            )
        );
        
        console.log("Solidity computed:", computed);
        console.logBytes32(keccak256(initCode));
    }
}
