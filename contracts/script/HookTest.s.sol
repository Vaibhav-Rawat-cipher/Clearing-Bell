// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {ERC20} from "solmate/tokens/ERC20.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {HookMiner} from "v4-periphery/utils/HookMiner.sol";

import {ClearingBellHook} from "src/hooks/ClearingBellHook.sol";
import {ComplianceGate} from "src/auction/ComplianceGate.sol";
import {AuctionEngine} from "src/auction/AuctionEngine.sol";

// ============================================================
// Minimal mocks
// ============================================================

contract MockBondH is ERC20 {
    constructor() ERC20("Clearing Bell Bond [HOOK-TEST]", "hCBB28", 18) {
        _mint(msg.sender, 1_000_000 * 1e18);
    }
}

/// @dev Open registry -- only Alice and Bob are KYC'd.
contract PartialRegistryH {
    mapping(address => bool) public isVerified;
    mapping(address => uint256) public registrationDateOf;

    function register(address user) external {
        isVerified[user] = true;
        registrationDateOf[user] = block.timestamp;
    }
}

/// @dev Deployed on-chain stand-in for the Uniswap v4 PoolManager.
///      Uniswap v4 is not yet deployed on Hedera testnet (chain 296).
///      The hook's onlyPoolManager gate checks msg.sender == poolManager;
///      this contract satisfies that check and lets us trigger beforeSwap
///      and afterSwap calls from an EOA via a single dispatchBeforeSwap() call.
contract TestnetPoolManager {
    /// @notice Forward a beforeSwap call to the hook.
    ///         The hook sees msg.sender == address(this) == poolManager => passes.
    function dispatchBeforeSwap(
        address hookAddr,
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    ) external returns (bytes4, int128, uint24) {
        (bytes4 sel, BeforeSwapDelta delta, uint24 fee) =
            IHooks(hookAddr).beforeSwap(sender, key, params, hookData);
        return (sel, int128(BeforeSwapDelta.unwrap(delta)), fee);
    }

    /// @notice Forward an afterSwap call to the hook.
    function dispatchAfterSwap(
        address hookAddr,
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    ) external returns (bytes4, int128) {
        BalanceDelta delta = BalanceDelta.wrap(0);
        return IHooks(hookAddr).afterSwap(sender, key, params, delta, hookData);
    }
}

// ============================================================
// Setup Script
// ============================================================

