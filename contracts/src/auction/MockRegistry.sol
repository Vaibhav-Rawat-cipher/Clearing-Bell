// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

contract MockIdentityRegistry {
    function isVerified(address) external pure returns (bool) {
        return true;
    }
    function registrationDateOf(address) external view returns (uint256) {
        return block.timestamp;
    }
}
