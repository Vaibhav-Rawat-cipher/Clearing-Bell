// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title MockPoolManager
/// @notice Lightweight test fixture standing in for the Uniswap v4 PoolManager.
///
/// @dev The `ClearingBellHook` does not make any external calls to the pool
///      manager inside `_beforeSwap` / `_afterSwap` — it only uses the pool
///      manager address as the `onlyPoolManager()` access-control gate (and for
///      the `BaseHook` constructor). A bare deployed contract is therefore the
///      minimal honest surface needed to unit-test the hook in isolation, per the
///      approach documented in docs/FEEDBACK.md (lightweight MockPoolManager).
contract MockPoolManager {
    error MockPoolManager__NotImplemented();
}
