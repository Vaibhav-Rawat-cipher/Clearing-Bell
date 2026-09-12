// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {ERC20} from "solmate/tokens/ERC20.sol";
import {ComplianceGate} from "src/auction/ComplianceGate.sol";
import {AuctionEngine} from "src/auction/AuctionEngine.sol";

// ============================================================
// Minimal mocks — ONLY what cannot be avoided on testnet
// ============================================================

/// @dev Mock bond token (plain ERC-20, 18 dec).
///      The real Hedera ATS bond (CBB28) requires HTS-native KYC to mint,
///      which cannot be done via Foundry/cast. Everything else is real.
contract MockBond is ERC20 {
    address public immutable minter;

    constructor() ERC20("Clearing Bell Bond 2028 [MOCK]", "mCBB28", 18) {
        minter = msg.sender;
        _mint(msg.sender, 1_000_000 * 1e18);
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "not minter");
        _mint(to, amount);
    }
}

/// @dev Open identity registry — returns isVerified=true for registered addresses.
///      Only Alice and Bob are registered here, bypassing HTS KYC for them alone.
///      All other compliance logic (bid submission guards, re-check at settlement,
///      eligible-bid filtering) runs through the REAL ComplianceGate + AuctionEngine.
contract OpenIdentityRegistry {
    mapping(address => bool) public isVerified;
    mapping(address => uint256) public registrationDateOf;

    function registerMany(address[] calldata users) external {
        for (uint256 i = 0; i < users.length; i++) {
            isVerified[users[i]] = true;
            registrationDateOf[users[i]] = block.timestamp;
        }
    }
}

// ============================================================
// Setup Script
// ============================================================

/// @title TestnetAuctionSetup
/// @notice Wires a minimal mock bond + open identity registry into the
///         REAL deployed ComplianceGate and AuctionEngine so that Alice
///         and Bob can bid without Hedera HTS KYC, while every compliance
///         check, bid guard, clearing algorithm, and DvP settlement runs
///         through the live production contracts.
///
/// What is mocked (minimal):
///   - MockBond              : plain ERC-20 stand-in for the real ATS bond
///   - OpenIdentityRegistry  : returns isVerified=true for Alice + Bob only
///
/// What is REAL (production):
///   - ComplianceGate        : 0x59ace2042088dc40790a456f6af24febdbb4dfc7
///   - AuctionEngine         : 0x663d1825f7a1eb323eb531152e23720c7f2ad7a2
///   - USDC                  : 0x37a4ae6511f491c5a07fbf61f6cf8b292727d255
///
/// Usage:
///   cd contracts
///   forge script script/TestnetAuction.s.sol:TestnetAuctionSetup \
///     --rpc-url $HEDERA_RPC_URL \
///     --private-key $DEPLOYER_PRIVATE_KEY \
///     --broadcast --slow -vvv
contract TestnetAuctionSetup is Script {
    // ---- Live production contracts on Hedera testnet ----
    address constant REAL_GATE   = 0x59acE2042088Dc40790a456f6af24feBdbB4Dfc7;
    address constant REAL_ENGINE = 0x663d1825f7a1eb323EB531152e23720C7f2AD7a2;
    address constant REAL_USDC   = 0x37A4ae6511f491C5a07fbf61F6cF8b292727D255;

    // ---- Test wallets (Foundry well-known accounts) ----
    address constant ALICE = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266; // buyer
    address constant BOB   = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8; // seller

    // ---- Bid window: 10 minutes ----
    uint256 constant BID_WINDOW = 600;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        ComplianceGate gate   = ComplianceGate(REAL_GATE);
        AuctionEngine  engine = AuctionEngine(REAL_ENGINE);
        ERC20          usdc   = ERC20(REAL_USDC);

        vm.startBroadcast(deployerKey);

        // --- 1. Deploy ONLY the mock bond and open registry ---
        MockBond             bond     = new MockBond();
        OpenIdentityRegistry registry = new OpenIdentityRegistry();

        // --- 2. KYC only Alice, Bob, and deployer in the mock registry ---
        //        (no one else is verified — all other compliance gates are real)
        address[] memory users = new address[](3);
        users[0] = ALICE;
        users[1] = BOB;
        users[2] = deployer;
        registry.registerMany(users);

        // --- 3. Register mock registry in the REAL ComplianceGate ---
        //        (deployer is ComplianceGate owner — confirmed on-chain)
        gate.registerRegistry(address(bond), address(registry));

        // --- 4. Seed mock bond to Bob (seller) ---
        bond.transfer(BOB, 500 * 1e18); // 500 mCBB28

        // --- 5. Seed REAL USDC to Alice (buyer) from deployer ---
        usdc.transfer(ALICE, 50_000 * 1e6); // 50,000 real USDC

        // --- 6. Open a new round on the REAL AuctionEngine ---
        //        Uses mock bond + real USDC. Issuer = deployer (confirmed on-chain).
        uint256 roundId = engine.openRound(address(bond), REAL_USDC, BID_WINDOW);

        vm.stopBroadcast();

        // ---- Summary ----
        console.log("");
        console.log("==============================================");
        console.log(" CLEARING BELL - HYBRID TESTNET SETUP");
        console.log("==============================================");
        console.log("");
        console.log("--- REAL (production) contracts ---");
        console.log("ComplianceGate  :", REAL_GATE);
        console.log("AuctionEngine   :", REAL_ENGINE);
        console.log("USDC            :", REAL_USDC);
        console.log("");
        console.log("--- MOCKED (minimal, KYC bypass only) ---");
        console.log("MockBond        :", address(bond));
        console.log("OpenRegistry    :", address(registry));
        console.log("");
        console.log("--- Round opened on REAL AuctionEngine ---");
        console.log("ACTIVE_ROUND_ID :", roundId);
        console.log("");
        console.log("Alice (BUYER)   :", ALICE);
        console.log("  real USDC     : 50000 (50000000000 raw)");
        console.log("  mCBB28        : 0 (expects to receive after clearing)");
        console.log("");
        console.log("Bob (SELLER)    :", BOB);
        console.log("  mCBB28        : 500 (500000000000000000000 raw)");
        console.log("  real USDC     : 0 (expects to receive after clearing)");
        console.log("");
        console.log("Bid window open for 600 seconds from now.");
        console.log("==============================================");
        console.log("");
        console.log("Export before bidding:");
        console.log("  export ENGINE=", REAL_ENGINE);
        console.log("  export BOND=", address(bond));
        console.log("  export USDC=", REAL_USDC);
        console.log("  export ROUND_ID=", roundId);
    }
}
