// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IIdentityRegistry
/// @notice Minimal interface for Hedera ATS identity registry.
///         This is a subset of the full ERC-3643 identity registry interface.
interface IIdentityRegistry {
    function isVerified(address userAddress) external view returns (bool);
    function registrationDateOf(address userAddress) external view returns (uint256);
}

interface IAuctionEngine {
    function platformAdmin() external view returns (address);
    function bondIssuers(address bondToken) external view returns (address);
}

/// @title ComplianceGate
/// @notice Lightweight wrapper that checks whether a given address is KYC-approved
///         for trading a specific bond token, by querying the ATS identity registry.
///
/// @dev This contract does NOT store any KYC data — it only reads from the ATS registry.
///      This is intentional: single source of truth, no data duplication.
///
///      Used by AuctionEngine to gate bid submission and re-checked at settlement.
///
/// @custom:security-contact security@clearingbell.xyz
contract ComplianceGate {
    // =========================================================================
    // State
    // =========================================================================

    /// @notice Maps bondToken address → its ATS identity registry address.
    mapping(address => address) public identityRegistry;

    /// @notice Registry admin — can still register new bonds if needed.
    address public deployer;

    /// @notice The central AuctionEngine used for RBAC checks.
    IAuctionEngine public auctionEngine;

    // =========================================================================
    // Events
    // =========================================================================

    event RegistryRegistered(address indexed bondToken, address indexed registry);

    // =========================================================================
    // Errors
    // =========================================================================

    error RegistryNotSet(address bondToken);
    error NotAuthorized();
    error EngineNotSet();
    error AlreadySet();

    // =========================================================================
    // Constructor
    // =========================================================================

    constructor() {
        deployer = msg.sender;
    }

    // =========================================================================
    // Registry Registration
    // =========================================================================

    /// @notice Set the central AuctionEngine address for RBAC.
    /// @dev Called once by the deployer after the engine is deployed.
    function setAuctionEngine(address _engine) external {
        if (msg.sender != deployer) revert NotAuthorized();
        if (address(auctionEngine) != address(0)) revert AlreadySet();
        auctionEngine = IAuctionEngine(_engine);
    }

    /// @notice Register the ATS identity registry address for a given bond token.
    /// @dev Only the platform admin or the registered bond issuer can call this.
    /// @param bondToken The ERC-3643 bond token contract address.
    /// @param registry  The ATS identity registry contract address.
    function registerRegistry(address bondToken, address registry) external {
        if (address(auctionEngine) == address(0)) revert EngineNotSet();
        
        address admin = auctionEngine.platformAdmin();
        address issuer = auctionEngine.bondIssuers(bondToken);
        if (msg.sender != admin && msg.sender != issuer) revert NotAuthorized();

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
