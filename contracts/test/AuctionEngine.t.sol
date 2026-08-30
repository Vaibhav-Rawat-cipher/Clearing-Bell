// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AuctionEngine} from "src/auction/AuctionEngine.sol";
import {ComplianceGate} from "src/auction/ComplianceGate.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";

/// @title AuctionEngine Integration & Security Tests
/// @notice Phase 2 gate per PLAN.md §8:
///         "Open round → 3 bidders bid → close → clear → settle → verify balances."
///         Plus the §9 security checklist: access control (onlyIssuer), pause,
///         compliance re-check at settlement (revoked-mid-round), no-crossing,
///         bid-window deadline, and invalid-input guardrails.
contract AuctionEngineTest is Test {
    AuctionEngine internal engine;
    ComplianceGate internal gate;
    MockIdentityRegistry internal registry;
    MockERC20 internal bond;
    MockERC20 internal usdc;

    address internal constant ISSUER = address(0x155E);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant CAROL = address(0xCA401);

    uint256 internal constant USD = 1e6; // USDC scaled 6 decimals
    uint256 internal constant TOK = 1e18; // bond scaled 18 decimals

    function setUp() public {
        bond = new MockERC20("Bond", "BND", 18);
        usdc = new MockERC20("USDC", "USDC", 6);

        registry = new MockIdentityRegistry();
        gate = new ComplianceGate();
        // The test contract is the deploying owner of ComplianceGate.
        gate.registerRegistry(address(bond), address(registry));

        engine = new AuctionEngine(address(gate), ISSUER);

        // KYC everyone
        registry.grant(ISSUER);
        registry.grant(ALICE);
        registry.grant(BOB);
        registry.grant(CAROL);

        // Fund bidders: buyers get USDC, sellers get bond.
        usdc.mint(ALICE, 1_000_000 * USD);
        usdc.mint(BOB, 1_000_000 * USD);
        bond.mint(BOB, 1_000_000 * TOK);
        bond.mint(CAROL, 1_000_000 * TOK);

        // Approve the engine to move funds.
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
    // Helpers
    // =========================================================================

    function _openRound(uint256 window) internal returns (uint256 roundId) {
        vm.startPrank(ISSUER);
        roundId = engine.openRound(address(bond), address(usdc), window);
        vm.stopPrank();
    }

    function _jumpTo(uint256 timestamp) internal {
        vm.warp(timestamp);
    }

    function _getRound(uint256 id)
        internal
        view
        returns (AuctionEngine.AuctionRound memory round)
    {
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

    // =========================================================================
    // Happy path — full round, 3 bidders, verify balances (PLAN §8)
    // =========================================================================

    function test_FullRound_ThreeBidders_SettleAndVerifyBalances() public {
        uint256 window = 1 hours;
        uint256 roundId = _openRound(window);

        uint256 aliceUsdcBefore = usdc.balanceOf(ALICE);
        uint256 bobUsdcBefore = usdc.balanceOf(BOB);
        uint256 bobBondBefore = bond.balanceOf(BOB);
        uint256 carolBondBefore = bond.balanceOf(CAROL);

        // Scenario (mirrors ClearingLib tests):
        //   Alice  buys 100 @ 105
        //   Bob    buys  50 @ 102
        //   Carol sells  80 @ 100
        // Uniform clearing price is taken from the sell side: 100.
        // Buy fill is FIFO: Alice (highest buyer) fills 80; Bob fills 0.
        vm.prank(ALICE);
        engine.submitBid(roundId, 105 * USD, 100 * TOK, true);
        vm.prank(BOB);
        engine.submitBid(roundId, 102 * USD, 50 * TOK, true);
        vm.prank(CAROL);
        engine.submitBid(roundId, 100 * USD, 80 * TOK, false);

        // Verify phase still Open and bids recorded.
        assertEq(uint256(engine.getRoundPhase(roundId)), uint256(AuctionEngine.Phase.Open));
        assertEq(engine.getRoundBids(roundId).length, 3);

        // Move past deadline, then permissionlessly close.
        _jumpTo(block.timestamp + window + 1);
        engine.closeAndClear(roundId);

        // Clearing result assertions.
        AuctionEngine.AuctionRound memory round = _getRound(roundId);
        assertEq(round.clearingPrice, 100 * USD, "clearing price = 100");
        assertEq(round.clearedQuantity, 80 * TOK, "cleared quantity = 80");
        assertEq(uint256(round.phase), uint256(AuctionEngine.Phase.Closed));

        uint256 perToken = 100 * USD; // USDC per bond token
        // --- Verify balances ---
        // Alice buys 80 @100: pays 80*100, receives 80 bond.
        assertEq(usdc.balanceOf(ALICE), aliceUsdcBefore - (80 * TOK * perToken) / 1e18);
        assertEq(bond.balanceOf(ALICE), 80 * TOK, "Alice receives 80 bond");
        // Bob's bid is not filled (not enough sell supply).
        assertEq(usdc.balanceOf(BOB), bobUsdcBefore, "Bob not charged");
        assertEq(bond.balanceOf(BOB), bobBondBefore, "Bob receives no bond");
        // Carol sells 80 @100: delivers 80 bond, receives 80*100.
        assertEq(bond.balanceOf(CAROL), carolBondBefore - 80 * TOK, "Carol delivers 80 bond");
        assertEq(
            usdc.balanceOf(CAROL),
            (80 * TOK * perToken) / 1e18,
            "Carol receives cash for 80 tokens"
        );
    }

    // =========================================================================
    // Simple deterministic scenario (single price point)
    // =========================================================================

    function test_FullRound_SingleCross_VerifyBalances() public {
        uint256 roundId = _openRound(1 hours);

        uint256 aliceUsdcBefore = usdc.balanceOf(ALICE);
        uint256 carolBondBefore = bond.balanceOf(CAROL);

        // Alice buys 100 @ 100, Carol sells 100 @ 100. Full fill at 100.
        vm.prank(ALICE);
        engine.submitBid(roundId, 100 * USD, 100 * TOK, true);
        vm.prank(CAROL);
        engine.submitBid(roundId, 100 * USD, 100 * TOK, false);

        _jumpTo(block.timestamp + 1 hours + 1);
        engine.closeAndClear(roundId);

        AuctionEngine.AuctionRound memory round = _getRound(roundId);
        assertEq(round.clearingPrice, 100 * USD);
        assertEq(round.clearedQuantity, 100 * TOK);

        assertEq(usdc.balanceOf(ALICE), aliceUsdcBefore - 100 * TOK * 100 * USD / 1e18);
        assertEq(bond.balanceOf(ALICE), 100 * TOK);
        assertEq(bond.balanceOf(CAROL), carolBondBefore - 100 * TOK);
        assertEq(usdc.balanceOf(CAROL), 100 * TOK * 100 * USD / 1e18);
    }

    // =========================================================================
    // Bid-window & phase guardrails
    // =========================================================================

    function test_RevertWhen_BidAfterDeadline() public {
        uint256 window = 1 hours;
        uint256 roundId = _openRound(window);
        _jumpTo(block.timestamp + window + 1);

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(AuctionEngine.BidWindowClosed.selector, roundId));
        engine.submitBid(roundId, 100 * USD, 10 * TOK, true);
    }

    function test_RevertWhen_BidOnNonOpenRound() public {
        uint256 roundId = _openRound(1 hours);
        _jumpTo(block.timestamp + 1 hours + 1);
        engine.closeAndClear(roundId);

        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(AuctionEngine.RoundNotOpen.selector, roundId));
        engine.submitBid(roundId, 100 * USD, 10 * TOK, true);
    }

    function test_RevertWhen_ZeroPrice() public {
        uint256 roundId = _openRound(1 hours);
        vm.prank(ALICE);
        vm.expectRevert(AuctionEngine.InvalidBidPrice.selector);
        engine.submitBid(roundId, 0, 10 * TOK, true);
    }

    function test_RevertWhen_ZeroQuantity() public {
        uint256 roundId = _openRound(1 hours);
        vm.prank(ALICE);
        vm.expectRevert(AuctionEngine.InvalidBidQuantity.selector);
        engine.submitBid(roundId, 100 * USD, 0, true);
    }

    // =========================================================================
    // Compliance gating at bid submission (PLAN §4.2 / §9)
    // =========================================================================

    function test_RevertWhen_NotKycAtBid() public {
        uint256 roundId = _openRound(1 hours);
        // DAVE is not on the registry.
        address dave = address(0xDA7E);
        vm.prank(dave);
        vm.expectRevert(abi.encodeWithSelector(AuctionEngine.BidderNotEligible.selector, dave));
        engine.submitBid(roundId, 100 * USD, 10 * TOK, true);
    }

    // =========================================================================
    // Access control — onlyIssuer (PLAN §9)
    // =========================================================================

    function test_RevertWhen_NonIssuerOpensRound() public {
        vm.prank(ALICE);
        vm.expectRevert(AuctionEngine.NotIssuer.selector);
        engine.openRound(address(bond), address(usdc), 1 hours);
    }

    function test_RevertWhen_NonIssuerPauses() public {
        vm.prank(ALICE);
        vm.expectRevert(AuctionEngine.NotIssuer.selector);
        engine.pause();
    }

    // =========================================================================
    // Emergency pause (PLAN §9)
    // =========================================================================

    function test_Pause_BlocksBids() public {
        uint256 roundId = _openRound(1 hours);

        vm.prank(ISSUER);
        engine.pause();

        vm.prank(ALICE);
        vm.expectRevert(); // Pausable: EnforcedPause
        engine.submitBid(roundId, 100 * USD, 10 * TOK, true);

        vm.prank(ISSUER);
        engine.unpause();

        vm.prank(ALICE);
        engine.submitBid(roundId, 100 * USD, 10 * TOK, true);
    }

    function test_Pause_BlocksClose() public {
        uint256 roundId = _openRound(1 hours);
        _jumpTo(block.timestamp + 1 hours + 1);

        vm.prank(ISSUER);
        engine.pause();

        vm.expectRevert(); // Pausable: EnforcedPause
        engine.closeAndClear(roundId);
    }

    // =========================================================================
    // Compliance re-check at settlement: revoked mid-round (PLAN §8 / §9)
    // =========================================================================

    function test_RevokedMidRound_SkippedAtSettlement() public {
        uint256 roundId = _openRound(1 hours);
        uint256 aliceUsdcBefore = usdc.balanceOf(ALICE);

        vm.prank(ALICE);
        engine.submitBid(roundId, 100 * USD, 50 * TOK, true); // Alice buys 50 @100
        vm.prank(CAROL);
        engine.submitBid(roundId, 100 * USD, 50 * TOK, false); // Carol sells 50 @100

        // Revoke Alice's KYC after she bid.
        registry.revoke(ALICE);

        _jumpTo(block.timestamp + 1 hours + 1);
        engine.closeAndClear(roundId);

        // Alice's buy is skipped; Carol's sell has no counterparty -> no transfers.
        assertEq(usdc.balanceOf(ALICE), aliceUsdcBefore, "Alice not charged (skipped)");
        assertEq(bond.balanceOf(ALICE), 0, "Alice receives nothing");
        // Carol keeps her bonds and receives no cash.
        assertEq(bond.balanceOf(CAROL), 1_000_000 * TOK);
        assertEq(usdc.balanceOf(CAROL), 0);
    }

    /// @dev A revoked bidder is excluded from the eligible set, but an eligible
    ///      buyer still settles in full against the seller (balanced DvP).
    function test_RevokedMidRound_EligibleBuyerStillSettlesBalanced() public {
        uint256 roundId = _openRound(1 hours);

        uint256 bobUsdcBefore = usdc.balanceOf(BOB);
        uint256 bobBondBefore = bond.balanceOf(BOB);
        uint256 carolBondBefore = bond.balanceOf(CAROL);

        vm.prank(ALICE);
        engine.submitBid(roundId, 105 * USD, 50 * TOK, true); // Alice buys 50 @105
        vm.prank(BOB);
        engine.submitBid(roundId, 105 * USD, 50 * TOK, true); // Bob buys 50 @105
        vm.prank(CAROL);
        engine.submitBid(roundId, 100 * USD, 50 * TOK, false); // Carol sells 50 @100

        // Revoke Alice's KYC after she bid.
        registry.revoke(ALICE);

        _jumpTo(block.timestamp + 1 hours + 1);
        engine.closeAndClear(roundId);

        // Clearing price = 100; only Bob (eligible) matches against Carol.
        AuctionEngine.AuctionRound memory round = _getRound(roundId);
        assertEq(round.clearingPrice, 100 * USD);
        assertEq(round.clearedQuantity, 50 * TOK);

        uint256 perToken = 100 * USD;
        // Bob collects the full 50-token fill.
        assertEq(usdc.balanceOf(BOB), bobUsdcBefore - (50 * TOK * perToken) / 1e18);
        assertEq(bond.balanceOf(BOB), bobBondBefore + 50 * TOK, "Bob receives 50 bond");
        assertEq(bond.balanceOf(CAROL), carolBondBefore - 50 * TOK, "Carol delivers 50 bond");
        assertEq(usdc.balanceOf(CAROL), (50 * TOK * perToken) / 1e18);
        // Alice (revoked) is untouched.
        assertEq(bond.balanceOf(ALICE), 0);
        assertEq(usdc.balanceOf(ALICE), 1_000_000 * USD);
    }

    // =========================================================================
    // No-crossing round (PLAN §4.3)
    // =========================================================================

    function test_NoCrossing_RoundClosesWithNoTrades() public {
        uint256 roundId = _openRound(1 hours);

        vm.prank(ALICE);
        engine.submitBid(roundId, 98 * USD, 100 * TOK, true); // buy @98
        vm.prank(CAROL);
        engine.submitBid(roundId, 100 * USD, 100 * TOK, false); // sell @100

        _jumpTo(block.timestamp + 1 hours + 1);
        vm.expectEmit(true, true, true, true, address(engine));
        emit AuctionEngine.RoundClosedWithNoCrossing(roundId);
        engine.closeAndClear(roundId);

        AuctionEngine.AuctionRound memory round = _getRound(roundId);
        assertEq(round.clearingPrice, 0, "no clearing price");
        assertEq(round.clearedQuantity, 0, "no cleared quantity");
        assertEq(uint256(round.phase), uint256(AuctionEngine.Phase.Closed));

        // No funds move.
        assertEq(usdc.balanceOf(ALICE), 1_000_000 * USD);
        assertEq(bond.balanceOf(CAROL), 1_000_000 * TOK);
    }

    // =========================================================================
    // Early close by issuer (PLAN §4.4: permissionless after deadline; issuer can force)
    // =========================================================================

    function test_RevertWhen_NonIssuerClosesEarly() public {
        uint256 roundId = _openRound(1 hours);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(AuctionEngine.RoundStillOpen.selector, roundId));
        engine.closeAndClear(roundId);
    }

    function test_IssuerCanCloseEarly() public {
        uint256 roundId = _openRound(1 hours);

        vm.prank(ALICE);
        engine.submitBid(roundId, 100 * USD, 50 * TOK, true);
        vm.prank(CAROL);
        engine.submitBid(roundId, 100 * USD, 50 * TOK, false);

        // Issuer closes before deadline.
        vm.prank(ISSUER);
        engine.closeAndClear(roundId);

        AuctionEngine.AuctionRound memory round = _getRound(roundId);
        assertEq(round.clearingPrice, 100 * USD);
        assertEq(round.clearedQuantity, 50 * TOK);
    }
}
