import { getAddress, isAddress, keccak256, stringToHex } from 'viem'
import type { Address, DeploymentConfig } from '../types.ts'

export type WalletConnection = { account: Address; chainId: number; mode: 'local' | 'injected' }
export type WalletPreference = { version: 1; mode: WalletConnection['mode']; account: Address }
export type WalletSessionState = {
  connection: WalletConnection | null
  restoring: boolean
  status: 'disconnected' | 'restoring' | 'connected' | 'unavailable'
  error: string | null
}
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type SilentProvider = { request: (request: { method: 'eth_accounts' | 'eth_chainId' }) => Promise<unknown> }
type WalletSessionOptions = {
  config: DeploymentConfig
  storage: () => StorageLike | null
  provider: () => SilentProvider | undefined
  localAllowed: () => boolean
  localAccounts: () => Promise<readonly Address[]>
  localChainId: () => Promise<number>
  onChange: (state: WalletSessionState) => void
  timeoutMs?: number
}

export function walletSessionKey(config: DeploymentConfig): string {
  // Scope to the deployment, but do not copy an RPC URL/API credential into
  // localStorage. The stored value contains only the public address and mode.
  const scope = JSON.stringify([config.chainId, new URL(config.rpcUrl).href, config.contracts.auctionEngine.toLowerCase()])
  return `clearing-bell:wallet:v1:${keccak256(stringToHex(scope))}`
}

export function readWalletPreference(storage: StorageLike | null, key: string): WalletPreference | null {
  try {
    const raw = storage?.getItem(key)
    if (!raw) return null
    const value = JSON.parse(raw) as Record<string, unknown>
    if (!value || value.version !== 1 || (value.mode !== 'local' && value.mode !== 'injected') || typeof value.account !== 'string' || !isAddress(value.account)) return null
    return { version: 1, mode: value.mode, account: getAddress(value.account) }
  } catch { return null }
}

export function writeWalletPreference(storage: StorageLike | null, key: string, preference: WalletPreference | null): void {
  try {
    if (preference) storage?.setItem(key, JSON.stringify(preference))
    else {
      // Mark disconnected before removal so a failed remove cannot revive an
      // earlier preference. Invalid/non-preference entries never restore.
      try { storage?.setItem(key, '{"version":1,"disconnected":true}') } catch { /* Removal can still succeed. */ }
      storage?.removeItem(key)
    }
  } catch { /* Storage restrictions must never prevent wallet use or disconnect. */ }
}

export function walletConnectionsEqual(left: WalletConnection | null, right: WalletConnection | null): boolean {
  return left === right || Boolean(left && right && left.mode === right.mode && left.chainId === right.chainId && left.account.toLowerCase() === right.account.toLowerCase())
}

function chainIdFrom(value: unknown): number {
  if (typeof value !== 'string' || !/^0x[\da-f]+$/i.test(value)) throw new Error('The wallet returned an invalid chain ID.')
  const chainId = Number.parseInt(value, 16)
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('The wallet returned an invalid chain ID.')
  return chainId
}

function addressesFrom(value: unknown): Address[] {
  if (!Array.isArray(value) || value.some((address) => typeof address !== 'string' || !isAddress(address))) throw new Error('The wallet returned invalid account information.')
  return value.map((address) => getAddress(address))
}

async function withTimeout<T>(request: Promise<T>, duration: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('The wallet connection check timed out. Reopen your wallet or retry when the network is available.')), duration)
    })])
  } finally { clearTimeout(timer) }
}

// This coordinator stores reconnect intent separately from verified account
// state. A lost connection clears active data without erasing the user's choice.
export class WalletSessionManager {
  readonly key: string
  private readonly options: WalletSessionOptions
  private preference: WalletPreference | null
  private state: WalletSessionState = { connection: null, restoring: false, status: 'disconnected', error: null }
  private generation = 0
  private manualAction = false
  private manualMode: WalletConnection['mode'] | null = null
  private disposed = false
  private providerRevision = 0
  private connectionEpoch = 0

