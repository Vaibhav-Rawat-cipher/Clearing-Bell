// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {HookMiner} from "v4-periphery/utils/HookMiner.sol";

import {ComplianceGate} from "src/auction/ComplianceGate.sol";
import {AuctionEngine} from "src/auction/AuctionEngine.sol";
import {ClearingBellHook} from "src/hooks/ClearingBellHook.sol";
import {BondConfig} from "src/bond/BondConfig.sol";

/// @title Deploy
/// @notice Foundry broadcast script — deploys the full Clearing Bell EVM stack.
///
/// @dev Run on Hedera testnet (chain ID 296):
///
///   forge script contracts/script/Deploy.s.sol \
///     --rpc-url $HEDERA_RPC_URL \
///     --private-key $DEPLOYER_PRIVATE_KEY \
///     --broadcast \
///     --slow \
///     -vvvv
///
/// Deployment order (PLAN.md §10):
///   1. BondConfig    — records addresses (call configure() after ATS bond deployed)
///   2. ComplianceGate
///   3. AuctionEngine
///   4. ClearingBellHook (CREATE2 with permission-encoded address via HookMiner)
///
/// After running this script:
///   - Copy all logged addresses into your .env
///   - Run scripts/deploy-bond.ts to deploy the ATS bond and call BondConfig.configure()
///   - Run scripts/seed-testnet.ts to KYC test wallets
contract Deploy is Script {
    // =========================================================================
    // State (read from env)
    // =========================================================================

    address internal deployer;
    address internal issuer;
    address internal poolManager;
    address internal bondToken;       // set after ATS bond deployed
    address internal settlementToken; // USDC on Hedera testnet

    // =========================================================================
    // Run
    // =========================================================================

    function run() external {
        // Read config from environment
        deployer       = vm.envAddress("DEPLOYER_ADDRESS");
        issuer         = vm.envOr("ISSUER_ADDRESS", deployer);
        poolManager    = vm.envOr("POOL_MANAGER_ADDRESS", address(0));
        bondToken      = vm.envOr("BOND_TOKEN_ADDRESS",   address(0));
        settlementToken = vm.envOr("USDC_ADDRESS",        address(0));

        console.log("=== Clearing Bell Deployment ===");
        console.log("Deployer :", deployer);
        console.log("Issuer   :", issuer);
        console.log("Network  : chain", block.chainid);

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));

        // --- 1. BondConfig ---
        BondConfig bondConfig = new BondConfig();
        console.log("BondConfig          :", address(bondConfig));

        // --- 2. ComplianceGate ---
        ComplianceGate gate = new ComplianceGate();
        console.log("ComplianceGate      :", address(gate));

        // --- 3. AuctionEngine ---
        AuctionEngine engine = new AuctionEngine(address(gate), issuer);
        console.log("AuctionEngine       :", address(engine));

        // --- 4. ClearingBellHook (CREATE2, permission-encoded address) ---
        address hookAddr;
        ClearingBellHook hook;

        if (poolManager != address(0)) {
            bytes memory constructorArgs = abi.encode(poolManager, address(engine));
            uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);
            bytes32 salt;
            (hookAddr, salt) = HookMiner.find(deployer, flags, type(ClearingBellHook).creationCode, constructorArgs);
            hook = new ClearingBellHook{salt: salt}(IPoolManager(poolManager), engine);
            require(address(hook) == hookAddr, "Hook address mismatch");
            console.log("ClearingBellHook    :", address(hook));

            // Authorize the hook as a bid relayer
            engine.setAuthorizedBidRelayer(address(hook), true);
            console.log("Hook authorized as bid relayer");
        } else {
            console.log("ClearingBellHook    : SKIPPED (POOL_MANAGER_ADDRESS not set)");
            console.log("  -> Deploy PoolManager first, then re-run with POOL_MANAGER_ADDRESS set");
        }

        // --- 5. Wire BondConfig (if bond already deployed) ---
        if (bondToken != address(0) && settlementToken != address(0)) {
            // Register the bond's identity registry in ComplianceGate
            // (requires ATS_IDENTITY_REGISTRY_ADDRESS in env)
            address atsRegistry = vm.envOr("ATS_IDENTITY_REGISTRY_ADDRESS", address(0));
            if (atsRegistry != address(0)) {
                gate.registerRegistry(bondToken, atsRegistry);
                console.log("ComplianceGate wired to ATS registry for bond:", bondToken);
            }

            bondConfig.configure(
                bondToken,
                vm.envOr("ATS_IDENTITY_REGISTRY_ADDRESS", address(0)),
                address(gate),
                address(engine),
                settlementToken
            );
            if (poolManager != address(0)) {
                bondConfig.setHook(address(hook));
            }
            console.log("BondConfig configured");
        } else {
            console.log("BondConfig.configure() SKIPPED — run after deploy-bond.ts");
        }

        vm.stopBroadcast();

        // --- Summary ---
        console.log("\n=== Deployment Summary ===");
        console.log("Add these to your .env:");
        console.log("BOND_CONFIG_ADDRESS=", address(bondConfig));
        console.log("COMPLIANCE_GATE_ADDRESS=", address(gate));
        console.log("AUCTION_ENGINE_ADDRESS=", address(engine));
        if (poolManager != address(0)) {
            console.log("HOOK_ADDRESS=", address(hook));
        }
    }
}
