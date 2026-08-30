// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title MockIdentityRegistry
/// @notice Deterministic test fixture replicating the minimal ERC-3643 / ATS
///         identity-registry surface used by ComplianceGate:
///         `isVerified(userAddress)` and `registrationDateOf(userAddress)`.
///         Supports grant and revoke to test eligibility revocation mid-round.
contract MockIdentityRegistry {
    error MockIdentityRegistry__AlreadyVerified(address user);
    error MockIdentityRegistry__NotVerified(address user);

    struct Entry {
        uint256 registrationDate;
        bool verified;
    }

    mapping(address => Entry) internal _entries;
    uint256 internal _now;

    function _setNow(uint256 ts) internal {
        _now = ts;
    }

    function grant(address user) external {
        if (_entries[user].verified) revert MockIdentityRegistry__AlreadyVerified(user);
        _entries[user] = Entry({registrationDate: _now == 0 ? block.timestamp : _now, verified: true});
    }

    function grantAt(address user, uint256 timestamp) external {
        if (_entries[user].verified) revert MockIdentityRegistry__AlreadyVerified(user);
        _entries[user] = Entry({registrationDate: timestamp, verified: true});
    }

    function revoke(address user) external {
        if (!_entries[user].verified) revert MockIdentityRegistry__NotVerified(user);
        _entries[user].verified = false;
    }

    function isVerified(address user) external view returns (bool) {
        return _entries[user].verified;
    }

    function registrationDateOf(address user) external view returns (uint256) {
        return _entries[user].registrationDate;
    }
}