  constructor(options: WalletSessionOptions) {
    this.options = options
    this.key = walletSessionKey(options.config)
    this.preference = readWalletPreference(this.storage(), this.key)
  }

  private storage() {
    try { return this.options.storage() } catch { return null }
  }

  private emit(state: WalletSessionState) {
    if (!walletConnectionsEqual(this.state.connection, state.connection)) ++this.connectionEpoch
    this.state = state
    if (!this.disposed) this.options.onChange(state)
  }

  private remember(connection: WalletConnection) {
    this.preference = { version: 1, account: connection.account, mode: connection.mode }
    writeWalletPreference(this.storage(), this.key, this.preference)
  }

  private current(generation: number) { return !this.disposed && this.generation === generation }

  beginUserAction(mode: WalletConnection['mode']): number {
    ++this.connectionEpoch
    this.manualAction = true
    this.manualMode = mode
    const generation = ++this.generation
    this.emit({ ...this.state, restoring: true, status: 'restoring', error: null })
    return generation
  }

  isCurrentAction(generation: number): boolean { return this.current(generation) && this.manualAction }

  transactionGuard(connection: WalletConnection): () => void {
    const epoch = this.connectionEpoch
    const provider = this.options.provider()
    const assertCurrent = () => {
      if (this.disposed || this.manualAction || epoch !== this.connectionEpoch || !walletConnectionsEqual(connection, this.state.connection)
        || (connection.mode === 'injected' && (!provider || provider !== this.options.provider()))) {
        throw new Error('Your wallet connection changed. Review the transaction and try again.')
      }
    }
    assertCurrent()
    return assertCurrent
  }

