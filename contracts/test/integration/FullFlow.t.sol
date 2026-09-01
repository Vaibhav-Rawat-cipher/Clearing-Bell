// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {HookMiner} from "v4-periphery/utils/HookMiner.sol";

import {AuctionEngine} from "src/auction/AuctionEngine.sol";
import {ComplianceGate} from "src/auction/ComplianceGate.sol";
import {ClearingLib} from "src/auction/ClearingLib.sol";
import {ClearingBellHook} from "src/hooks/ClearingBellHook.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockIdentityRegistry} from "../mocks/MockIdentityRegistry.sol";
import {MockPoolManager} from "../mocks/MockPoolManager.sol";

/// @title FullFlow Integration Test
/// @notice End-to-end scenario covering the complete Clearing Bell protocol:
///
///   Stack deployed here → PLAN.md §10 Deployment Plan order:
///   1. ComplianceGate (wired to MockIdentityRegistry)
///   2. AuctionEngine
///   3. ClearingBellHook (CREATE2 mined)
///
///   Scenarios:
///   A. Happy path: hook → bid queue → close → clear → settle (DvP balances verified)
///   B. KYC rejection at hook level
///   C. KYC revoked mid-round → excluded from settlement, eligible counterparty still settles
///   D. Multi-round: second round opens and clears correctly after first is closed
///   E. No-crossing round via hook (round closes with RoundClosedWithNoCrossing event)
///   F. Issuer emergency pause blocks the full flow
///
/// PLAN.md §8 integration test requirement:
///   "Open round → 3 bidders bid → close → clear → settle → verify balances"
contract FullFlowTest is Test {
    // =========================================================================
    // Stack
    // =========================================================================

    MockPoolManager internal poolManager;
    ComplianceGate internal gate;
    MockIdentityRegistry internal registry;
    AuctionEngine internal engine;
    ClearingBellHook internal hook;

    MockERC20 internal bond;
    MockERC20 internal usdc;

    // =========================================================================
    // Actors
    // =========================================================================

    address internal constant ISSUER = address(0x155E);
    address internal constant ALICE = address(0xA11CE);   // buyer
    address internal constant BOB = address(0xB0B);       // buyer
    address internal constant CAROL = address(0xCA401);   // seller
    address internal constant MALLORY = address(0xBAD);   // not KYC'd

    uint256 internal constant USD = 1e6;   // USDC (6 dec)
    uint256 internal constant TOK = 1e18; // bond  (18 dec)

    uint256 internal activeRoundId;

    // =========================================================================
    // Setup — deploy entire stack per PLAN.md §10
    // =========================================================================

    function setUp() public {
        // 1. Tokens
        bond = new MockERC20("ClearingBell Bond", "CBB", 18);
        usdc = new MockERC20("USD Coin", "USDC", 6);

        // 2. ComplianceGate wired to identity registry
        registry = new MockIdentityRegistry();
        gate = new ComplianceGate();
        gate.registerRegistry(address(bond), address(registry));

        // 3. MockPoolManager (access-control surface for BaseHook)
        poolManager = new MockPoolManager();

        // 4. AuctionEngine
        engine = new AuctionEngine(address(gate), ISSUER);

        // 5. KYC: Alice, Bob, Carol — NOT Mallory
        registry.grant(ISSUER);
        registry.grant(ALICE);
        registry.grant(BOB);
        registry.grant(CAROL);

        // 6. Fund bidders
        usdc.mint(ALICE, 10_000_000 * USD);
        usdc.mint(BOB,   10_000_000 * USD);
        bond.mint(CAROL, 10_000_000 * TOK);
        bond.mint(BOB,   10_000_000 * TOK);  // BOB can be a seller too

        // 7. Deploy hook via CREATE2 (permission-encoded address)
        _deployHook();

        // 8. Issuer authorizes hook as bid relayer
        vm.prank(ISSUER);
        engine.setAuthorizedBidRelayer(address(hook), true);

        // 9. Open initial round and register it
        vm.prank(ISSUER);
        activeRoundId = engine.openRound(address(bond), address(usdc), 1 hours);
        vm.prank(ISSUER);
        hook.setActiveRound(address(bond), activeRoundId);

        // 10. Bidders approve the engine for settlement pulls
        vm.prank(ALICE);
        usdc.approve(address(engine), type(uint256).max);
        vm.prank(BOB);
        usdc.approve(address(engine), type(uint256).max);
        vm.prank(BOB);
        bond.approve(address(engine), type(uint256).max);
        vm.prank(CAROL);
        bond.approve(address(engine), type(uint256).max);
    }

    // =========================================================================
    // Scenario A: Full E2E — hook → queue → clear → DvP settle
    // Mirrors the PLAN.md §8 integration test scenario exactly.
    // =========================================================================

    function test_A_FullFlow_HookToBidToSettlement() public {
        // Snapshot balances before
        uint256 aliceUsdcBefore = usdc.balanceOf(ALICE);
        uint256 carolBondBefore = bond.balanceOf(CAROL);

        // --- Alice buys 100 bond @ 105 via hook ---
        vm.prank(address(poolManager));
        hook.beforeSwap(
            ALICE,
            _poolKey(),
            _swapParams(false, int256(100 * TOK)), // zeroForOne=false → buy
            abi.encode(105 * USD)                   // limit price
        );

        // --- Bob buys 50 bond @ 102 via hook ---
        vm.prank(address(poolManager));
        hook.beforeSwap(
            BOB,
            _poolKey(),
            _swapParams(false, int256(50 * TOK)),
            abi.encode(102 * USD)
        );

        // --- Carol sells 80 bond @ 100 via hook ---
        vm.prank(address(poolManager));
        hook.beforeSwap(
            CAROL,
            _poolKey(),
            _swapParams(true, -int256(80 * TOK)), // zeroForOne=true → sell, exact-in
            abi.encode(100 * USD)
        );

        // --- Verify 3 bids queued, no tokens moved yet ---
        assertEq(engine.getRoundBids(activeRoundId).length, 3, "3 bids queued");
        assertEq(usdc.balanceOf(ALICE), aliceUsdcBefore, "no USDC pulled (order queued)");
        assertEq(bond.balanceOf(CAROL), carolBondBefore, "no bond pulled (order queued)");

        // --- Advance past deadline, close and clear ---
        vm.warp(block.timestamp + 1 hours + 1);
        engine.closeAndClear(activeRoundId);

        // --- Verify clearing result ---
        AuctionEngine.AuctionRound memory round = _getRound(activeRoundId);
        // Clearing price = 100 (sell limit is the marginal price)
        // Cleared qty = 80 (min of total buy 150, sell 80)
        // Alice (highest buy at 105) fills 80; Bob's bid not filled (supply exhausted)
        assertEq(round.clearingPrice, 100 * USD, "clearing price = 100 USDC");
        assertEq(round.clearedQuantity, 80 * TOK, "cleared quantity = 80 tokens");
        assertEq(uint256(round.phase), uint256(AuctionEngine.Phase.Closed));

        // --- Verify DvP balances ---
        uint256 payment = (80 * TOK * 100 * USD) / 1e18; // 80 tokens × 100 USDC = 8000 USDC

        // Alice: paid 8000 USDC, received 80 bond
        assertEq(usdc.balanceOf(ALICE), aliceUsdcBefore - payment, "Alice pays 8000 USDC");
        assertEq(bond.balanceOf(ALICE), 80 * TOK, "Alice receives 80 bond tokens");

        // Bob: not filled (supply exhausted by Alice)
        assertEq(usdc.balanceOf(BOB), 10_000_000 * USD, "Bob not charged");
        assertEq(bond.balanceOf(BOB), 10_000_000 * TOK, "Bob receives no bond (seller side)");

        // Carol: delivered 80 bond, received 8000 USDC
        assertEq(bond.balanceOf(CAROL), carolBondBefore - 80 * TOK, "Carol delivers 80 bond");
        assertEq(usdc.balanceOf(CAROL), payment, "Carol receives 8000 USDC");

        // Engine contract holds no residual balance
        assertEq(usdc.balanceOf(address(engine)), 0, "engine holds no residual USDC");
        assertEq(bond.balanceOf(address(engine)), 0, "engine holds no residual bond");
    }

    // =========================================================================
    // Scenario A2: After settlement, afterEpochClose syncs clearing price
    // =========================================================================

    function test_A2_AfterEpochClose_SyncsPrice() public {
        _submitBidsThenClose();

        vm.prank(ISSUER);
        hook.afterEpochClose(activeRoundId, address(bond));

        assertEq(hook.lastClearingPrice(address(bond)), 100 * USD, "clearing price synced to hook");
    }

    // =========================================================================
    // Scenario B: KYC rejection at the hook level
    // =========================================================================

    function test_B_KycRejection_AtHookLevel() public {
        vm.prank(address(poolManager));
        vm.expectRevert(
            abi.encodeWithSelector(ClearingBellHook.BidderNotEligible.selector, MALLORY)
        );
        hook.beforeSwap(
            MALLORY,
            _poolKey(),
            _swapParams(false, int256(10 * TOK)),
            abi.encode(105 * USD)
        );

        // No bids queued
        assertEq(engine.getRoundBids(activeRoundId).length, 0);
    }

    // =========================================================================
    // Scenario C: KYC revoked mid-round → excluded at settlement
    //             Eligible counterparty still settles balanced (PLAN §9)
    // =========================================================================

    function test_C_RevokedMidRound_ExcludedAtSettlement() public {
        uint256 bobUsdcBefore = usdc.balanceOf(BOB);
        uint256 carolBondBefore = bond.balanceOf(CAROL);

        // Alice and Bob both bid to buy 50 @ 105
        vm.prank(address(poolManager));
        hook.beforeSwap(ALICE, _poolKey(), _swapParams(false, int256(50 * TOK)), abi.encode(105 * USD));
        vm.prank(address(poolManager));
        hook.beforeSwap(BOB,   _poolKey(), _swapParams(false, int256(50 * TOK)), abi.encode(105 * USD));

        // Carol sells 50 @ 100
        vm.prank(address(poolManager));
        hook.beforeSwap(CAROL, _poolKey(), _swapParams(true, -int256(50 * TOK)), abi.encode(100 * USD));

        // Alice's KYC revoked after bid
        registry.revoke(ALICE);

        vm.warp(block.timestamp + 1 hours + 1);
        engine.closeAndClear(activeRoundId);

        // Clearing price = 100; eligible subset = {Bob, Carol}
        // Bob gets 50 bond, Carol gets 50 * 100 USDC = 5000 USDC
        uint256 payment = (50 * TOK * 100 * USD) / 1e18;
        assertEq(usdc.balanceOf(BOB),   bobUsdcBefore - payment, "Bob pays 5000 USDC");
        assertEq(bond.balanceOf(BOB),   10_000_000 * TOK + 50 * TOK, "Bob receives 50 bond");
        assertEq(bond.balanceOf(CAROL), carolBondBefore - 50 * TOK, "Carol delivers 50 bond");
        assertEq(usdc.balanceOf(CAROL), payment, "Carol receives 5000 USDC");

        // Alice untouched
        assertEq(bond.balanceOf(ALICE), 0, "Alice receives nothing (revoked)");
        assertEq(usdc.balanceOf(ALICE), 10_000_000 * USD, "Alice not charged (revoked)");

        // Engine clean
        assertEq(usdc.balanceOf(address(engine)), 0);
        assertEq(bond.balanceOf(address(engine)), 0);
    }

    // =========================================================================
    // Scenario D: Multi-round — second round opens cleanly after first closes
    // =========================================================================

    function test_D_MultiRound_SecondRoundClearsIndependently() public {
        // --- Round 1: Alice buys 50 @ 100, Carol sells 50 @ 100 ---
        vm.prank(address(poolManager));
        hook.beforeSwap(ALICE, _poolKey(), _swapParams(false, int256(50 * TOK)), abi.encode(100 * USD));
        vm.prank(address(poolManager));
        hook.beforeSwap(CAROL, _poolKey(), _swapParams(true, -int256(50 * TOK)), abi.encode(100 * USD));

        vm.warp(block.timestamp + 1 hours + 1);
        engine.closeAndClear(activeRoundId);

        AuctionEngine.AuctionRound memory r1 = _getRound(activeRoundId);
        assertEq(r1.clearingPrice, 100 * USD, "Round 1: correct clearing price");
        assertEq(r1.clearedQuantity, 50 * TOK, "Round 1: full fill");

        // --- Open Round 2 ---
        vm.prank(ISSUER);
        uint256 round2Id = engine.openRound(address(bond), address(usdc), 1 hours);
        vm.prank(ISSUER);
        hook.setActiveRound(address(bond), round2Id);

        uint256 aliceUsdcMid = usdc.balanceOf(ALICE);
        uint256 carolBondMid = bond.balanceOf(CAROL);

        // --- Round 2: Bob buys 30 @ 110, Carol sells 30 @ 105 ---
        vm.prank(address(poolManager));
        hook.beforeSwap(BOB,   _poolKey(), _swapParams(false, int256(30 * TOK)), abi.encode(110 * USD));
        vm.prank(address(poolManager));
        hook.beforeSwap(CAROL, _poolKey(), _swapParams(true, -int256(30 * TOK)), abi.encode(105 * USD));

        vm.warp(block.timestamp + 1 hours + 1);
        engine.closeAndClear(round2Id);

        AuctionEngine.AuctionRound memory r2 = _getRound(round2Id);
        assertEq(r2.clearingPrice, 105 * USD, "Round 2: different clearing price");
        assertEq(r2.clearedQuantity, 30 * TOK, "Round 2: full fill");

        // R1 bids do NOT bleed into R2
        assertEq(engine.getRoundBids(round2Id).length, 2, "Round 2 has only its own 2 bids");

        // Alice balances unchanged by round 2
        assertEq(usdc.balanceOf(ALICE), aliceUsdcMid, "Alice uninvolved in round 2");
    }

    // =========================================================================
    // Scenario E: No-crossing round via hook
    // =========================================================================

    function test_E_NoCrossing_RoundClosesClean() public {
        // Alice bids 90, Carol asks 100 — no crossing
        vm.prank(address(poolManager));
        hook.beforeSwap(ALICE, _poolKey(), _swapParams(false, int256(50 * TOK)), abi.encode(90 * USD));
        vm.prank(address(poolManager));
        hook.beforeSwap(CAROL, _poolKey(), _swapParams(true, -int256(50 * TOK)), abi.encode(100 * USD));

        vm.warp(block.timestamp + 1 hours + 1);

        vm.expectEmit(true, true, true, true, address(engine));
        emit AuctionEngine.RoundClosedWithNoCrossing(activeRoundId);
        engine.closeAndClear(activeRoundId);

        AuctionEngine.AuctionRound memory round = _getRound(activeRoundId);
        assertEq(round.clearingPrice, 0, "no clearing price");
        assertEq(round.clearedQuantity, 0, "no cleared qty");

        // No tokens moved
        assertEq(usdc.balanceOf(ALICE), 10_000_000 * USD);
        assertEq(bond.balanceOf(CAROL), 10_000_000 * TOK);
        assertEq(usdc.balanceOf(address(engine)), 0);
        assertEq(bond.balanceOf(address(engine)), 0);
    }

    // =========================================================================
    // Scenario F: Emergency pause blocks the full flow (PLAN §9)
    // =========================================================================

    function test_F_EmergencyPause_BlocksEntireFlow() public {
        // Warp past deadline FIRST, then pause
        vm.warp(block.timestamp + 1 hours + 1);

        vm.prank(ISSUER);
        engine.pause();

        // closeAndClear should revert with EnforcedPause
        vm.expectRevert();
        engine.closeAndClear(activeRoundId);

        // Issuer can unpause and close the empty round (no bids → NoCrossing)
        vm.prank(ISSUER);
        engine.unpause();
        engine.closeAndClear(activeRoundId);

        // Open a fresh round and verify bids are accepted again after unpause
        vm.prank(ISSUER);
        uint256 round2 = engine.openRound(address(bond), address(usdc), 1 hours);
        vm.prank(ISSUER);
        hook.setActiveRound(address(bond), round2);

        // Pause again, verify new round bids blocked
        vm.prank(ISSUER);
        engine.pause();

        vm.prank(address(poolManager));
        vm.expectRevert(); // Pausable: EnforcedPause
        hook.beforeSwap(ALICE, _poolKey(), _swapParams(false, int256(10 * TOK)), abi.encode(100 * USD));

        // Unpause and verify bids accepted
        vm.prank(ISSUER);
        engine.unpause();

        vm.prank(address(poolManager));
        hook.beforeSwap(ALICE, _poolKey(), _swapParams(false, int256(50 * TOK)), abi.encode(100 * USD));
        assertEq(engine.getRoundBids(round2).length, 1, "bid accepted after unpause");
    }

    // =========================================================================
    // Scenario G: Direct AuctionEngine.submitBid (non-hook path) works too
    // =========================================================================

    function test_G_DirectSubmit_BypassesHook() public {
        uint256 aliceUsdcBefore = usdc.balanceOf(ALICE);
        uint256 carolBondBefore = bond.balanceOf(CAROL);

        // Direct bid submission — no hook involved
        vm.prank(ALICE);
        engine.submitBid(activeRoundId, 100 * USD, 100 * TOK, true);
        vm.prank(CAROL);
        engine.submitBid(activeRoundId, 100 * USD, 100 * TOK, false);

        vm.warp(block.timestamp + 1 hours + 1);
        engine.closeAndClear(activeRoundId);

        uint256 payment = (100 * TOK * 100 * USD) / 1e18;
        assertEq(usdc.balanceOf(ALICE), aliceUsdcBefore - payment);
        assertEq(bond.balanceOf(ALICE), 100 * TOK);
        assertEq(bond.balanceOf(CAROL), carolBondBefore - 100 * TOK);
        assertEq(usdc.balanceOf(CAROL), payment);
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    function _deployHook() internal {
        bytes memory constructorArgs = abi.encode(address(poolManager), address(engine));
        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);
        (address hookAddr, bytes32 salt) = HookMiner.find(
            address(this), flags, type(ClearingBellHook).creationCode, constructorArgs
        );
        hook = new ClearingBellHook{salt: salt}(IPoolManager(address(poolManager)), engine);
        assertEq(address(hook), hookAddr, "hook at correct CREATE2 address");
    }

    function _poolKey() internal view returns (PoolKey memory key) {
        key = PoolKey({
            currency0: Currency.wrap(address(bond)),
            currency1: Currency.wrap(address(usdc)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
    }

    function _swapParams(bool zeroForOne, int256 amount) internal pure returns (SwapParams memory) {
        return SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: amount,
            sqrtPriceLimitX96: type(uint160).max
        });
    }

    function _getRound(uint256 id) internal view returns (AuctionEngine.AuctionRound memory round) {
        (
            round.id,
            round.bondToken,
            round.settlementToken,
            round.openDeadline,
            round.phase,
            round.clearingPrice,
            round.clearedQuantity,
            round.bidCount
        ) = engine.rounds(id);
    }

    function _submitBidsThenClose() internal {
        vm.prank(address(poolManager));
        hook.beforeSwap(ALICE, _poolKey(), _swapParams(false, int256(100 * TOK)), abi.encode(105 * USD));
        vm.prank(address(poolManager));
        hook.beforeSwap(CAROL, _poolKey(), _swapParams(true, -int256(80 * TOK)), abi.encode(100 * USD));
        vm.warp(block.timestamp + 1 hours + 1);
        engine.closeAndClear(activeRoundId);
    }
}
