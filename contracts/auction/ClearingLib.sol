// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ClearingLib
/// @notice Pure library that computes the uniform clearing price for a batch auction.
/// @dev No state, no external calls — fully unit-testable in isolation.
///      Algorithm: sort buys descending, sells ascending, find the crossing point.
///
/// References:
///   - Budish, Cramton & Shim (2015), QJE 130(4) — batch auction clearing mechanism
///   - FairTraDEX (arXiv:2202.06384) — on-chain batch auction reference implementation
library ClearingLib {
    // =========================================================================
    // Data Structures
    // =========================================================================

    /// @notice A single bid in an auction round.
    /// @param bidder   Address of the bid submitter.
    /// @param price    Limit price in stablecoin units (e.g. USDC with 6 decimals) per bond token.
    /// @param quantity Number of bond tokens (in base units, e.g. 1e18 per token).
    /// @param isBuy    True = buy order (bidder wants to receive bond tokens).
    ///                 False = sell order (bidder wants to deliver bond tokens).
    /// @param index    Submission order index — used for deterministic FIFO tie-breaking.
    struct Bid {
        address bidder;
        uint256 price;
        uint256 quantity;
        bool isBuy;
        uint256 index; // set to submission order at auction time
    }

    /// @notice Result of a clearing computation.
    /// @param clearingPrice   The single uniform price all matched trades occur at. 0 if no crossing.
    /// @param clearedQuantity Total quantity that can be matched at the clearing price.
    /// @param hasCrossing     Whether a valid crossing point exists.
    struct ClearingResult {
        uint256 clearingPrice;
        uint256 clearedQuantity;
        bool hasCrossing;
    }

    // =========================================================================
    // Core Algorithm
    // =========================================================================

    /// @notice Computes the uniform clearing price from a mixed bid array.
    /// @dev Steps:
    ///      1. Separate buys and sells.
    ///      2. Sort buys descending by price (highest willing-to-pay first).
    ///      3. Sort sells ascending by price (lowest willing-to-accept first).
    ///      4. Walk both arrays accumulating quantities until buy price < sell price.
    ///      5. The last price point where cumBuyQty >= cumSellQty is the clearing price.
    ///      6. If no crossing, return hasCrossing = false.
    ///
    /// @param bids Mixed array of buy and sell bids.
    /// @return result ClearingResult with clearing price, cleared quantity, and crossing flag.
    function computeClearingPrice(Bid[] memory bids)
        internal
        pure
        returns (ClearingResult memory result)
    {
        if (bids.length == 0) {
            return result; // hasCrossing = false, all zeros
        }

        // --- Step 1: Separate buy and sell bids (skip zero-quantity bids) ---
        (Bid[] memory buys, Bid[] memory sells) = _separateBids(bids);

        if (buys.length == 0 || sells.length == 0) {
            return result; // No crossing possible without both sides
        }

        // --- Step 2 & 3: Sort ---
        _sortBuysDescending(buys); // highest buy price first
        _sortSellsAscending(sells); // lowest sell price first

        // --- Step 4 & 5: Demand-schedule / supply-schedule crossing ---
        //
        // For each candidate clearing price p (every unique sell limit price in the book):
        //   - cumBuyQty(p)  = sum of all buy quantities with price >= p
        //   - cumSellQty(p) = sum of all sell quantities with price <= p
        //   - matchedQty(p) = min(cumBuyQty(p), cumSellQty(p))
        //
        // The clearing price is the highest p where cumBuyQty(p) >= cumSellQty(p) AND both > 0.
        // We advance buy and sell pointers independently.

        uint256 buyPtr = 0; // next buy to include at the current sell price level
        uint256 cumBuyQty = 0;
        uint256 cumSellQty = 0;
        uint256 lastValidClearingPrice = 0;
        uint256 lastValidClearedQty = 0;

        for (uint256 sellPtr = 0; sellPtr < sells.length; sellPtr++) {
            uint256 candidatePrice = sells[sellPtr].price;

            // Accumulate all buys willing to pay >= candidatePrice
            while (buyPtr < buys.length && buys[buyPtr].price >= candidatePrice) {
                cumBuyQty += buys[buyPtr].quantity;
                buyPtr++;
            }

            // Accumulate this sell at the candidate price
            cumSellQty += sells[sellPtr].quantity;

            // If there are any buys left to match at this price level
            if (cumBuyQty == 0) {
                break; // No buyers willing to pay this much — stop searching
            }

            uint256 matchedQty = cumBuyQty < cumSellQty ? cumBuyQty : cumSellQty;
            lastValidClearingPrice = candidatePrice;
            lastValidClearedQty = matchedQty;
        }

        if (lastValidClearingPrice == 0) {
            return result; // No valid crossing found
        }

        result.clearingPrice = lastValidClearingPrice;
        result.clearedQuantity = lastValidClearedQty;
        result.hasCrossing = true;
    }

    /// @notice Given a clearing price, returns the subset of bids that are filled and at what quantity.
    /// @dev Buy bids with price >= clearingPrice are eligible. Sell bids with price <= clearingPrice are eligible.
    ///      If total buy qty != total sell qty at the clearing price, the marginal tranche is pro-rata filled.
    ///
    /// @param bids          Full bid array.
    /// @param clearingPrice The computed clearing price.
    /// @return filledBids   Array of bids with their quantities set to the filled amount.
    ///                      Bids that are not filled at all are excluded.
    function matchBids(Bid[] memory bids, uint256 clearingPrice)
        internal
        pure
        returns (Bid[] memory filledBids)
    {
        if (bids.length == 0 || clearingPrice == 0) {
            return new Bid[](0);
        }

        // --- Separate eligible bids ---
        (Bid[] memory eligibleBuys, Bid[] memory eligibleSells) = _filterEligible(bids, clearingPrice);

        if (eligibleBuys.length == 0 || eligibleSells.length == 0) {
            return new Bid[](0);
        }

        // Sort so marginal bids (worst prices) are handled last for pro-rata
        _sortBuysDescending(eligibleBuys);
        _sortSellsAscending(eligibleSells);

        uint256 totalBuyQty = _totalQuantity(eligibleBuys);
        uint256 totalSellQty = _totalQuantity(eligibleSells);
        uint256 matchedQty = totalBuyQty < totalSellQty ? totalBuyQty : totalSellQty;

        // --- Allocate filled quantities ---
        // The constrained side is filled fully (intra-FIFO), the unconstrained side is pro-rata at the margin.
        Bid[] memory tempFilled = new Bid[](eligibleBuys.length + eligibleSells.length);
        uint256 filledCount = 0;

        filledCount = _allocateFills(eligibleBuys, matchedQty, true, tempFilled, filledCount);
        filledCount = _allocateFills(eligibleSells, matchedQty, false, tempFilled, filledCount);

        // Trim to actual filled count
        filledBids = new Bid[](filledCount);
        for (uint256 i = 0; i < filledCount; i++) {
            filledBids[i] = tempFilled[i];
        }
    }

    // =========================================================================
    // Internal Helpers
    // =========================================================================

    function _separateBids(Bid[] memory bids)
        private
        pure
        returns (Bid[] memory buys, Bid[] memory sells)
    {
        uint256 buyCount = 0;
        uint256 sellCount = 0;
        for (uint256 i = 0; i < bids.length; i++) {
            if (bids[i].quantity == 0) continue; // skip zero-quantity bids
            if (bids[i].isBuy) buyCount++;
            else sellCount++;
        }

        buys = new Bid[](buyCount);
        sells = new Bid[](sellCount);
        uint256 bi = 0;
        uint256 si = 0;
        for (uint256 i = 0; i < bids.length; i++) {
            if (bids[i].quantity == 0) continue; // skip zero-quantity bids
            if (bids[i].isBuy) buys[bi++] = bids[i];
            else sells[si++] = bids[i];
        }
    }

    function _filterEligible(Bid[] memory bids, uint256 clearingPrice)
        private
        pure
        returns (Bid[] memory eligibleBuys, Bid[] memory eligibleSells)
    {
        uint256 buyCount = 0;
        uint256 sellCount = 0;
        for (uint256 i = 0; i < bids.length; i++) {
            if (bids[i].isBuy && bids[i].price >= clearingPrice) buyCount++;
            else if (!bids[i].isBuy && bids[i].price <= clearingPrice) sellCount++;
        }

        eligibleBuys = new Bid[](buyCount);
        eligibleSells = new Bid[](sellCount);
        uint256 bi = 0;
        uint256 si = 0;
        for (uint256 i = 0; i < bids.length; i++) {
            if (bids[i].isBuy && bids[i].price >= clearingPrice) eligibleBuys[bi++] = bids[i];
            else if (!bids[i].isBuy && bids[i].price <= clearingPrice) eligibleSells[si++] = bids[i];
        }
    }

    function _totalQuantity(Bid[] memory bids) private pure returns (uint256 total) {
        for (uint256 i = 0; i < bids.length; i++) {
            total += bids[i].quantity;
        }
    }

    /// @dev Allocate fills FIFO from the sorted bid array until `availableQty` is exhausted.
    ///      For the constrained side (less total qty than the other), all are filled fully.
    ///      For the unconstrained side, the last (marginal) bid is pro-rata filled.
    function _allocateFills(
        Bid[] memory sortedBids,
        uint256 availableQty,
        bool isBuySide,
        Bid[] memory output,
        uint256 outputIdx
    ) private pure returns (uint256 newOutputIdx) {
        uint256 remaining = availableQty;
        uint256 totalSide = _totalQuantity(sortedBids);

        // If this side has less quantity than available, fill all fully
        if (totalSide <= availableQty) {
            for (uint256 i = 0; i < sortedBids.length; i++) {
                if (sortedBids[i].quantity > 0) {
                    output[outputIdx] = sortedBids[i];
                    // quantity stays as-is (fully filled)
                    outputIdx++;
                }
            }
        } else {
            // This side has more qty than can be matched — fill FIFO, pro-rata at margin
            for (uint256 i = 0; i < sortedBids.length && remaining > 0; i++) {
                Bid memory b = sortedBids[i];
                uint256 fill = b.quantity < remaining ? b.quantity : remaining;
                remaining -= fill;
                b.quantity = fill;
                output[outputIdx] = b;
                outputIdx++;
            }
        }

        // Suppress unused variable warning
        (isBuySide);

        return outputIdx;
    }

    // =========================================================================
    // Sorting (insertion sort — acceptable for small bid arrays, O(n²))
    // For production with large arrays, use off-chain sorting + on-chain verify.
    // =========================================================================

    /// @dev Sort buys descending by price. Ties broken by FIFO (lower index first).
    function _sortBuysDescending(Bid[] memory bids) private pure {
        uint256 n = bids.length;
        for (uint256 i = 1; i < n; i++) {
            Bid memory key = bids[i];
            int256 j = int256(i) - 1;
            while (j >= 0) {
                Bid memory curr = bids[uint256(j)];
                bool shouldSwap = curr.price < key.price
                    || (curr.price == key.price && curr.index > key.index);
                if (shouldSwap) {
                    bids[uint256(j) + 1] = curr;
                    j--;
                } else {
                    break;
                }
            }
            bids[uint256(j) + 1] = key;
        }
    }

    /// @dev Sort sells ascending by price. Ties broken by FIFO (lower index first).
    function _sortSellsAscending(Bid[] memory bids) private pure {
        uint256 n = bids.length;
        for (uint256 i = 1; i < n; i++) {
            Bid memory key = bids[i];
            int256 j = int256(i) - 1;
            while (j >= 0) {
                Bid memory curr = bids[uint256(j)];
                bool shouldSwap = curr.price > key.price
                    || (curr.price == key.price && curr.index > key.index);
                if (shouldSwap) {
                    bids[uint256(j) + 1] = curr;
                    j--;
                } else {
                    break;
                }
            }
            bids[uint256(j) + 1] = key;
        }
    }
}
