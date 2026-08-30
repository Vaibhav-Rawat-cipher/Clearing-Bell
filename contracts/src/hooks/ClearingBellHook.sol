// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "@openzeppelin/uniswap-hooks/src/base/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {AuctionEngine} from "auction/AuctionEngine.sol";

/// @title ClearingBellHook
/// @notice Uniswap v4 hook that intercepts swaps on a bond-token/USDC pool and routes them
///         into the AuctionEngine's current open batch-auction round instead of executing
///         them instantly.
///
/// @dev Per PLAN.md §4.5 and ARCHITECTURE.md §Uniswap v4 Integration:
///
///      beforeSwap flow:
///        1. Check ComplianceGate.isEligible(sender, bondToken).
///        2. Decode bid limit price from hookData.
///        3. Convert zeroForOne + amountSpecified → Bid{isBuy, quantity}.
///        4. Call AuctionEngine.submitBid() for the current active round.
///        5. Return ZERO_DELTA — the PoolManager records the swap attempt but the
///           pool has no liquidity (by design), so no tokens move through the AMM.
///           Actual settlement happens via AuctionEngine.closeAndClear().
///
///      afterSwap: emits permission bit for indexer extensibility.
///      afterEpochClose: called by the issuer after AuctionEngine.closeAndClear();
///                       updates the pool's last observed clearing price.
///
///      Hook permissions: beforeSwap = true, afterSwap = true.
///
/// References:
///   - PLAN.md §4.5 ClearingBellHook.sol
///   - ARCHITECTURE.md §Uniswap v4 Integration
///   - citations.md → OpenZeppelin uniswap-hooks, Uniswap/v4-core
contract ClearingBellHook is BaseHook {
    // =========================================================================
    // State
    // =========================================================================

    /// @notice The auction engine this hook routes orders into.
    AuctionEngine public immutable auctionEngine;

    /// @notice Maps bond token address → the currently active AuctionEngine round ID.
    /// @dev Set by the issuer via setActiveRound() before opening each round.
    mapping(address => uint256) public activeRound;

    /// @notice Last confirmed clearing price per bond token (updated in afterEpochClose).
    mapping(address => uint256) public lastClearingPrice;

    // =========================================================================
    // Events
    // =========================================================================

    /// @notice Emitted when a swap is intercepted and queued as a bid.
    event BidQueued(
        address indexed bondToken,
        uint256 indexed roundId,
        address indexed bidder,
        uint256 price,
        uint256 quantity,
        bool isBuy
    );

    /// @notice Emitted after AuctionEngine.closeAndClear() is signalled to the hook.
    event ClearingPriceUpdated(
        address indexed bondToken,
        uint256 indexed roundId,
        uint256 clearingPrice
    );

    // =========================================================================
    // Errors
    // =========================================================================

    error BidderNotEligible(address bidder);
    error NoActiveRound(address bondToken);
    error InvalidHookData();
    error NotIssuer();
    error ZeroQuantity();

    // =========================================================================
    // Constructor
    // =========================================================================

    constructor(IPoolManager _poolManager, AuctionEngine _auctionEngine) BaseHook(_poolManager) {
        auctionEngine = _auctionEngine;
    }

    // =========================================================================
    // Hook permissions (PLAN §4.5 / ARCHITECTURE.md)
    // =========================================================================

    /// @inheritdoc BaseHook
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,           // intercept every swap → queue as bid
            afterSwap: true,            // emit indexer events post-swap
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false, // we return ZERO_DELTA (no custom token accounting)
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // =========================================================================
    // beforeSwap — queue the order as a bid (PLAN §4.5 step 1–4)
    // =========================================================================

    /// @dev Called by PoolManager before every swap on a pool using this hook.
    ///
    ///      hookData encoding: abi.encode(uint256 limitPrice)
    ///        limitPrice: the bidder's price limit in settlement-token units per bond token.
    ///
    ///      Direction mapping (ARCHITECTURE.md §Uniswap v4 Integration):
    ///        zeroForOne = true  → selling token0 (bond) → sell order (isBuy = false)
    ///        zeroForOne = false → buying token0 (bond)  → buy order  (isBuy = true)
    ///
    ///      Returns ZERO_DELTA: order is queued for the batch auction, not filled instantly.
    function _beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    ) internal override returns (bytes4, BeforeSwapDelta, uint24) {
        // --- Step 1: Decode limit price from hookData ---
        if (hookData.length < 32) revert InvalidHookData();
        uint256 limitPrice = abi.decode(hookData, (uint256));

        // --- Step 2: Identify the bond token (always token0 by convention) ---
        address bondToken = Currency.unwrap(key.currency0);

        // --- Step 3: Compliance check (PLAN §4.5 / ARCHITECTURE.md §Security Model) ---
        if (!auctionEngine.complianceGate().isEligible(sender, bondToken)) {
            revert BidderNotEligible(sender);
        }

        // --- Step 4: Resolve active round ---
        uint256 roundId = activeRound[bondToken];
        if (roundId == 0) revert NoActiveRound(bondToken);

        // --- Step 5: Convert swap params → Bid direction and quantity ---
        // zeroForOne = true  → selling bond (token0) → isBuy = false
        // zeroForOne = false → buying  bond (token0) → isBuy = true
        bool isBuy = !params.zeroForOne;

        // amountSpecified < 0 = exact-input; > 0 = exact-output. Use absolute value.
        uint256 quantity = params.amountSpecified < 0
            ? uint256(-params.amountSpecified)
            : uint256(params.amountSpecified);
        if (quantity == 0) revert ZeroQuantity();

        // --- Step 6: Submit bid to AuctionEngine on behalf of the swap sender ---
        // The swap `sender` is the real bidder (they provide funds and are KYC-checked);
        // this hook is an issuer-authorized bid relayer.
        auctionEngine.submitBidFor(sender, roundId, limitPrice, quantity, isBuy);

        emit BidQueued(bondToken, roundId, sender, limitPrice, quantity, isBuy);

        // --- Step 7: Return ZERO_DELTA — order queued, no instant fill ---
        return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    // =========================================================================
    // afterSwap — post-trade indexer hook (ARCHITECTURE.md: "afterSwap = true")
    // =========================================================================

    /// @dev No-op implementation — the afterSwap permission bit is set to enable
    ///      future indexer event emission for price updates. Returns the selector
    ///      and zero delta per the BaseHook interface requirement.
    function _afterSwap(
        address, /* sender */
        PoolKey calldata, /* key */
        SwapParams calldata, /* params */
        BalanceDelta, /* delta */
        bytes calldata /* hookData */
    ) internal pure override returns (bytes4, int128) {
        return (BaseHook.afterSwap.selector, 0);
    }

    // =========================================================================
    // afterEpochClose — sync clearing price (PLAN §4.5)
    // =========================================================================

    /// @notice Called by the issuer after AuctionEngine.closeAndClear() completes.
    ///         Reads the clearing price from the engine and stores it for oracle queries.
    /// @dev Corresponds to: "Updates pool state / reported price to reflect clearing price"
    ///      per PLAN.md §4.5.
    /// @param roundId   The auction round that just cleared.
    /// @param bondToken The bond token address for this pool.
    function afterEpochClose(uint256 roundId, address bondToken) external {
        if (msg.sender != auctionEngine.issuer()) revert NotIssuer();

        // Read the clearing price from the engine's round storage.
        (, , , , , uint256 clearingPrice, ,) = auctionEngine.rounds(roundId);

        lastClearingPrice[bondToken] = clearingPrice;

        emit ClearingPriceUpdated(bondToken, roundId, clearingPrice);
    }

    // =========================================================================
    // Admin
    // =========================================================================

    /// @notice Register the active AuctionEngine round for a bond token pool.
    /// @dev Called by the issuer immediately after AuctionEngine.openRound().
    function setActiveRound(address bondToken, uint256 roundId) external {
        if (msg.sender != auctionEngine.issuer()) revert NotIssuer();
        activeRound[bondToken] = roundId;
    }
}
