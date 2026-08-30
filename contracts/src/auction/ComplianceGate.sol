// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IIdentityRegistry
/// @notice Minimal interface for Hedera ATS identity registry.
///         This is a subset of the full ERC-3643 identity registry interface.
interface IIdentityRegistry {
    function isVerified(address userAddress) external view returns (bool);
    function registrationDateOf(address userAddress) external view returns (uint256);
}

/// @title ComplianceGate
/// @notice Lightweight wrapper that checks whether a given address is KYC-approved
///         for trading a specific bond token, by querying the ATS identity registry.
///
/// @dev This contract does NOT store any KYC data — it only reads from the ATS registry.
///      This is intentional: single source of truth, no data duplication.
///
///      Used by AuctionEngine to gate bid submission and re-checked at settlement.
contract ComplianceGate {
    // =========================================================================
    // State
    // =========================================================================

    /// @notice Maps bondToken address → its ATS identity registry address.
    mapping(address => address) public identityRegistry;

    /// @notice Owner/admin who can register new bond token registries.
    address public owner;

    // =========================================================================
    // Events
    // =========================================================================

    event RegistryRegistered(address indexed bondToken, address indexed registry);

    // =========================================================================
    // Errors
    // =========================================================================

    error NotOwner();
    error RegistryNotSet(address bondToken);

    // =========================================================================
    // Constructor
    // =========================================================================

    constructor() {
        owner = msg.sender;
    }

    // =========================================================================
    // Admin
    // =========================================================================

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Register the ATS identity registry address for a given bond token.
    /// @dev Called once after deploying a new bond via ATS. The registry address
    ///      comes from the ATS deployment output.
    function registerRegistry(address bondToken, address registry) external onlyOwner {
        identityRegistry[bondToken] = registry;
        emit RegistryRegistered(bondToken, registry);
    }

    // =========================================================================
    // Core
    // =========================================================================

    /// @notice Check if a bidder is KYC-approved to trade a specific bond.
    /// @param bidder    The wallet address to check.
    /// @param bondToken The bond token contract address.
    /// @return eligible True if the bidder is on the ATS identity registry.
    function isEligible(address bidder, address bondToken) external view returns (bool eligible) {
        address registry = identityRegistry[bondToken];
        if (registry == address(0)) revert RegistryNotSet(bondToken);
        return IIdentityRegistry(registry).isVerified(bidder);
    }

    /// @notice Returns when a bidder was added to the identity registry.
    /// @dev Useful for audit trails and compliance reporting.
    function eligibilityCheckedAt(address bidder, address bondToken)
        external
        view
        returns (uint256 timestamp)
    {
        address registry = identityRegistry[bondToken];
        if (registry == address(0)) revert RegistryNotSet(bondToken);
        return IIdentityRegistry(registry).registrationDateOf(bidder);
    }
}