  async confirmInjectedConnection(generation: number, expectedChainId?: number): Promise<WalletConnection | null> {
    // Account/chain events emitted by a permission request are normal. Recheck
    // after permission, and retry if either changes while that check is pending.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!this.isCurrentAction(generation)) return null
      const revision = this.providerRevision
      const provider = this.options.provider()
      if (!provider) throw new Error('Your browser wallet is unavailable. Reopen it and retry.')
      const [available, chain] = await withTimeout(Promise.all([
        provider.request({ method: 'eth_accounts' }),
        provider.request({ method: 'eth_chainId' }),
      ]), this.options.timeoutMs ?? 12_000)
      if (!this.isCurrentAction(generation)) return null
      if (revision !== this.providerRevision || provider !== this.options.provider()) continue
      const account = addressesFrom(available)[0]
      const chainId = chainIdFrom(chain)
      if (!account) throw new Error('Unlock your wallet or reconnect to grant account access.')
      if (expectedChainId !== undefined && chainId !== expectedChainId) throw new Error(`Select chain ${expectedChainId} in your wallet before continuing.`)
      const connection: WalletConnection = { account, chainId, mode: 'injected' }
      return this.acceptConnection(connection, generation) ? connection : null
    }
    throw new Error('Your wallet changed during connection. Let the account and network finish updating, then retry.')
  }

  acceptConnection(connection: WalletConnection, generation: number): boolean {
    if (!this.isCurrentAction(generation)) return false
    this.manualAction = false
    this.manualMode = null
    this.remember(connection)
    this.emit({ connection, restoring: false, status: 'connected', error: null })
    return true
  }

  rejectUserAction(generation: number, message: string): boolean {
    if (!this.isCurrentAction(generation)) return false
    this.manualAction = false
    this.manualMode = null
    this.emit({ ...this.state, restoring: false, status: this.state.connection ? 'connected' : this.preference ? 'unavailable' : 'disconnected', error: message })
    return true
  }

  async restore(preferFirstAccount = false): Promise<void> {
    if (this.disposed || this.manualAction) return
    const generation = ++this.generation
    const preference = this.preference
    if (!preference) {
      this.emit({ connection: null, restoring: false, status: 'disconnected', error: null })
      return
    }
    // Routine background checks do not replace a verified account with a
    // loading screen. Events invalidate it immediately; failed checks clear it.
    this.emit({ ...this.state, restoring: !this.state.connection, status: this.state.connection ? 'connected' : 'restoring', error: null })
    try {
      let accounts: Address[]
      let chainId: number
      if (preference.mode === 'local') {
        if (!this.options.localAllowed()) throw new Error('Saved test accounts are available only on the local development chain.')
        const [available, actualChain] = await withTimeout(Promise.all([this.options.localAccounts(), this.options.localChainId()]), this.options.timeoutMs ?? 12_000)
        accounts = addressesFrom(available)
        chainId = actualChain
        if (chainId !== 31337 || chainId !== this.options.config.chainId) throw new Error('The local RPC does not match the saved test network. Restart the local stack or reconnect.')
      } else {
        const provider = this.options.provider()
        if (!provider) throw new Error('Your browser wallet is unavailable. Open or unlock it to restore your connection.')
        const [available, chain] = await withTimeout(Promise.all([
          provider.request({ method: 'eth_accounts' }),
          provider.request({ method: 'eth_chainId' }),
        ]), this.options.timeoutMs ?? 12_000)
        if (provider !== this.options.provider()) throw new Error('Your browser wallet provider changed. Retry the connection check to use the current wallet.')
        accounts = addressesFrom(available)
        chainId = chainIdFrom(chain)
      }
      if (!this.current(generation)) return
      const saved = accounts.find((address) => address.toLowerCase() === preference.account.toLowerCase())
      const account = preference.mode === 'local' ? saved : preferFirstAccount ? accounts[0] : saved || accounts[0]
      if (!account) throw new Error(preference.mode === 'local' ? 'Your saved test account is unavailable. Restart the local stack or choose another test account.' : 'Wallet account access is unavailable. Unlock your wallet or reconnect if access was revoked.')
      const connection: WalletConnection = { account, chainId, mode: preference.mode }
      this.remember(connection)
      this.emit({ connection, restoring: false, status: 'connected', error: null })
    } catch (cause) {
      if (!this.current(generation)) return
      const error = cause instanceof Error ? cause.message : 'The wallet is temporarily unavailable. Reopen it to reconnect.'
      this.emit({ connection: null, restoring: false, status: 'unavailable', error })
    }
  }

  providerDisconnected() {
    ++this.providerRevision
    if (this.preference?.mode !== 'injected' && this.manualMode !== 'injected') return
    ++this.generation
    this.manualAction = false
    this.manualMode = null
    this.emit({ connection: null, restoring: false, status: 'unavailable', error: 'Your wallet lost its network connection. It will reconnect when the provider is available.' })
  }

  accountsChanged() {
    ++this.providerRevision
    if (this.preference?.mode !== 'injected' || this.manualAction) return
    ++this.generation
    this.emit({ connection: null, restoring: true, status: 'restoring', error: null })
    return this.restore(true)
  }

  chainChanged() {
    ++this.providerRevision
    if (this.preference?.mode !== 'injected' || this.manualAction) return
    ++this.generation
    this.emit({ connection: null, restoring: true, status: 'restoring', error: null })
    return this.restore(true)
  }

  reloadPreference() {
    ++this.generation
    this.manualAction = false
    this.manualMode = null
    const next = readWalletPreference(this.storage(), this.key)
    const samePreference = next?.mode === this.preference?.mode && next?.account.toLowerCase() === this.preference?.account.toLowerCase()
    this.preference = next
    if (!samePreference) this.emit({ connection: null, restoring: Boolean(next), status: next ? 'restoring' : 'disconnected', error: null })
    return this.restore()
  }

  disconnect() {
    ++this.generation
    this.manualAction = false
    this.manualMode = null
    this.preference = null
    writeWalletPreference(this.storage(), this.key, null)
    this.emit({ connection: null, restoring: false, status: 'disconnected', error: null })
  }

  dispose() {
    ++this.generation
    this.disposed = true
  }
}
