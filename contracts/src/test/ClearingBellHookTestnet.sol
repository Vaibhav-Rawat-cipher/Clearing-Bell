// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {AuctionEngine} from "auction/AuctionEngine.sol";

/// @title ClearingBellHookTestnet
/// @notice Testnet-only standalone hook with IDENTICAL logic to ClearingBellHook,
///         but WITHOUT the BaseHook base class.
///
///         Problem: BaseHook's constructor calls _validateHookAddress() which checks
///         that the deployed contract address encodes the permission bits
///         (BEFORE_SWAP_FLAG | AFTER_SWAP_FLAG = 0xC0). On Hedera testnet, the
///         JSON-RPC relay's CREATE2 address computation differs from viem's
///         getCreate2Address(), so the mined salt produces the right TypeScript
///         address but Hedera assigns a different on-chain address → constructor reverts.
///
///         Solution: Implement the hook interface directly (IHooks) without BaseHook.
///         _validateHookAddress is never called, so any address works.
///
///         All logic is IDENTICAL to ClearingBellHook:
///         - onlyPoolManager access control
///         - beforeSwap → ComplianceGate check → submitBidFor
///         - afterSwap → no-op (indexer ready)
///         - afterEpochClose → lastClearingPrice sync
///         - setActiveRound admin
///
///         This contract is ONLY for testnet demo. Production uses the
///         real ClearingBellHook deployed via CREATE2 on a chain where
///         Uniswap v4 is deployed.
contract ClearingBellHookTestnet is IHooks {

    // =========================================================================
    // State
    // =========================================================================

    IPoolManager public immutable poolManager;
    AuctionEngine public immutable auctionEngine;

    mapping(address => uint256) public activeRound;
    mapping(address => uint256) public lastClearingPrice;

    // =========================================================================
    // Events
    // =========================================================================

    event BidQueued(
        address indexed bondToken,
        uint256 indexed roundId,
        address indexed bidder,
        uint256 price,
        uint256 quantity,
        bool isBuy
    );

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
    error NotBondIssuer(address bondToken);
    error ZeroQuantity();
    error NotPoolManager();

    // =========================================================================
    // Constructor
    // =========================================================================

    /// @dev No _validateHookAddress() — that's the entire point of this testnet variant.
    constructor(IPoolManager _poolManager, AuctionEngine _auctionEngine) {
        poolManager = _poolManager;
        auctionEngine = _auctionEngine;
    }

    // =========================================================================
    // Access control
    // =========================================================================

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    // =========================================================================
    // IHooks — stub all methods except beforeSwap / afterSwap
    // =========================================================================

    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        return IHooks.beforeInitialize.selector;
    }
    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        return IHooks.afterInitialize.selector;
    }
    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external pure returns (bytes4) { return IHooks.beforeAddLiquidity.selector; }
    function afterAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external pure returns (bytes4, BalanceDelta) { return (IHooks.afterAddLiquidity.selector, BalanceDelta.wrap(0)); }
    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external pure returns (bytes4) { return IHooks.beforeRemoveLiquidity.selector; }
    function afterRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external pure returns (bytes4, BalanceDelta) { return (IHooks.afterRemoveLiquidity.selector, BalanceDelta.wrap(0)); }
    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external pure returns (bytes4) { return IHooks.beforeDonate.selector; }
    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external pure returns (bytes4) { return IHooks.afterDonate.selector; }

    // =========================================================================
    // beforeSwap — identical logic to ClearingBellHook._beforeSwap
    // =========================================================================

    function beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    ) external onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        // Decode limit price
        if (hookData.length < 32) revert InvalidHookData();
        uint256 limitPrice = abi.decode(hookData, (uint256));

        // Bond token is always currency0 by convention
        address bondToken = Currency.unwrap(key.currency0);

        // KYC check via ComplianceGate
        if (!auctionEngine.complianceGate().isEligible(sender, bondToken)) {
            revert BidderNotEligible(sender);
        }

        // Active round check
        uint256 roundId = activeRound[bondToken];
        if (roundId == 0) revert NoActiveRound(bondToken);

        // Direction: zeroForOne=true → selling bond → isBuy=false
        bool isBuy = !params.zeroForOne;

        uint256 quantity = params.amountSpecified < 0
            ? uint256(-params.amountSpecified)
            : uint256(params.amountSpecified);
        if (quantity == 0) revert ZeroQuantity();

        // Submit bid via authorized relayer path
        auctionEngine.submitBidFor(sender, roundId, limitPrice, quantity, isBuy);

        emit BidQueued(bondToken, roundId, sender, limitPrice, quantity, isBuy);

        // ZERO_DELTA — order queued, no instant fill
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    // =========================================================================
    // afterSwap — no-op (indexer hook, no delta)
    // =========================================================================

    function afterSwap(
        address,
        PoolKey calldata,
        SwapParams calldata,
        BalanceDelta,
        bytes calldata
    ) external onlyPoolManager returns (bytes4, int128) {
        return (IHooks.afterSwap.selector, 0);
    }

    // =========================================================================
    // afterEpochClose — sync clearing price from engine to hook
    // =========================================================================

    function afterEpochClose(uint256 roundId, address bondToken) external {
        if (msg.sender != auctionEngine.bondIssuers(bondToken)) revert NotBondIssuer(bondToken);
        (, , , , , uint256 clearingPrice, ,) = auctionEngine.rounds(roundId);
        lastClearingPrice[bondToken] = clearingPrice;
        emit ClearingPriceUpdated(bondToken, roundId, clearingPrice);
    }

    // =========================================================================
    // Admin
    // =========================================================================

    function setActiveRound(address bondToken, uint256 roundId) external {
        if (msg.sender != auctionEngine.bondIssuers(bondToken)) revert NotBondIssuer(bondToken);
        activeRound[bondToken] = roundId;
    }

    // =========================================================================
    // getHookPermissions — for documentation / tooling
    // =========================================================================

    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }
}


/// @title ClearingBellHookTestnet
/// @notice Testnet-only variant of ClearingBellHook that bypasses the
///         BaseHook.validateHookAddress() constructor check.
///
///         Problem: On Hedera testnet, CREATE2 address derivation via the

