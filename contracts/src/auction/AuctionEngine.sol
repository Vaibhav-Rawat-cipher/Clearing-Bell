// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ClearingLib} from "./ClearingLib.sol";
import {ComplianceGate} from "./ComplianceGate.sol";

/// @title AuctionEngine
/// @notice Orchestrates periodic sealed-bid batch auction rounds for a compliant bond token.
///
/// @dev Flow per round:
///      1. Issuer calls openRound() to start a new auction.
///      2. KYC'd bidders call submitBid() during the open window.
///      3. Anyone (or the issuer) calls closeAndClear() after the window ends.
///      4. ClearingLib computes the uniform clearing price.
///      5. settle() runs atomically: bond tokens and stablecoin swap hands.
///
/// MVP note: This implementation uses open (non-commit-reveal) bidding.
/// Commit-reveal is the production hardening step documented in the README.
contract AuctionEngine is ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    using ClearingLib for ClearingLib.Bid[];

    // =========================================================================
    // Types
    // =========================================================================

    enum Phase {
        Closed, // Round not yet started or already settled
        Open, // Bids accepted
        Cleared // Clearing price computed, awaiting/during settlement
    }

    struct AuctionRound {
        uint256 id;
        address bondToken;
        address settlementToken; // USDC or other stablecoin
        uint256 openDeadline; // unix timestamp: bids accepted until here
        Phase phase;
        uint256 clearingPrice;
        uint256 clearedQuantity;
        uint256 bidCount; // running counter for FIFO index
    }

    // =========================================================================
    // State
    // =========================================================================

    ComplianceGate public immutable complianceGate;
    address public issuer;

    uint256 public nextRoundId;
    mapping(uint256 => AuctionRound) public rounds;
    mapping(uint256 => ClearingLib.Bid[]) internal _roundBids;

    // =========================================================================
    // Events
    // =========================================================================

    event RoundOpened(
        uint256 indexed roundId,
        address indexed bondToken,
        address settlementToken,
        uint256 openDeadline
    );
    event BidSubmitted(
        uint256 indexed roundId,
        address indexed bidder,
        uint256 price,
        uint256 quantity,
        bool isBuy,
        uint256 bidIndex
    );
    event RoundCleared(uint256 indexed roundId, uint256 clearingPrice, uint256 clearedQuantity);
    event Settled(
        uint256 indexed roundId,
        address indexed bidder,
        uint256 filledQuantity,
        uint256 settledPrice,
        bool isBuy
    );
    event RoundClosedWithNoCrossing(uint256 indexed roundId);

    // =========================================================================
    // Errors
    // =========================================================================

    error NotIssuer();
    error RoundNotOpen(uint256 roundId);
    error RoundStillOpen(uint256 roundId);
    error RoundAlreadyCleared(uint256 roundId);
    error BidWindowClosed(uint256 roundId);
    error BidderNotEligible(address bidder);
    error InvalidBidPrice();
    error InvalidBidQuantity();
    error ZeroAddress();

    // =========================================================================
    // Modifiers
    // =========================================================================

    modifier onlyIssuer() {
        if (msg.sender != issuer) revert NotIssuer();
        _;
    }

    // =========================================================================
    // Constructor
    // =========================================================================

    constructor(address _complianceGate, address _issuer) {
        if (_complianceGate == address(0) || _issuer == address(0)) revert ZeroAddress();
        complianceGate = ComplianceGate(_complianceGate);
        issuer = _issuer;
        nextRoundId = 1;
    }

    // =========================================================================
    // Round Management
    // =========================================================================

    /// @notice Open a new auction round for a given bond token.
    /// @param bondToken       ERC-3643 bond token address.
    /// @param settlementToken Stablecoin address (e.g. USDC).
    /// @param bidWindow       Duration in seconds the bid window stays open.
    /// @return roundId        Identifier for the newly created round.
    function openRound(address bondToken, address settlementToken, uint256 bidWindow)
        external
        onlyIssuer
        whenNotPaused
        returns (uint256 roundId)
    {
        if (bondToken == address(0) || settlementToken == address(0)) revert ZeroAddress();

        roundId = nextRoundId++;
        rounds[roundId] = AuctionRound({
            id: roundId,
            bondToken: bondToken,
            settlementToken: settlementToken,
            openDeadline: block.timestamp + bidWindow,
            phase: Phase.Open,
            clearingPrice: 0,
            clearedQuantity: 0,
            bidCount: 0
        });

        emit RoundOpened(roundId, bondToken, settlementToken, rounds[roundId].openDeadline);
    }

    // =========================================================================
    // Bid Submission
    // =========================================================================

    /// @notice Submit a bid into an open auction round.
    /// @dev Compliance is checked here AND re-checked at settlement.
    /// @param roundId   The auction round to bid into.
    /// @param price     Limit price in settlement token units per bond token (6 decimals for USDC).
    /// @param quantity  Number of bond tokens to buy or sell (18 decimals).
    /// @param isBuy     True = buy order, false = sell order.
    function submitBid(uint256 roundId, uint256 price, uint256 quantity, bool isBuy)
        external
        whenNotPaused
    {
        AuctionRound storage round = rounds[roundId];

        if (round.phase != Phase.Open) revert RoundNotOpen(roundId);
        if (block.timestamp > round.openDeadline) revert BidWindowClosed(roundId);
        if (price == 0) revert InvalidBidPrice();
        if (quantity == 0) revert InvalidBidQuantity();

        // Compliance check at bid submission time
        if (!complianceGate.isEligible(msg.sender, round.bondToken)) {
            revert BidderNotEligible(msg.sender);
        }

        uint256 bidIndex = round.bidCount++;
        _roundBids[roundId].push(
            ClearingLib.Bid({
                bidder: msg.sender,
                price: price,
                quantity: quantity,
                isBuy: isBuy,
                index: bidIndex
            })
        );

        emit BidSubmitted(roundId, msg.sender, price, quantity, isBuy, bidIndex);
    }

    // =========================================================================
    // Clearing
    // =========================================================================

    /// @notice Close the bid window and compute the clearing price.
    /// @dev Can be called by anyone once the window has passed (permissionless clearing).
    ///      Issuer can also force-close early if needed.
    function closeAndClear(uint256 roundId) external whenNotPaused nonReentrant {
        AuctionRound storage round = rounds[roundId];

        if (round.phase != Phase.Open) revert RoundNotOpen(roundId);
        // Issuer can close early; otherwise must wait for deadline
        if (msg.sender != issuer && block.timestamp <= round.openDeadline) {
            revert RoundStillOpen(roundId);
        }

        ClearingLib.Bid[] memory bids = _roundBids[roundId];
        ClearingLib.ClearingResult memory result = ClearingLib.computeClearingPrice(bids);

        if (!result.hasCrossing) {
            round.phase = Phase.Closed; // No crossing — round closes with no trades
            emit RoundClosedWithNoCrossing(roundId);
            return;
        }

        round.clearingPrice = result.clearingPrice;
        round.clearedQuantity = result.clearedQuantity;
        round.phase = Phase.Cleared;

        emit RoundCleared(roundId, result.clearingPrice, result.clearedQuantity);

        // Immediately settle — atomic with the clearing computation
        _settle(roundId, result.clearingPrice, bids);
    }

    // =========================================================================
    // Settlement
    // =========================================================================

    /// @notice Internal settlement logic — called atomically after clearing.
    /// @dev DvP settlement: pull both legs into the engine (collect phase), then
    ///      deliver both legs out (distribute phase) within the same transaction.
    ///      Bidders whose KYC was revoked by settlement time are excluded from the
    ///      eligible bid set BEFORE matching, so the matched buy/sell totals always
    ///      balance and settlement can never leave a half-settled counterparty.
    function _settle(uint256 roundId, uint256 clearingPrice, ClearingLib.Bid[] memory allBids)
        internal
    {
        AuctionRound storage round = rounds[roundId];

        // Reduce to the eligible bid set (drop revoked bidders), then match for a
        // balanced fill where total buy quantity == total sell quantity.
        ClearingLib.Bid[] memory filledBids = _matchEligibleBids(round, allBids, clearingPrice);

        IERC20 bondToken = IERC20(round.bondToken);
        IERC20 settlementToken = IERC20(round.settlementToken);

        // Collect phase: pull both legs into the engine.
        for (uint256 i = 0; i < filledBids.length; i++) {
            ClearingLib.Bid memory bid = filledBids[i];
            uint256 settlementAmount = bid.quantity * clearingPrice / 1e18;
            if (bid.isBuy) {
                settlementToken.safeTransferFrom(bid.bidder, address(this), settlementAmount);
            } else {
                bondToken.safeTransferFrom(bid.bidder, address(this), bid.quantity);
            }
        }

        // Distribute phase: deliver both legs out of the engine.
        for (uint256 i = 0; i < filledBids.length; i++) {
            ClearingLib.Bid memory bid = filledBids[i];
            uint256 settlementAmount = bid.quantity * clearingPrice / 1e18;
            if (bid.isBuy) {
                bondToken.safeTransfer(bid.bidder, bid.quantity);
            } else {
                settlementToken.safeTransfer(bid.bidder, settlementAmount);
            }

            emit Settled(roundId, bid.bidder, bid.quantity, clearingPrice, bid.isBuy);
        }

        round.phase = Phase.Closed;
    }

    /// @dev Filters `allBids` to only KYC-eligible bidders, then matches the subset.
    ///      Matching on the eligible subset guarantees the buy and sell fill totals are
    ///      equal, so the collect/distribute phases always settle to zero net balance.
    function _matchEligibleBids(
        AuctionRound storage round,
        ClearingLib.Bid[] memory allBids,
        uint256 clearingPrice
    ) internal view returns (ClearingLib.Bid[] memory filledBids) {
        uint256 eligibleCount = 0;
        for (uint256 i = 0; i < allBids.length; i++) {
            if (complianceGate.isEligible(allBids[i].bidder, round.bondToken)) {
                eligibleCount++;
            }
        }

        ClearingLib.Bid[] memory eligibleBids = new ClearingLib.Bid[](eligibleCount);
        uint256 idx = 0;
        for (uint256 i = 0; i < allBids.length; i++) {
            if (complianceGate.isEligible(allBids[i].bidder, round.bondToken)) {
                eligibleBids[idx++] = allBids[i];
            }
        }

        filledBids = ClearingLib.matchBids(eligibleBids, clearingPrice);
    }

    // =========================================================================
    // View Functions
    // =========================================================================

    /// @notice Get all bids submitted to a round.
    function getRoundBids(uint256 roundId) external view returns (ClearingLib.Bid[] memory) {
        return _roundBids[roundId];
    }

    /// @notice Get the current phase of a round.
    function getRoundPhase(uint256 roundId) external view returns (Phase) {
        return rounds[roundId].phase;
    }

    // =========================================================================
    // Admin
    // =========================================================================

    function pause() external onlyIssuer {
        _pause();
    }

    function unpause() external onlyIssuer {
        _unpause();
    }

    function transferIssuer(address newIssuer) external onlyIssuer {
        if (newIssuer == address(0)) revert ZeroAddress();
        issuer = newIssuer;
    }
}
