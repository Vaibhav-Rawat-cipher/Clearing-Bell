// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IBondFacade {
    function grantRole(bytes32 role, address account) external;
    function addAgent(address agent) external;
}

interface IATSIdentityRegistry {
    function registerIdentity(
        address userAddress,
        address identity,
        uint16 country
    ) external;
    function isVerified(address userAddress) external view returns (bool);
}

interface IAuctionEngine {
    function platformAdmin() external view returns (address);
    function bondIssuers(address bondToken) external view returns (address);
}

contract BondConfig {
    string public constant BOND_NAME = "Clearing Bell Bond 2028";
    string public constant BOND_SYMBOL = "CBB28";
    uint256 public constant COUPON_RATE_BPS = 550; // 5.50%
    uint256 public constant MATURITY_DATE = 1861862400; // 2028-12-31 00:00:00 UTC
    uint256 public constant TOTAL_SUPPLY = 1_000_000 * 1e18;
    uint256 public constant MAX_HOLDERS = 1000;

    struct BondDetails {
        address identityRegistry;
        address complianceGate;
        address auctionEngine;
        address clearingBellHook;
        address settlementToken;
    }

    mapping(address => BondDetails) public bondConfigs;
    address public deployer;

    event BondConfigured(
        address indexed bondToken,
        address indexed identityRegistry,
        address complianceGate,
        address auctionEngine,
        address settlementToken
    );

    event KycApproved(address indexed investor, uint256 timestamp);

    error NotAuthorized();

    constructor() {
        deployer = msg.sender;
    }

    function configure(
        address _bondToken,
        address _identityRegistry,
        address _complianceGate,
        address _auctionEngine,
        address _settlementToken
    ) external {
        address platformAdmin = IAuctionEngine(_auctionEngine).platformAdmin();
        address issuer = IAuctionEngine(_auctionEngine).bondIssuers(_bondToken);
        if (msg.sender != platformAdmin && msg.sender != issuer) revert NotAuthorized();

        bondConfigs[_bondToken] = BondDetails({
            identityRegistry: _identityRegistry,
            complianceGate: _complianceGate,
            auctionEngine: _auctionEngine,
            clearingBellHook: address(0),
            settlementToken: _settlementToken
        });

        emit BondConfigured(
            _bondToken,
            _identityRegistry,
            _complianceGate,
            _auctionEngine,
            _settlementToken
        );
    }

    function setHook(address _bondToken, address _hook) external {
        address engine = bondConfigs[_bondToken].auctionEngine;
        if (engine == address(0)) revert NotAuthorized();
        
        address platformAdmin = IAuctionEngine(engine).platformAdmin();
        address issuer = IAuctionEngine(engine).bondIssuers(_bondToken);
        if (msg.sender != platformAdmin && msg.sender != issuer) revert NotAuthorized();

        bondConfigs[_bondToken].clearingBellHook = _hook;
    }

    function getDeployment(address _bondToken)
        external
        view
        returns (
            address bondToken,
            address _identityRegistry,
            address _complianceGate,
            address _auctionEngine,
            address _clearingBellHook,
            address _settlementToken
        )
    {
        BondDetails memory d = bondConfigs[_bondToken];
        return (
            _bondToken,
            d.identityRegistry,
            d.complianceGate,
            d.auctionEngine,
            d.clearingBellHook,
            d.settlementToken
        );
    }

    function isInvestorKycd(address investor, address _bondToken) external view returns (bool) {
        address registry = bondConfigs[_bondToken].identityRegistry;
        if (registry == address(0)) return false;
        return IATSIdentityRegistry(registry).isVerified(investor);
    }
}
