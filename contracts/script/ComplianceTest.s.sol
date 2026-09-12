// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {ERC20} from "solmate/tokens/ERC20.sol";
import {ComplianceGate} from "src/auction/ComplianceGate.sol";
import {AuctionEngine} from "src/auction/AuctionEngine.sol";

// ============================================================
// Minimal mocks
// ============================================================

contract MockBondC is ERC20 {
    address public immutable minter;

    constructor() ERC20("Clearing Bell Bond 2028 [MOCK-C]", "mCBB28-C", 18) {
        minter = msg.sender;
        _mint(msg.sender, 1_000_000 * 1e18);
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "not minter");
        _mint(to, amount);
    }
}

/// @dev Registry where ONLY Alice and Bob are verified.
///      Charlie is intentionally excluded to test ComplianceGate rejection.
contract PartialRegistry {
    mapping(address => bool) public isVerified;
    mapping(address => uint256) public registrationDateOf;

    function register(address user) external {
        isVerified[user] = true;
        registrationDateOf[user] = block.timestamp;
    }
}

// ============================================================
// Compliance Test Setup Script
// ============================================================

/// @title ComplianceTestSetup
/// @notice Sets up a 3-user compliance test on the REAL AuctionEngine:
///
///   Alice  (buyer)  -- KYC'd in PartialRegistry  -> bid SUCCEEDS
///   Bob    (seller) -- KYC'd in PartialRegistry  -> bid SUCCEEDS
///   Charlie (buyer) -- NOT in registry           -> bid REVERTS (BidderNotEligible)
///
/// Real production contracts used:
///   ComplianceGate  : 0x59acE2042088Dc40790a456f6af24feBdbB4Dfc7
///   AuctionEngine   : 0x663d1825f7a1eb323EB531152e23720C7f2AD7a2
///   USDC            : 0x37A4ae6511f491C5a07fbf61F6cF8b292727D255
///
/// Usage:
///   cd contracts
///   forge script script/ComplianceTest.s.sol:ComplianceTestSetup \
///     --rpc-url $HEDERA_RPC_URL \
///     --private-key $DEPLOYER_PRIVATE_KEY \
///     --broadcast --slow -vvv
contract ComplianceTestSetup is Script {
    // ---- Real production contracts ----
    address constant REAL_GATE   = 0x59acE2042088Dc40790a456f6af24feBdbB4Dfc7;
    address constant REAL_ENGINE = 0x663d1825f7a1eb323EB531152e23720C7f2AD7a2;
    address constant REAL_USDC   = 0x37A4ae6511f491C5a07fbf61F6cF8b292727D255;

    // ---- Three test wallets (Foundry well-known accounts #0, #1, #2) ----
    address constant ALICE   = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266; // buyer   -- KYC'd
    address constant BOB     = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8; // seller  -- KYC'd
    address constant CHARLIE = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC; // buyer   -- NOT KYC'd

    uint256 constant BID_WINDOW = 600; // 10 minutes

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        ComplianceGate gate   = ComplianceGate(REAL_GATE);
        AuctionEngine  engine = AuctionEngine(REAL_ENGINE);
        ERC20          usdc   = ERC20(REAL_USDC);

        vm.startBroadcast(deployerKey);

        // --- 1. Deploy fresh mock bond and PARTIAL registry ---
        MockBondC        bond     = new MockBondC();
        PartialRegistry  registry = new PartialRegistry();

        // --- 2. Register ONLY Alice and Bob -- Charlie is deliberately excluded ---
        registry.register(ALICE);
        registry.register(BOB);
        // Charlie NOT registered -- complianceGate.isEligible(charlie, bond) will return false

        // --- 3. Wire PARTIAL registry into the REAL ComplianceGate ---
        gate.registerRegistry(address(bond), address(registry));

        // --- 4. Seed tokens ---
        // Bob (seller): 500 mock bonds
        bond.transfer(BOB, 500 * 1e18);

        // Alice (buyer): 50,000 real USDC -- she will succeed
        usdc.transfer(ALICE, 50_000 * 1e6);

        // Charlie (buyer): 25,000 real USDC -- he has funds but NO KYC
        // This proves the revert is about KYC, not insufficient balance
        usdc.transfer(CHARLIE, 25_000 * 1e6);

        // --- 5. Fund all three with HBAR for gas ---
        (bool a,) = payable(ALICE).call{value: 5 ether}("");
        (bool b,) = payable(BOB).call{value: 5 ether}("");
        (bool c,) = payable(CHARLIE).call{value: 5 ether}("");
        require(a && b && c, "HBAR transfer failed");

        // --- 6. Open a round on the REAL AuctionEngine ---
        uint256 roundId = engine.openRound(address(bond), REAL_USDC, BID_WINDOW);

        vm.stopBroadcast();

        // ---- Summary ----
        console.log("");
        console.log("==============================================");
        console.log(" COMPLIANCE GATE TEST -- 3-USER SCENARIO");
        console.log("==============================================");
        console.log("");
        console.log("--- REAL (production) contracts ---");
        console.log("ComplianceGate  :", REAL_GATE);
        console.log("AuctionEngine   :", REAL_ENGINE);
        console.log("USDC            :", REAL_USDC);
        console.log("");
        console.log("--- MOCKED (KYC bypass for Alice+Bob only) ---");
        console.log("MockBond        :", address(bond));
        console.log("PartialRegistry :", address(registry));
        console.log("");
        console.log("--- Round opened ---");
        console.log("ROUND_ID        :", roundId);
        console.log("");
        console.log("--- User setup ---");
        console.log("Alice   (BUYER  / KYC'd)     :", ALICE);
        console.log("  real USDC : 50,000  | KYC: YES -> bid will SUCCEED");
        console.log("Bob     (SELLER / KYC'd)     :", BOB);
        console.log("  mCBB28   : 500      | KYC: YES -> bid will SUCCEED");
        console.log("Charlie (BUYER  / NOT KYC'd) :", CHARLIE);
        console.log("  real USDC : 25,000  | KYC: NO  -> bid will REVERT");
        console.log("");
        console.log("Export before testing:");
        console.log("  export ENGINE=", REAL_ENGINE);
        console.log("  export BOND=", address(bond));
        console.log("  export USDC=", REAL_USDC);
        console.log("  export ROUND_ID=", roundId);
        console.log("==============================================");
    }
}
