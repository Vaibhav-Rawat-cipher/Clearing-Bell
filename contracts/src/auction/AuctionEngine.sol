// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ClearingLib} from "./ClearingLib.sol";
import {ComplianceGate} from "./ComplianceGate.sol";

/// @title AuctionEngine
/// @notice Orchestrates periodic open-order batch auction rounds for compliant bond tokens.
///
/// @dev Multi-issuer platform architecture:
///      - platformAdmin (Clearing Bell) approves companies as bond issuers.
///      - Each bond token maps to exactly one issuer address.
///      - Issuers can only open/close/pause rounds for bonds they are registered for.
///      - platformAdmin can pause/unpause the entire engine globally.
///
///      Flow per round:
///      1. platformAdmin registers a company wallet as issuer for their bond token.
///      2. Company (issuer) calls openRound() for their bond.
///      3. KYC'd investors call submitBid() during the open window.
///      4. Anyone (or the issuer) calls closeAndClear() after the deadline.
///      5. ClearingLib computes the uniform clearing price.
///      6. Settlement runs atomically: both tokens swap hands.
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

    /// @notice Clearing Bell platform admin — the only address that can register bond issuers.
    address public platformAdmin;

    /// @notice Maps bond token address → the company wallet authorized to open rounds for it.
    mapping(address bondToken => address issuer) public bondIssuers;

    /// @notice Whether a specific bond's rounds are paused (bond-level pause by issuer).
    mapping(address bondToken => bool paused) public bondPaused;

    uint256 public nextRoundId;
    mapping(uint256 => AuctionRound) public rounds;
    mapping(uint256 => ClearingLib.Bid[]) internal _roundBids;
    mapping(address => bool) public authorizedBidRelayers;

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
    event BidRelayerUpdated(address indexed relayer, bool authorized);

    /// @notice Emitted when a company is registered as the issuer for a bond token.
    event BondIssuerRegistered(address indexed bondToken, address indexed issuer);

    /// @notice Emitted when platform admin role is transferred.
    event PlatformAdminTransferred(address indexed oldAdmin, address indexed newAdmin);

    /// @notice Emitted when a bond's auction rounds are paused or unpaused by the issuer.
    event BondPauseChanged(address indexed bondToken, bool paused);

    // =========================================================================
    // Errors
    // =========================================================================

    error NotPlatformAdmin();
    error NotBondIssuer(address bondToken);
    error BondNotRegistered(address bondToken);
    error RoundNotOpen(uint256 roundId);
    error RoundStillOpen(uint256 roundId);
    error RoundAlreadyCleared(uint256 roundId);
    error BidWindowClosed(uint256 roundId);
    error BidderNotEligible(address bidder);
    error InvalidBidPrice();
    error InvalidBidQuantity();
    error ZeroAddress();
    error NotAuthorizedBidRelayer();
    error BondRoundsPaused(address bondToken);

    // =========================================================================
    // Modifiers
    // =========================================================================

    modifier onlyPlatformAdmin() {
        if (msg.sender != platformAdmin) revert NotPlatformAdmin();
        _;
    }

    /// @notice Restricts a call to the registered issuer for a specific bond token.
    modifier onlyBondIssuer(address bondToken) {
        if (bondIssuers[bondToken] == address(0)) revert BondNotRegistered(bondToken);
        if (msg.sender != bondIssuers[bondToken]) revert NotBondIssuer(bondToken);
        _;
    }

    modifier onlyAuthorizedRelayer() {
        if (!authorizedBidRelayers[msg.sender]) revert NotAuthorizedBidRelayer();
        _;
    }

    // =========================================================================
    // Constructor
    // =========================================================================

    /// @param _complianceGate  Address of the ComplianceGate contract.
    /// @param _platformAdmin   Clearing Bell platform admin address.
    constructor(address _complianceGate, address _platformAdmin) {
        if (_complianceGate == address(0) || _platformAdmin == address(0)) revert ZeroAddress();
        complianceGate = ComplianceGate(_complianceGate);
        platformAdmin = _platformAdmin;
        nextRoundId = 1;
    }

    // =========================================================================
    // Platform Admin — Issuer Registration
    // =========================================================================

    /// @notice Register a company wallet as the authorized issuer for a bond token.
    /// @dev Only the platformAdmin can call this. Each bond has exactly one issuer.
    ///      Call again with a new address to transfer issuer rights for a bond.
    /// @param bondToken  The ERC-3643 bond token address.
    /// @param company    The company wallet that will control auctions for this bond.
    function registerBondIssuer(address bondToken, address company) external onlyPlatformAdmin {
        if (bondToken == address(0) || company == address(0)) revert ZeroAddress();
        bondIssuers[bondToken] = company;
        emit BondIssuerRegistered(bondToken, company);
    }

    /// @notice Transfer platform admin role to a new address.
    function transferPlatformAdmin(address newAdmin) external onlyPlatformAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        emit PlatformAdminTransferred(platformAdmin, newAdmin);
        platformAdmin = newAdmin;
    }

    // =========================================================================
    // Global Pause (platform admin only)
    // =========================================================================

    /// @notice Pause the entire engine — no new bids, rounds, or clearing across all bonds.
    function pause() external onlyPlatformAdmin {
        _pause();
    }

    /// @notice Resume the entire engine.
    function unpause() external onlyPlatformAdmin {
        _unpause();
    }

    // =========================================================================
    // Bond-Level Pause (bond issuer only)
    // =========================================================================

    /// @notice Pause rounds for a specific bond. Only the registered issuer can call this.
    /// @param bondToken The bond whose rounds should be paused.
    function pauseBond(address bondToken) external onlyBondIssuer(bondToken) {
        bondPaused[bondToken] = true;
        emit BondPauseChanged(bondToken, true);
    }

    /// @notice Resume rounds for a specific bond.
    function unpauseBond(address bondToken) external onlyBondIssuer(bondToken) {
        bondPaused[bondToken] = false;
        emit BondPauseChanged(bondToken, false);
    }

    // =========================================================================
    // Round Management
    // =========================================================================

    /// @notice Open a new auction round for a bond token.
    /// @dev Only the registered issuer for `bondToken` can call this.
    /// @param bondToken       ERC-3643 bond token address.
    /// @param settlementToken Stablecoin address (e.g. USDC).
    /// @param bidWindow       Duration in seconds the bid window stays open.
    /// @return roundId        Identifier for the newly created round.
    function openRound(address bondToken, address settlementToken, uint256 bidWindow)
        external
        onlyBondIssuer(bondToken)
        whenNotPaused
        returns (uint256 roundId)
    {
        if (bondToken == address(0) || settlementToken == address(0)) revert ZeroAddress();
        if (bondPaused[bondToken]) revert BondRoundsPaused(bondToken);

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
        _submitBid(msg.sender, roundId, price, quantity, isBuy);
    }

    /// @notice Relay a bid on behalf of `bidder` from an authorized caller (the clearing hook).
    /// @dev Enables the Uniswap v4 hook to route a user's swap into the auction as that user's
    ///      bid. The real bidder (the swap sender) is KYC-checked at bid time AND at settlement.
    /// @param bidder    The swap sender / actual bidder on whose behalf the bid is placed.
    /// @param roundId   The auction round to bid into.
    /// @param price     Limit price in settlement token units per bond token.
    /// @param quantity  Number of bond tokens to buy or sell.
    /// @param isBuy     True = buy order, false = sell order.
    function submitBidFor(address bidder, uint256 roundId, uint256 price, uint256 quantity, bool isBuy)
        external
        onlyAuthorizedRelayer
        whenNotPaused
    {
        _submitBid(bidder, roundId, price, quantity, isBuy);
    }

    /// @notice Grant or revoke privileged bid-relay rights (e.g. to the clearing hook).
    /// @param relayer    The contract allowed to relay bids on behalf of traders.
    /// @param authorized True to allow, false to revoke.
    function setAuthorizedBidRelayer(address relayer, bool authorized) external onlyPlatformAdmin {
        if (relayer == address(0)) revert ZeroAddress();
        authorizedBidRelayers[relayer] = authorized;
        emit BidRelayerUpdated(relayer, authorized);
    }

    function _submitBid(address bidder, uint256 roundId, uint256 price, uint256 quantity, bool isBuy)
        internal
    {
        AuctionRound storage round = rounds[roundId];

        if (round.phase != Phase.Open) revert RoundNotOpen(roundId);
        if (block.timestamp > round.openDeadline) revert BidWindowClosed(roundId);
        if (bondPaused[round.bondToken]) revert BondRoundsPaused(round.bondToken);
        if (price == 0) revert InvalidBidPrice();
        if (quantity == 0) revert InvalidBidQuantity();

        // Compliance check at bid submission time
        if (!complianceGate.isEligible(bidder, round.bondToken)) {
            revert BidderNotEligible(bidder);
        }

        uint256 bidIndex = round.bidCount++;
        _roundBids[roundId].push(
            ClearingLib.Bid({
                bidder: bidder,
                price: price,
                quantity: quantity,
                isBuy: isBuy,
                index: bidIndex
            })
        );

        emit BidSubmitted(roundId, bidder, price, quantity, isBuy, bidIndex);
    }

    // =========================================================================
    // Clearing
    // =========================================================================

    /// @notice Close the bid window and compute the clearing price.
    /// @dev Can be called by anyone once the window has passed (permissionless clearing).
    ///      The registered issuer for the bond can also force-close early.
    function closeAndClear(uint256 roundId) external whenNotPaused nonReentrant {
        AuctionRound storage round = rounds[roundId];

        if (round.phase != Phase.Open) revert RoundNotOpen(roundId);

        // Registered issuer can close early; otherwise must wait for deadline
        bool callerIsIssuer = (msg.sender == bondIssuers[round.bondToken]);
        if (!callerIsIssuer && block.timestamp <= round.openDeadline) {
            revert RoundStillOpen(roundId);
        }

        // Eligibility affects price discovery as well as delivery. Computing a
        // price from subsequently excluded orders reports non-executable volume.
        ClearingLib.Bid[] memory bids = _eligibleBids(round, _roundBids[roundId]);
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

        // The same eligible set determines both the price and the actual fills.
        ClearingLib.Bid[] memory filledBids = ClearingLib.matchBids(allBids, clearingPrice);

        IERC20 bondToken = IERC20(round.bondToken);
        IERC20 settlementToken = IERC20(round.settlementToken);
        uint256[] memory payments = _settlementPayments(filledBids, clearingPrice);

        // Collect phase: pull both legs into the engine.
        for (uint256 i = 0; i < filledBids.length; i++) {
            ClearingLib.Bid memory bid = filledBids[i];
            if (bid.isBuy) {
                settlementToken.safeTransferFrom(bid.bidder, address(this), payments[i]);
            } else {
                bondToken.safeTransferFrom(bid.bidder, address(this), bid.quantity);
            }
        }

        // Distribute phase: deliver both legs out of the engine.
        for (uint256 i = 0; i < filledBids.length; i++) {
            ClearingLib.Bid memory bid = filledBids[i];
            if (bid.isBuy) {
                bondToken.safeTransfer(bid.bidder, bid.quantity);
            } else {
                settlementToken.safeTransfer(bid.bidder, payments[i]);
            }

            emit Settled(roundId, bid.bidder, bid.quantity, clearingPrice, bid.isBuy);
        }

        round.phase = Phase.Closed;
    }

    /// @dev Difference consecutive cumulative-floor quotes on each side. Since
    ///      matched buy and sell quantities are equal, both cash totals equal
    ///      floor(totalQuantity * price / 1e18), even for fractional quantities.
    ///      Each payment is either floor or ceil of that order's exact quote;
    ///      buyers should approve ceil(quantity * limitPrice / 1e18) per order.
    function _settlementPayments(ClearingLib.Bid[] memory bids, uint256 price)
        internal
        pure
        returns (uint256[] memory payments)
    {
        payments = new uint256[](bids.length);
        uint256 buyQuantity;
        uint256 sellQuantity;
        uint256 buyQuote;
        uint256 sellQuote;
        for (uint256 i; i < bids.length; i++) {
            if (bids[i].isBuy) {
                buyQuantity += bids[i].quantity;
                uint256 nextQuote = Math.mulDiv(buyQuantity, price, 1e18);
                payments[i] = nextQuote - buyQuote;
                buyQuote = nextQuote;
            } else {
                sellQuantity += bids[i].quantity;
                uint256 nextQuote = Math.mulDiv(sellQuantity, price, 1e18);
                payments[i] = nextQuote - sellQuote;
                sellQuote = nextQuote;
            }
        }
    }

    /// @dev Filters before price discovery so reported volume and delivery agree.
    function _eligibleBids(
        AuctionRound storage round,
        ClearingLib.Bid[] memory allBids
    ) internal view returns (ClearingLib.Bid[] memory eligibleBids) {
        uint256 eligibleCount = 0;
        for (uint256 i = 0; i < allBids.length; i++) {
            if (complianceGate.isEligible(allBids[i].bidder, round.bondToken)) {
                eligibleCount++;
            }
        }

        eligibleBids = new ClearingLib.Bid[](eligibleCount);
        uint256 idx = 0;
        for (uint256 i = 0; i < allBids.length; i++) {
            if (complianceGate.isEligible(allBids[i].bidder, round.bondToken)) {
                eligibleBids[idx++] = allBids[i];
            }
        }
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
}
