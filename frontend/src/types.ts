export type View = 'home' | 'markets' | 'auction' | 'portfolio' | 'issuer'

export type IdentityState = 'guest' | 'verified' | 'restricted'

export type AuctionPhase = 'commit' | 'reveal' | 'clear' | 'settle'

export type OrderSide = 'BUY' | 'SELL'

export type Notice = {
  title: string
  body: string
  tone?: 'success' | 'danger' | 'neutral'
} | null

export type DemoOrder = {
  side: OrderSide
  price: string
  quantity: string
}

export type Address = `0x${string}`
export type Hash = `0x${string}`

export type DeploymentConfig = {
  version: number
  network: string
  chainId: number
  rpcUrl: string
  deploymentBlock: number
  explorerUrl?: string
  contracts: {
    auctionEngine: Address
    complianceGate?: Address
    identityRegistry?: Address
    bondToken?: Address
    settlementToken?: Address
  }
  accounts: { address: Address; label: string; role: string }[]
  bond?: { name: string; symbol: string; decimals: number; couponBps?: number; maturity?: string }
  settlement?: { symbol: string; decimals: number }
}

export type TokenMetadata = {
  address: Address
  name: string
  symbol: string
  decimals: number
}

export type LiveBid = {
  bidder: Address
  price: string
  quantity: string
  isBuy: boolean
  index: string
  priceRaw: bigint
  quantityRaw: bigint
}

export type LiveRound = {
  id: string
  bondToken: Address
  settlementToken: Address
  bond: TokenMetadata
  settlement: TokenMetadata
  deadline: number
  phase: 'open' | 'closed' | 'clearing'
  clearingPrice: string
  clearedQuantity: string
  clearingPriceRaw: bigint
  clearedQuantityRaw: bigint
  bidCount: number
  bids: LiveBid[]
}

export type TokenHolding = TokenMetadata & {
  balance: string
  balanceRaw: bigint
  allowance: string
  allowanceRaw: bigint
  kind: 'bond' | 'settlement'
}

export type Settlement = {
  id: string
  roundId: string
  bidder: Address
  quantity: string
  price: string
  isBuy: boolean
  transactionHash: Hash
  blockNumber: string
  bondSymbol: string
  settlementSymbol: string
}

export type PendingTransaction = {
  label: string
  stage: 'signature' | 'confirming'
  hash?: Hash
}

export type OpenRoundInput = {
  bondToken: string
  settlementToken: string
  bidWindowSeconds: number
}
