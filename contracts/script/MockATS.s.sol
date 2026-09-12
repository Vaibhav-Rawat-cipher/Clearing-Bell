// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {ERC20} from "solmate/tokens/ERC20.sol";

contract MockBondToken is ERC20 {
    constructor() ERC20("Clearing Bell Bond 2028", "CBB28", 18) {
        _mint(msg.sender, 1_000_000 * 1e18);
    }
}

contract MockIdentityRegistry {
    mapping(address => bool) public isVerified;
    function registerIdentity(address userAddress, address, uint16) external {
        isVerified[userAddress] = true;
    }
}

contract MockATSDeploy is Script {
    function run() external {
        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        
        MockBondToken bond = new MockBondToken();
        MockIdentityRegistry registry = new MockIdentityRegistry();
        
        console.log("=========================================");
        console.log("✅ Bond deployed successfully (Mock)!");
        console.log("Bond token address     :", address(bond));
        console.log("Identity registry      :", address(registry));
        console.log("=========================================");
        console.log("Add to your .env:");
        console.log("BOND_TOKEN_ADDRESS=", address(bond));
        console.log("ATS_IDENTITY_REGISTRY_ADDRESS=", address(registry));
        
        vm.stopBroadcast();
    }
}
