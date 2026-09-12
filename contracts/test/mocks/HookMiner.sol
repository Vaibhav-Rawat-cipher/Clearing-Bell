// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title HookMiner
/// @notice Mines a CREATE2 salt such that the deployed hook address encodes
///         the given permission flags in its low 14 bits (bits 0–13).
///
/// @dev Copied and adapted from uniswap/v4-periphery (MIT).
///      Included inline to avoid pulling in the full v4-periphery dependency
///      for a single utility file. Keep in sync with upstream if upgrading.
///
/// Source: https://github.com/Uniswap/v4-periphery/blob/main/src/utils/HookMiner.sol
library HookMiner {
    // Mask for the lower 14 bits (where permission flags live)
    uint160 internal constant FLAG_MASK = uint160((1 << 14) - 1);

    /// @notice Find a salt such that:
    ///         keccak256(deployer ++ salt ++ initCodeHash)[12:] & FLAG_MASK == flags
    /// @param deployer     The address that will call CREATE2.
    /// @param flags        Required flag bits in the hook address.
    /// @param creationCode The hook's creation bytecode.
    /// @param constructorArgs ABI-encoded constructor arguments.
    /// @return hookAddress The address where the hook will be deployed.
    /// @return salt        The salt to pass to CREATE2.
    function find(
        address deployer,
        uint160 flags,
        bytes memory creationCode,
        bytes memory constructorArgs
    ) internal pure returns (address hookAddress, bytes32 salt) {
        bytes memory initCode = abi.encodePacked(creationCode, constructorArgs);
        bytes32 initCodeHash = keccak256(initCode);

        for (uint256 i = 0; i < 100_000; i++) {
            salt = bytes32(i);
            hookAddress = computeAddress(deployer, salt, initCodeHash);
            if (uint160(hookAddress) & FLAG_MASK == flags) {
                return (hookAddress, salt);
            }
        }
        revert("HookMiner: could not find salt");
    }

    /// @notice Compute the CREATE2 address given deployer, salt, and initCodeHash.
    function computeAddress(address deployer, bytes32 salt, bytes32 initCodeHash)
        internal
        pure
        returns (address)
    {
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)
                    )
                )
            )
        );
    }
}
