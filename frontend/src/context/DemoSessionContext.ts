import { createContext, useContext } from 'react'
import type { Address, DemoOrder, DeploymentConfig, Hash, IdentityState, LiveBid, LiveRound, Notice, OpenRoundInput, OrderSide, PendingTransaction, Settlement, TokenHolding } from '../types'

export type DemoSessionValue = {
  order: DemoOrder
  config: DeploymentConfig | null
  connectionStatus: 'loading' | 'ready' | 'error'
  error: string | null
  refreshing: boolean
  account: Address | null
  walletChainId: number | null
  walletMode: 'injected' | 'local' | null
  walletRestoring: boolean
  walletStatus: 'disconnected' | 'restoring' | 'connected' | 'unavailable'
  walletError: string | null
  localAccounts: Address[]
  rounds: LiveRound[]
  selectedRound: LiveRound | null
  bids: LiveBid[]
  tokens: TokenHolding[]
  settlements: Settlement[]
  /** Backward-compatible alias for bondIssuer — the issuer for the selected round's bond. */
  issuer: Address | null
  /** Clearing Bell platform admin address. */
  platformAdmin: Address | null
  isIssuer: boolean
  /** True if the connected wallet is the Clearing Bell platform admin. */
  isPlatformAdmin: boolean
  /** The registered issuer wallet for the currently selected round's bond token (null if no round). */
  bondIssuer: Address | null
  paused: boolean
  eligibility: boolean | null
  eligibilityError: string | null
  balances: { bond: string; settlement: string; bondAllowance: string; settlementAllowance: string } | null
  pendingTx: PendingTransaction | null
  lastTxHash: Hash | null
  historyError: string | null
  historyFromBlock: string | null
  roundsTruncated: boolean
  blockNumber: string | null
  chainTimestamp: number | null
  identity: IdentityState
  identityDialogOpen: boolean
  notice: Notice
  openIdentityDialog: () => void
  closeIdentityDialog: () => void
  updateOrder: (patch: Partial<DemoOrder>) => void
  setOrderSide: (side: OrderSide) => void
  connectWallet: () => Promise<void>
  retryWalletConnection: () => Promise<void>
  switchNetwork: () => Promise<void>
  connectLocalAccount: (address?: Address) => Promise<void>
  disconnect: () => void
  selectRound: (id: string) => void
  refresh: () => Promise<void>
  approveOrder: () => Promise<boolean>
  submitOrder: () => Promise<boolean>
  closeRound: (id?: string) => Promise<boolean>
  openRound: (input: OpenRoundInput) => Promise<boolean>
  setPaused: (paused: boolean) => Promise<boolean>
  showNotice: (notice: NonNullable<Notice>) => void
  dismissNotice: () => void
}

export const DemoSessionContext = createContext<DemoSessionValue | null>(null)

export function useDemoSession() {
  const value = useContext(DemoSessionContext)
  if (!value) throw new Error('useDemoSession must be used within DemoSessionProvider')
  return value
}
