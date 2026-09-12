// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {AuctionEngine} from "../auction/AuctionEngine.sol";
import {ClearingBellHook} from "./ClearingBellHook.sol";

/// @title HookDeployer
/// @notice A lightweight factory to deploy the ClearingBellHook using CREATE2.
/// @dev Exposes deployHook to allow off-chain salt mining for valid Uniswap v4 hook addresses.
contract HookDeployer {
    /// @notice Deploys the ClearingBellHook with the specified salt.
    /// @param poolManager The Uniswap v4 PoolManager.
    /// @param auctionEngine The Clearing Bell AuctionEngine.
    /// @param salt The CREATE2 salt (mined off-chain to match hook flags).
    /// @return hook The deployed ClearingBellHook.
    function deployHook(
        IPoolManager poolManager,
        AuctionEngine auctionEngine,
        bytes32 salt
    ) external returns (ClearingBellHook hook) {
        hook = new ClearingBellHook{salt: salt}(poolManager, auctionEngine);
    }

    /// @notice Returns the init code hash used for CREATE2 address computation
    function getInitCodeHash(
        IPoolManager poolManager,
        AuctionEngine auctionEngine
    ) external pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                type(ClearingBellHook).creationCode,
                abi.encode(poolManager, auctionEngine)
            )
        );
    }
}
