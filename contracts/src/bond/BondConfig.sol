// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IBondFacade
/// @notice Minimal interface for the Hedera ATS bond contract.
/// @dev These are the ATS functions we call during deployment and configuration.
///      Full ATS ABI lives in the SDK — this subset is what Clearing Bell uses.
interface IBondFacade {
    function grantRole(bytes32 role, address account) external;
    function addAgent(address agent) external;
}

/// @title IATSIdentityRegistry
/// @notice Minimal ATS identity registry interface used during seeding.
interface IATSIdentityRegistry {
    function registerIdentity(
        address userAddress,
        address identity,
        uint16 country
    ) external;
    function isVerified(address userAddress) external view returns (bool);
}

/// @title BondConfig
/// @notice Configuration and deployment helper for the Hedera ATS bond integration.
///
/// @dev This contract is NOT deployed on-chain — it is used as a Foundry script
///      base and as a reference for the TypeScript deploy scripts.
///
///      The actual bond token is deployed by the Hedera ATS SDK
///      (hashgraph/asset-tokenization-sdk). Once deployed, this contract
///      records the key addresses and wires ComplianceGate to the ATS registry.
///
///      ATS bond parameters for the demo:
///        - Name: "Clearing Bell Bond 2028"
///        - Symbol: "CBB28"
///        - Coupon rate: 5.50% annual (550 bps)
///        - Maturity: 2028-12-31
///        - Total supply: 1,000,000 tokens (1e24 base units)
///        - Settlement token: USDC on Hedera testnet
///
/// References:
///   - PLAN.md §4.1 BondConfig.sol
///   - docs.tokenization-studio.hedera.com/ats/creating-bond
///   - ARCHITECTURE.md §Hedera-specific Notes
contract BondConfig {
    // =========================================================================
    // Bond parameters (set at deployment, immutable after)
    // =========================================================================

    string public constant BOND_NAME = "Clearing Bell Bond 2028";
    string public constant BOND_SYMBOL = "CBB28";
    uint256 public constant COUPON_RATE_BPS = 550; // 5.50%
    uint256 public constant MATURITY_DATE = 1861862400; // 2028-12-31 00:00:00 UTC
    uint256 public constant TOTAL_SUPPLY = 1_000_000 * 1e18;
    uint256 public constant MAX_HOLDERS = 1000;

    // =========================================================================
    // Deployed addresses (filled in by deploy scripts)
    // =========================================================================

    /// @notice The ATS-deployed ERC-3643 bond token address.
    address public bondToken;

    /// @notice The ATS identity registry for this bond.
    address public identityRegistry;

    /// @notice The ComplianceGate contract wired to identityRegistry.
    address public complianceGate;

    /// @notice The AuctionEngine contract.
    address public auctionEngine;

    /// @notice The ClearingBellHook contract.
    address public clearingBellHook;

    /// @notice The settlement token (USDC on Hedera testnet).
    address public settlementToken;

    /// @notice Owner/deployer
    address public deployer;

    // =========================================================================
    // Events
    // =========================================================================

    event BondConfigured(
        address indexed bondToken,
        address indexed identityRegistry,
        address complianceGate,
        address auctionEngine,
        address settlementToken
    );

    event KycApproved(address indexed investor, uint256 timestamp);

    // =========================================================================
    // Constructor
    // =========================================================================

    constructor() {
        deployer = msg.sender;
    }

    // =========================================================================
    // Configuration
    // =========================================================================

    modifier onlyDeployer() {
        require(msg.sender == deployer, "BondConfig: not deployer");
        _;
    }

    /// @notice Record all deployed addresses after the SDK has deployed the bond.
    /// @dev Called once after `deploy-bond.ts` finishes. Provides a single
    ///      on-chain source of truth for the full deployment configuration.
    function configure(
        address _bondToken,
        address _identityRegistry,
        address _complianceGate,
        address _auctionEngine,
        address _settlementToken
    ) external onlyDeployer {
        bondToken = _bondToken;
        identityRegistry = _identityRegistry;
        complianceGate = _complianceGate;
        auctionEngine = _auctionEngine;
        settlementToken = _settlementToken;

        emit BondConfigured(
            _bondToken,
            _identityRegistry,
            _complianceGate,
            _auctionEngine,
            _settlementToken
        );
    }

    /// @notice Set the deployed hook address (done after CREATE2 deploy).
    function setHook(address _hook) external onlyDeployer {
        clearingBellHook = _hook;
    }

    // =========================================================================
    // View helpers (used by frontend / scripts)
    // =========================================================================

    /// @notice Returns all key deployment addresses in one call.
    function getDeployment()
        external
        view
        returns (
            address _bondToken,
            address _identityRegistry,
            address _complianceGate,
            address _auctionEngine,
            address _clearingBellHook,
            address _settlementToken
        )
    {
        return (
            bondToken,
            identityRegistry,
            complianceGate,
            auctionEngine,
            clearingBellHook,
            settlementToken
        );
    }

    /// @notice Quick eligibility check for a given investor address.
    function isInvestorKycd(address investor) external view returns (bool) {
        if (identityRegistry == address(0)) return false;
        return IATSIdentityRegistry(identityRegistry).isVerified(investor);
    }
}
