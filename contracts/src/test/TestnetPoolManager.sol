// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @title TestnetPoolManager
/// @notice Minimal stand-in for the Uniswap v4 PoolManager on Hedera testnet.
///         Uniswap v4 is NOT deployed on Hedera (chain 296).
///
///         ClearingBellHook's onlyPoolManager gate checks:
///             msg.sender == address(poolManager)
///         This contract satisfies that check when it calls beforeSwap/afterSwap
///         on the hook, letting us drive the full hook flow from an EOA via TypeScript.
///
///         This is the same architecture used in HookTest.s.sol — extracted into
///         a standalone file so it compiles without the solmate dependency in the forge scripts.
contract TestnetPoolManager {

    /// @notice Forward a beforeSwap call to the hook.
    ///         msg.sender in the hook will be address(this) == the configured poolManager.
    function dispatchBeforeSwap(
        address hookAddr,
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    ) external returns (bytes4 selector, int128 delta, uint24 fee) {
        (bytes4 sel, BeforeSwapDelta d, uint24 f) =
            IHooks(hookAddr).beforeSwap(sender, key, params, hookData);
        return (sel, int128(BeforeSwapDelta.unwrap(d)), f);
    }

    /// @notice Forward an afterSwap call to the hook.
    function dispatchAfterSwap(
        address hookAddr,
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    ) external returns (bytes4 selector, int128 delta) {
        BalanceDelta d = BalanceDelta.wrap(0);
        return IHooks(hookAddr).afterSwap(sender, key, params, d, hookData);
    }
}
