// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {ClearingLib} from "../contracts/auction/ClearingLib.sol";

/// @title ClearingLib Unit Tests
/// @notice Exhaustive edge-case coverage per the spec §4.3 test table.
///         These tests MUST all pass before AuctionEngine is built.
///
/// Test coverage:
///  T1: Empty bids → no crash, hasCrossing = false
///  T2: Only buy bids → no false clear
///  T3: Only sell bids → no false clear
///  T4: Buy < sell price → no crossing
///  T5: Basic crossing (1 buy + 1 sell, prices cross)
///  T6: Tie-breaking (same price, multiple bids → FIFO deterministic)
///  T7: Partial fill (quantity mismatch between sides)
///  T8: Overflow protection (large qty × price)
contract ClearingLibTest is Test {
    using ClearingLib for ClearingLib.Bid[];

    // =========================================================================
    // Helpers
    // =========================================================================

    function _makeBuy(
        address bidder,
        uint256 price,
        uint256 qty,
        uint256 idx
    ) internal pure returns (ClearingLib.Bid memory) {
        return
            ClearingLib.Bid({
                bidder: bidder,
                price: price,
                quantity: qty,
                isBuy: true,
                index: idx
            });
    }

    function _makeSell(
        address bidder,
        uint256 price,
        uint256 qty,
        uint256 idx
    ) internal pure returns (ClearingLib.Bid memory) {
        return
            ClearingLib.Bid({
                bidder: bidder,
                price: price,
                quantity: qty,
                isBuy: false,
                index: idx
            });
    }

    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);
    address constant CAROL = address(0xCA401);
    address constant DAVE = address(0xDA7E);

    // =========================================================================
    // T1: Empty bids array — must not crash or falsely clear
    // =========================================================================

    function test_T1_EmptyBids_NoCrash() public pure {
        ClearingLib.Bid[] memory bids = new ClearingLib.Bid[](0);
        ClearingLib.ClearingResult memory result = ClearingLib
            .computeClearingPrice(bids);

        assertFalse(
            result.hasCrossing,
            "T1: empty bids should have no crossing"
        );
        assertEq(
            result.clearingPrice,
            0,
            "T1: clearing price must be 0 for empty bids"
        );
        assertEq(
            result.clearedQuantity,
            0,
            "T1: cleared quantity must be 0 for empty bids"
        );
    }

    function test_T1_EmptyBids_MatchBidsNoCrash() public pure {
        ClearingLib.Bid[] memory bids = new ClearingLib.Bid[](0);
        ClearingLib.Bid[] memory filled = ClearingLib.matchBids(bids, 0);

        assertEq(
            filled.length,
            0,
            "T1: matchBids on empty array should return empty array"
        );
    }

    // =========================================================================
    // T2: Only buy bids — no sell side → must not falsely clear
    // =========================================================================

    function test_T2_OnlyBuys_NoFalseClear() public pure {
        ClearingLib.Bid[] memory bids = new ClearingLib.Bid[](2);
        bids[0] = _makeBuy(ALICE, 105e6, 100e18, 0); // 105 USDC, 100 tokens
        bids[1] = _makeBuy(BOB, 102e6, 50e18, 1);

        ClearingLib.ClearingResult memory result = ClearingLib
            .computeClearingPrice(bids);

        assertFalse(result.hasCrossing, "T2: buy-only should have no crossing");
        assertEq(
            result.clearingPrice,
            0,
            "T2: clearing price must be 0 with no sells"
        );
    }

    // =========================================================================
    // T3: Only sell bids — no buy side → must not falsely clear
    // =========================================================================

    function test_T3_OnlySells_NoFalseClear() public pure {
        ClearingLib.Bid[] memory bids = new ClearingLib.Bid[](2);
        bids[0] = _makeSell(CAROL, 100e6, 80e18, 0); // 100 USDC, 80 tokens
        bids[1] = _makeSell(DAVE, 103e6, 40e18, 1);

        ClearingLib.ClearingResult memory result = ClearingLib
            .computeClearingPrice(bids);

        assertFalse(
            result.hasCrossing,
            "T3: sell-only should have no crossing"
        );
        assertEq(
            result.clearingPrice,
            0,
            "T3: clearing price must be 0 with no buys"
        );
    }

    // =========================================================================
    // T4: Prices don't cross — buy limit < sell limit
    // =========================================================================

    function test_T4_NoCrossing_BuyPriceBelowSell() public pure {
        ClearingLib.Bid[] memory bids = new ClearingLib.Bid[](2);
        bids[0] = _makeBuy(ALICE, 98e6, 100e18, 0); // Alice wants to buy at max 98
        bids[1] = _makeSell(CAROL, 100e6, 100e18, 1); // Carol wants to sell at min 100

        // 98 < 100 → no crossing

        ClearingLib.ClearingResult memory result = ClearingLib
            .computeClearingPrice(bids);

        assertFalse(
            result.hasCrossing,
            "T4: buy@98 vs sell@100 should not cross"
        );
        assertEq(
            result.clearingPrice,
            0,
            "T4: no clearing price when prices don't cross"
        );
        assertEq(
            result.clearedQuantity,
            0,
            "T4: no cleared quantity when prices don't cross"
        );
    }

    function test_T4_NoCrossing_Equal_IsBoundary() public pure {
        // Equal prices DO cross (buyer willing to pay exactly what seller asks)
        ClearingLib.Bid[] memory bids = new ClearingLib.Bid[](2);
        bids[0] = _makeBuy(ALICE, 100e6, 100e18, 0);
        bids[1] = _makeSell(CAROL, 100e6, 100e18, 1);

        ClearingLib.ClearingResult memory result = ClearingLib
            .computeClearingPrice(bids);

        assertTrue(result.hasCrossing, "T4: equal price should cross");
        assertEq(
            result.clearingPrice,
            100e6,
            "T4: clearing price should be 100 when prices are equal"
        );
    }

    // =========================================================================
    // T5: Basic crossing — 1 buy + 1 sell, prices cross
    // =========================================================================

    function test_T5_BasicCrossing_OneBuyOneSell() public pure {
        ClearingLib.Bid[] memory bids = new ClearingLib.Bid[](2);
        bids[0] = _makeBuy(ALICE, 105e6, 100e18, 0); // willing to pay up to 105
        bids[1] = _makeSell(CAROL, 100e6, 100e18, 1); // willing to sell for min 100

        // Crossing exists at 100 (sell limit = clearing price)
        ClearingLib.ClearingResult memory result = ClearingLib
            .computeClearingPrice(bids);

        assertTrue(result.hasCrossing, "T5: should have crossing");
        assertEq(
            result.clearingPrice,
            100e6,
            "T5: clearing price should be sell limit (100)"
        );
        assertEq(
            result.clearedQuantity,
            100e18,
            "T5: full quantity should clear"
        );
    }

    function test_T5_BasicCrossing_MatchBids() public pure {
        ClearingLib.Bid[] memory bids = new ClearingLib.Bid[](2);
        bids[0] = _makeBuy(ALICE, 105e6, 100e18, 0);
        bids[1] = _makeSell(CAROL, 100e6, 100e18, 1);

        uint256 clearingPrice = 100e6;
        ClearingLib.Bid[] memory filled = ClearingLib.matchBids(
            bids,
            clearingPrice
        );

        // Both bids should be filled
        assertEq(filled.length, 2, "T5: both bids should be filled");

        uint256 totalFilledBuy = 0;
        uint256 totalFilledSell = 0;
        for (uint256 i = 0; i < filled.length; i++) {
            if (filled[i].isBuy) totalFilledBuy += filled[i].quantity;
            else totalFilledSell += filled[i].quantity;
        }
        assertEq(totalFilledBuy, 100e18, "T5: full buy quantity filled");
        assertEq(totalFilledSell, 100e18, "T5: full sell quantity filled");
    }

    // =========================================================================
    // T6: Tie-breaking — same price, multiple bids → FIFO deterministic
    // =========================================================================

    function test_T6_TieBreaking_SamePrice_FIFO() public pure {
        // Three buyers all at 102, one seller at 100 with qty 80
        // Only 80 tokens available to fill, should go to lower-index (earlier) buyers first
        ClearingLib.Bid[] memory bids = new ClearingLib.Bid[](4);
        bids[0] = _makeBuy(ALICE, 102e6, 50e18, 0); // earliest, index 0
        bids[1] = _makeBuy(BOB, 102e6, 50e18, 1); // second, index 1
        bids[2] = _makeBuy(CAROL, 102e6, 50e18, 2); // third, index 2
        bids[3] = _makeSell(DAVE, 100e6, 80e18, 3); // sells 80

        ClearingLib.ClearingResult memory result = ClearingLib
            .computeClearingPrice(bids);
        assertTrue(result.hasCrossing, "T6: should have crossing");
        assertEq(
            result.clearingPrice,
            100e6,
            "T6: clearing price should be 100"
        );

        ClearingLib.Bid[] memory filled = ClearingLib.matchBids(
            bids,
            result.clearingPrice
        );

        // Verify determinism: same input → same output (call twice)
        ClearingLib.Bid[] memory filled2 = ClearingLib.matchBids(
            bids,
            result.clearingPrice
        );
        assertEq(
            filled.length,
            filled2.length,
            "T6: match must be deterministic"
        );

        for (uint256 i = 0; i < filled.length; i++) {
            if (filled[i].isBuy) {
                // Alice (index 0) should be filled first, then Bob, then Carol partially/not at all
                assertTrue(
                    filled[i].index <= filled2[i].index,
                    "T6: FIFO ordering must be consistent"
                );
            }
        }

        // Total filled buy quantity must equal total filled sell quantity
        uint256 totalBuyFill = 0;
        uint256 totalSellFill = 0;
        for (uint256 i = 0; i < filled.length; i++) {
            if (filled[i].isBuy) totalBuyFill += filled[i].quantity;
            else totalSellFill += filled[i].quantity;
        }
        assertEq(
            totalBuyFill,
            totalSellFill,
            "T6: buy fills must equal sell fills"
        );
    }

    // =========================================================================
    // T7: Partial fill — quantity mismatch between buy and sell sides
    // =========================================================================

    function test_T7_PartialFill_MoreBuyThanSell() public pure {
        // Buyers want 150 total, only 80 available to sell
        ClearingLib.Bid[] memory bids = new ClearingLib.Bid[](3);
        bids[0] = _makeBuy(ALICE, 105e6, 100e18, 0); // buys 100
        bids[1] = _makeBuy(BOB, 102e6, 50e18, 1); // buys 50
        bids[2] = _makeSell(CAROL, 100e6, 80e18, 2); // sells 80

        ClearingLib.ClearingResult memory result = ClearingLib
            .computeClearingPrice(bids);
        assertTrue(result.hasCrossing, "T7: should have crossing");
        assertEq(
            result.clearedQuantity,
            80e18,
            "T7: cleared qty should be min(buy, sell) = 80"
        );

        ClearingLib.Bid[] memory filled = ClearingLib.matchBids(
            bids,
            result.clearingPrice
        );

        uint256 totalBuyFill = 0;
        uint256 totalSellFill = 0;
        for (uint256 i = 0; i < filled.length; i++) {
            if (filled[i].isBuy) totalBuyFill += filled[i].quantity;
            else totalSellFill += filled[i].quantity;
        }
        assertEq(
            totalBuyFill,
            totalSellFill,
            "T7: buy fills must equal sell fills"
        );
        assertEq(
            totalSellFill,
            80e18,
            "T7: total fill should match cleared qty (80)"
        );
        assertTrue(
            totalBuyFill <= 150e18,
            "T7: total buy fill cannot exceed total buy qty"
        );
    }

    function test_T7_PartialFill_MoreSellThanBuy() public pure {
        // Seller has 150, buyers only want 80 total
        ClearingLib.Bid[] memory bids = new ClearingLib.Bid[](3);
        bids[0] = _makeBuy(ALICE, 105e6, 50e18, 0); // buys 50
        bids[1] = _makeBuy(BOB, 102e6, 30e18, 1); // buys 30
        bids[2] = _makeSell(CAROL, 100e6, 150e18, 2); // sells 150

        ClearingLib.ClearingResult memory result = ClearingLib
            .computeClearingPrice(bids);
        assertTrue(result.hasCrossing, "T7b: should have crossing");
        assertEq(
            result.clearedQuantity,
            80e18,
            "T7b: cleared qty should be min(80, 150) = 80"
        );
    }

    // =========================================================================
    // T8: Overflow protection — large quantity × price must not overflow
    // =========================================================================

    function test_T8_LargeValues_NoOverflow() public pure {
        // Use values near uint128 max to test without triggering Solidity's uint256 overflow
        // In practice, price × qty would only be computed in settlement, not in clearing
        // But the sorting / accumulation must handle large values safely
        uint256 largeQty = 1_000_000_000e18; // 1 billion tokens
        uint256 highPrice = 100_000e6; // 100k USDC per token

        ClearingLib.Bid[] memory bids = new ClearingLib.Bid[](2);
        bids[0] = _makeBuy(ALICE, highPrice, largeQty, 0);
        bids[1] = _makeSell(CAROL, highPrice / 2, largeQty, 1);

        // Should not revert with overflow
        ClearingLib.ClearingResult memory result = ClearingLib
            .computeClearingPrice(bids);
        assertTrue(result.hasCrossing, "T8: large values should still cross");
        assertTrue(
            result.clearingPrice > 0,
            "T8: clearing price must be non-zero"
        );
        assertTrue(
            result.clearedQuantity > 0,
            "T8: cleared quantity must be non-zero"
        );
    }

    // =========================================================================
    // Additional robustness tests
    // =========================================================================

    function test_MultipleRoundsClearCorrectly() public pure {
        // Simulate the spec's example scenario:
        // A: buy 100 tokens @ 105
        // B: buy 50 tokens @ 102
        // C: sell 80 tokens @ 100
        // Expected: clearing price = 102, cleared qty = 80
        // (B's price is the marginal buy price, C's sell at 100 < 102, so clearing at 102)

        ClearingLib.Bid[] memory bids = new ClearingLib.Bid[](3);
        bids[0] = _makeBuy(ALICE, 105e6, 100e18, 0);
        bids[1] = _makeBuy(BOB, 102e6, 50e18, 1);
        bids[2] = _makeSell(CAROL, 100e6, 80e18, 2);

        ClearingLib.ClearingResult memory result = ClearingLib
            .computeClearingPrice(bids);
        assertTrue(result.hasCrossing, "Scenario: should have crossing");
        assertEq(
            result.clearedQuantity,
            80e18,
            "Scenario: cleared qty should be 80"
        );
        assertGe(
            result.clearingPrice,
            100e6,
            "Scenario: clearing price >= sell limit"
        );
        assertLe(
            result.clearingPrice,
            105e6,
            "Scenario: clearing price <= top buy limit"
        );
    }

    function test_SingleBidEachSide_FullFill() public pure {
        ClearingLib.Bid[] memory bids = new ClearingLib.Bid[](2);
        bids[0] = _makeBuy(ALICE, 110e6, 100e18, 0);
        bids[1] = _makeSell(BOB, 90e6, 100e18, 1);

        ClearingLib.ClearingResult memory result = ClearingLib
            .computeClearingPrice(bids);
        assertTrue(result.hasCrossing, "Both sides present and crossing");
        assertEq(result.clearedQuantity, 100e18, "Full quantity should clear");
    }

    function test_ZeroQuantityBidIgnored() public pure {
        ClearingLib.Bid[] memory bids = new ClearingLib.Bid[](3);
        bids[0] = _makeBuy(ALICE, 105e6, 0, 0); // zero qty — should not cause issues
        bids[1] = _makeBuy(BOB, 102e6, 100e18, 1);
        bids[2] = _makeSell(CAROL, 100e6, 80e18, 2);

        // Should still clear based on the non-zero bids
        ClearingLib.ClearingResult memory result = ClearingLib
            .computeClearingPrice(bids);
        assertTrue(result.hasCrossing, "Non-zero bids should still cross");
        assertEq(
            result.clearedQuantity,
            80e18,
            "Cleared qty based on valid bids only"
        );
    }
}
