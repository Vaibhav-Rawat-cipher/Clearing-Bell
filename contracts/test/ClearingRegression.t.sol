// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ClearingLib} from "src/auction/ClearingLib.sol";

contract ClearingRegressionTest is Test {
    function test_ExpensiveAskCannotEraseExistingCrossing() public pure {
        ClearingLib.Bid[] memory bids = new ClearingLib.Bid[](3);
        bids[0] = ClearingLib.Bid(address(1), 100e6, 10e18, true, 0);
        bids[1] = ClearingLib.Bid(address(2), 90e6, 10e18, false, 1);
        bids[2] = ClearingLib.Bid(address(3), 200e6, 10e18, false, 2);
        ClearingLib.ClearingResult memory result = ClearingLib.computeClearingPrice(bids);
        assertEq(result.clearingPrice, 90e6);
        assertEq(result.clearedQuantity, 10e18);
        assertEq(ClearingLib.matchBids(bids, result.clearingPrice).length, 2);
    }

    function test_PriceMaximizesExecutableVolume() public pure {
        ClearingLib.Bid[] memory bids = new ClearingLib.Bid[](4);
        bids[0] = ClearingLib.Bid(address(1), 100e6, 100e18, true, 0);
        bids[1] = ClearingLib.Bid(address(2), 120e6, 10e18, true, 1);
        bids[2] = ClearingLib.Bid(address(3), 90e6, 100e18, false, 2);
        bids[3] = ClearingLib.Bid(address(4), 110e6, 10e18, false, 3);
        ClearingLib.ClearingResult memory result = ClearingLib.computeClearingPrice(bids);
        assertEq(result.clearingPrice, 90e6);
        assertEq(result.clearedQuantity, 100e18);
    }

    function testFuzz_ReportedVolumeEqualsBothSettlementSides(uint64 a, uint64 b, uint64 c, uint64 d)
        public pure
    {
        ClearingLib.Bid[] memory bids = new ClearingLib.Bid[](4);
        bids[0] = ClearingLib.Bid(address(1), uint256(a) % 200e6 + 1, 13e18, true, 0);
        bids[1] = ClearingLib.Bid(address(2), uint256(b) % 200e6 + 1, 29e18, true, 1);
        bids[2] = ClearingLib.Bid(address(3), uint256(c) % 200e6 + 1, 17e18, false, 2);
        bids[3] = ClearingLib.Bid(address(4), uint256(d) % 200e6 + 1, 31e18, false, 3);
        ClearingLib.ClearingResult memory result = ClearingLib.computeClearingPrice(bids);
        ClearingLib.Bid[] memory filled = ClearingLib.matchBids(bids, result.clearingPrice);
        uint256 bought;
        uint256 sold;
        for (uint256 i; i < filled.length; i++) {
            if (filled[i].isBuy) {
                assertGe(filled[i].price, result.clearingPrice);
                bought += filled[i].quantity;
            } else {
                assertLe(filled[i].price, result.clearingPrice);
                sold += filled[i].quantity;
            }
        }
        assertEq(bought, result.clearedQuantity);
        assertEq(sold, result.clearedQuantity);
    }
}