/// @title HookTestSetup
/// @notice Deploys a complete testnet hook test environment:
///
///   1. TestnetPoolManager  -- stand-in for Uniswap v4 PoolManager (not on Hedera)
///   2. MockBondH + PartialRegistryH -- KYC bypass (Alice + Bob only)
///   3. ClearingBellHook -- mined CREATE2 address w/ BEFORE+AFTER_SWAP flags
///   4. Wires everything: ComplianceGate, AuctionEngine, Hook, active round
///
///   Real production contracts used:
///     ComplianceGate : 0x59acE2042088Dc40790a456f6af24feBdbB4Dfc7
///     AuctionEngine  : 0x663d1825f7a1eb323EB531152e23720C7f2AD7a2
///     USDC           : 0x37A4ae6511f491C5a07fbf61F6cF8b292727D255
///
/// Usage:
///   cd contracts
///   forge script script/HookTest.s.sol:HookTestSetup \
///     --rpc-url $HEDERA_RPC_URL \
///     --private-key $DEPLOYER_PRIVATE_KEY \
///     --broadcast --slow -vvv
contract HookTestSetup is Script {
    // ---- Real production contracts ----
    address constant REAL_GATE   = 0x59acE2042088Dc40790a456f6af24feBdbB4Dfc7;
    address constant REAL_ENGINE = 0x663d1825f7a1eb323EB531152e23720C7f2AD7a2;
    address constant REAL_USDC   = 0x37A4ae6511f491C5a07fbf61F6cF8b292727D255;

    // ---- Test wallets (Foundry well-known accounts #0 + #1) ----
    address constant ALICE = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266; // buyer
    address constant BOB   = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8; // seller

    uint256 constant BID_WINDOW = 3600; // 1 hour — enough for both Alice + Bob to bid

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        ComplianceGate gate   = ComplianceGate(REAL_GATE);
        AuctionEngine  engine = AuctionEngine(REAL_ENGINE);
        ERC20          usdc   = ERC20(REAL_USDC);

        vm.startBroadcast(deployerKey);

        // --- 1. Deploy on-chain PoolManager stand-in ---
        TestnetPoolManager pm = new TestnetPoolManager();

        // --- 2. Mine + deploy ClearingBellHook via CREATE2 ---
        bytes memory constructorArgs = abi.encode(address(pm), address(engine));
        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);
        // IMPORTANT: Foundry routes `new Contract{salt: salt}` through its own
        // CREATE2 factory at 0x4e59b44847b379578588920cA78FbF26c0B4956C, NOT
        // the deployer EOA. HookMiner must use the same address as `from`.
        address create2Factory = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
        (address hookAddr, bytes32 salt) = HookMiner.find(
            create2Factory, flags, type(ClearingBellHook).creationCode, constructorArgs
        );
        ClearingBellHook hook = new ClearingBellHook{salt: salt}(
            IPoolManager(address(pm)), engine
        );
        require(address(hook) == hookAddr, "Hook address mismatch");

        // --- 3. Authorize hook as a bid relayer in the REAL AuctionEngine ---
        engine.setAuthorizedBidRelayer(address(hook), true);

        // --- 4. Deploy mock bond + partial KYC registry ---
        MockBondH       bond     = new MockBondH();
        PartialRegistryH registry = new PartialRegistryH();

        // KYC only Alice and Bob
        registry.register(ALICE);
        registry.register(BOB);
        registry.register(deployer);

        // --- 5. Wire registry into REAL ComplianceGate ---
        gate.registerRegistry(address(bond), address(registry));

        // --- 6. Seed tokens ---
        bond.transfer(BOB, 500 * 1e18);            // Bob is the seller
        usdc.transfer(ALICE, 50_000 * 1e6);         // Alice buys with real USDC

        // --- 7. Fund HBAR for gas ---
        (bool a,) = payable(ALICE).call{value: 5 ether}("");
        (bool b,) = payable(BOB).call{value: 5 ether}("");
        require(a && b, "HBAR transfer failed");

        // --- 8. Open round on REAL AuctionEngine ---
        uint256 roundId = engine.openRound(address(bond), REAL_USDC, BID_WINDOW);

        // --- 9. Register active round in the Hook ---
        hook.setActiveRound(address(bond), roundId);

        vm.stopBroadcast();

        // ---- Summary ----
        console.log("");
        console.log("==============================================");
        console.log(" CLEARING BELL - HOOK TESTNET SETUP");
        console.log("==============================================");
        console.log("");
        console.log("--- REAL production contracts ---");
        console.log("ComplianceGate :", REAL_GATE);
        console.log("AuctionEngine  :", REAL_ENGINE);
        console.log("USDC           :", REAL_USDC);
        console.log("");
        console.log("--- Newly deployed (minimal) ---");
        console.log("TestnetPoolManager:", address(pm));
        console.log("ClearingBellHook  :", address(hook));
        console.log("MockBond          :", address(bond));
        console.log("PartialRegistry   :", address(registry));
        console.log("");
        console.log("--- Round ---");
        console.log("ROUND_ID          :", roundId);
        console.log("");
        console.log("--- Export before testing ---");
        console.log("  export PM=", address(pm));
        console.log("  export HOOK=", address(hook));
        console.log("  export ENGINE=", REAL_ENGINE);
        console.log("  export BOND=", address(bond));
        console.log("  export USDC=", REAL_USDC);
        console.log("  export ROUND_ID=", roundId);
        console.log("==============================================");
    }
}
