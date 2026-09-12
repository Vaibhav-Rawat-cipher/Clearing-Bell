import { parseAbi } from 'viem'

// These signatures match contracts/src/auction/AuctionEngine.sol. Orders are public.
export const auctionAbi = parseAbi([
  // ── Read ──────────────────────────────────────────────────────────────────
  'function nextRoundId() view returns (uint256)',
  'function rounds(uint256) view returns (uint256 id, address bondToken, address settlementToken, uint256 openDeadline, uint8 phase, uint256 clearingPrice, uint256 clearedQuantity, uint256 bidCount)',
  'function getRoundBids(uint256 roundId) view returns ((address bidder, uint256 price, uint256 quantity, bool isBuy, uint256 index)[])',
  'function complianceGate() view returns (address)',
  // Multi-issuer: platform admin + per-bond issuer
  'function platformAdmin() view returns (address)',
  'function bondIssuers(address bondToken) view returns (address)',
  'function bondPaused(address bondToken) view returns (bool)',
  'function paused() view returns (bool)',
  // ── Write ─────────────────────────────────────────────────────────────────
  'function submitBid(uint256 roundId, uint256 price, uint256 quantity, bool isBuy)',
  'function closeAndClear(uint256 roundId)',
  'function openRound(address bondToken, address settlementToken, uint256 bidWindow) returns (uint256 roundId)',
  // Platform admin actions
  'function registerBondIssuer(address bondToken, address company)',
  'function transferPlatformAdmin(address newAdmin)',
  'function pause()',
  'function unpause()',
  // Bond issuer actions
  'function pauseBond(address bondToken)',
  'function unpauseBond(address bondToken)',
  // ── Events ────────────────────────────────────────────────────────────────
  'event Settled(uint256 indexed roundId, address indexed bidder, uint256 filledQuantity, uint256 settledPrice, bool isBuy)',
  'event BondIssuerRegistered(address indexed bondToken, address indexed issuer)',
  'event PlatformAdminTransferred(address indexed oldAdmin, address indexed newAdmin)',
  'event BondPauseChanged(address indexed bondToken, bool paused)',
  // ── Errors ────────────────────────────────────────────────────────────────
  'error NotPlatformAdmin()',
  'error NotBondIssuer(address bondToken)',
  'error BondNotRegistered(address bondToken)',
  'error BondRoundsPaused(address bondToken)',
  'error RoundNotOpen(uint256 roundId)',
  'error RoundStillOpen(uint256 roundId)',
  'error RoundAlreadyCleared(uint256 roundId)',
  'error BidWindowClosed(uint256 roundId)',
  'error BidderNotEligible(address bidder)',
  'error InvalidBidPrice()',
  'error InvalidBidQuantity()',
  'error ZeroAddress()',
  'error EnforcedPause()',
  'error ExpectedPause()',
  'error SafeERC20FailedOperation(address token)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
])

export const tokenAbi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

export const gateAbi = parseAbi([
  'function isEligible(address bidder, address bondToken) view returns (bool)',
  'function identityRegistry(address bondToken) view returns (address)',
  'function registerRegistry(address bondToken, address registry) external',
  'error RegistryNotSet(address bondToken)',
])
