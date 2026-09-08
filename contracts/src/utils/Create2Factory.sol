// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title Create2Factory
/// @notice Minimal CREATE2 deployer for use on chains without a pre-deployed
///         deterministic deployer (e.g. Hedera Testnet).
///         Compatible with the Uniswap v4 HookMiner flow.
contract Create2Factory {
    event Deployed(address indexed deployed, bytes32 indexed salt);

    error DeployFailed();

    /// @notice Deploy a contract using CREATE2.
    /// @param salt   32-byte salt for address derivation
    /// @param code   Full init bytecode (including ABI-encoded constructor args)
    /// @return addr  The deployed contract address
    function deploy(bytes32 salt, bytes memory code) external returns (address addr) {
        assembly {
            addr := create2(0, add(code, 0x20), mload(code), salt)
        }
        if (addr == address(0)) revert DeployFailed();
        emit Deployed(addr, salt);
    }

    /// @notice Pre-compute the address that CREATE2 will produce.
    function computeAddress(bytes32 salt, bytes32 initCodeHash) external view returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)
                    )
                )
            )
        );
    }
}
