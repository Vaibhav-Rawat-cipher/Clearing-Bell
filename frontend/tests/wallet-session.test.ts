import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getAddress } from 'viem'
import { WalletSessionManager, readWalletPreference, walletConnectionsEqual, walletSessionKey, writeWalletPreference } from '../src/lib/wallet-session.ts'
import type { SilentProvider, WalletConnection, WalletPreference, WalletSessionState } from '../src/lib/wallet-session.ts'
import type { Address, DeploymentConfig } from '../src/types.ts'

const accountA: Address = '0x00000000000000000000000000000000000000aa'
const accountB: Address = '0x00000000000000000000000000000000000000bb'
const config: DeploymentConfig = {
  version: 1, chainId: 31337, network: 'Local Anvil', rpcUrl: 'http://127.0.0.1:8545', deploymentBlock: 0,
  contracts: { auctionEngine: '0x0000000000000000000000000000000000000001' }, accounts: [],
}
const preference: WalletPreference = { version: 1, mode: 'injected', account: accountA }

class MemoryStorage {
  data = new Map<string, string>()
  getItem(key: string) { return this.data.get(key) ?? null }
  setItem(key: string, value: string) { this.data.set(key, value) }
  removeItem(key: string) { this.data.delete(key) }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  return { promise, resolve, reject }
}

function harness(options: { stored?: WalletPreference | null; storage?: MemoryStorage; config?: DeploymentConfig; timeoutMs?: number } = {}) {
  const deployment = options.config ?? config
  const storage = options.storage ?? new MemoryStorage()
  if ('stored' in options) writeWalletPreference(storage, walletSessionKey(deployment), options.stored ?? null)
  let state: WalletSessionState = { connection: null, restoring: false, status: 'disconnected', error: null }
  const states: WalletSessionState[] = []
  const calls: string[] = []
  let exposedAccounts: unknown = [accountA]
  let chain: unknown = '0x7a69'
  let failure: Error | null = null
  const defaultProvider: SilentProvider = {
    request: async ({ method }) => {
      calls.push(method)
      if (failure) throw failure
      if (method === 'eth_accounts') return exposedAccounts
      if (method === 'eth_chainId') return chain
      throw new Error(`Unexpected wallet method: ${method}`)
    },
  }
  let provider: SilentProvider | undefined = defaultProvider
  let localAllowed = true
  let localAccounts: Address[] = [accountA, accountB]
  let localChain = 31337
  let localCalls = 0
  const manager = new WalletSessionManager({
    config: deployment, storage: () => storage, provider: () => provider,
    localAllowed: () => localAllowed,
    localAccounts: async () => { localCalls++; if (failure) throw failure; return localAccounts },
    localChainId: async () => { localCalls++; if (failure) throw failure; return localChain },
    onChange: (next) => { state = next; states.push(next) }, timeoutMs: options.timeoutMs,
  })
  return {
    manager, storage, calls, states, get state() { return state }, get localCalls() { return localCalls },
    accounts: (accounts: unknown) => { exposedAccounts = accounts }, chain: (value: unknown) => { chain = value },
    failure: (value: Error | null) => { failure = value }, provider: (value: SilentProvider | undefined) => { provider = value },
    defaultProvider, localAllowed: (value: boolean) => { localAllowed = value },
    localAccounts: (value: Address[]) => { localAccounts = value }, localChain: (value: number) => { localChain = value },
  }
}

describe('nonsecret deployment-scoped wallet preference', () => {
  it('scopes by chain, RPC, and auction engine without exposing RPC credentials', () => {
    const key = walletSessionKey(config)
    assert.notEqual(key, walletSessionKey({ ...config, chainId: 296 }))
    assert.notEqual(key, walletSessionKey({ ...config, rpcUrl: 'http://localhost:8545' }))
    assert.notEqual(key, walletSessionKey({ ...config, contracts: { auctionEngine: accountB } }))
    assert.equal(key, walletSessionKey({ ...config, rpcUrl: 'http://127.0.0.1:8545/' }))
    assert.ok(!walletSessionKey({ ...config, rpcUrl: 'https://rpc.example/api?key=secret-value' }).includes('secret-value'))
    const storage = new MemoryStorage()
    writeWalletPreference(storage, key, preference)
    assert.deepEqual(JSON.parse(storage.getItem(key)!), preference)
  })

  it('ignores corrupt, unsupported, malformed, or explicitly disconnected entries', () => {
    const storage = new MemoryStorage()
    for (const entry of ['not json', 'null', '{}', '[]', '{"version":1,"disconnected":true}', JSON.stringify({ ...preference, version: 2 }), JSON.stringify({ ...preference, account: 'not-address' }), JSON.stringify({ ...preference, mode: 'private-key' })]) {
      storage.setItem('key', entry)
      assert.equal(readWalletPreference(storage, 'key'), null, entry)
    }
  })

  it('tolerates storage failures and tombstones intent if removal fails', () => {
    const storage = new MemoryStorage()
    writeWalletPreference(storage, 'key', preference)
    storage.removeItem = () => { throw new Error('blocked removal') }
    assert.doesNotThrow(() => writeWalletPreference(storage, 'key', null))
    assert.equal(readWalletPreference(storage, 'key'), null)
    storage.getItem = () => { throw new Error('storage disabled') }
    storage.setItem = () => { throw new Error('storage disabled') }
    assert.equal(readWalletPreference(storage, 'key'), null)
    assert.doesNotThrow(() => writeWalletPreference(storage, 'key', preference))
    assert.doesNotThrow(() => writeWalletPreference(null, 'key', null))
  })
})

describe('silent injected-wallet restoration', () => {
  it('does not contact a wallet without saved reconnect intent', async () => {
    const h = harness()
    await h.manager.restore()
    assert.equal(h.state.status, 'disconnected')
    assert.deepEqual(h.calls, [])
    assert.equal(h.localCalls, 0)
  })

  it('restores across a fresh manager/reload with only eth_accounts and eth_chainId', async () => {
    const h = harness()
    const action = h.manager.beginUserAction('injected')
    assert.equal(h.manager.acceptConnection({ account: accountA, chainId: 31337, mode: 'injected' }, action), true)
    h.manager.dispose()
    const reloaded = harness({ storage: h.storage })
    await reloaded.manager.restore()
    assert.equal(reloaded.state.connection?.account, getAddress(accountA))
    assert.equal(reloaded.state.connection?.chainId, 31337)
    assert.equal(reloaded.state.status, 'connected')
    assert.equal(reloaded.state.restoring, false)
    assert.deepEqual(reloaded.calls, ['eth_accounts', 'eth_chainId'])
  })

  it('does not restore an account preference into a different deployment', async () => {
    const h = harness({ stored: preference })
    const other = harness({ storage: h.storage, config: { ...config, chainId: 296 } })
    await other.manager.restore()
    assert.equal(other.state.connection, null)
    assert.deepEqual(other.calls, [])
  })

  it('keeps verified account state during routine successful rechecks', async () => {
    const h = harness({ stored: preference })
    await h.manager.restore()
    h.states.length = 0
    await h.manager.restore()
    assert.ok(h.states.every((state) => state.connection && !state.restoring && state.status === 'connected'))
  })

  it('clears active state on provider loss but retains intent and silently reconnects', async () => {
    const h = harness({ stored: preference })
    await h.manager.restore()
    h.manager.providerDisconnected()
    assert.equal(h.state.connection, null)
    assert.equal(h.state.status, 'unavailable')
    assert.ok(readWalletPreference(h.storage, h.manager.key))
    await h.manager.restore()
    assert.equal(h.state.status, 'connected')
    assert.ok(h.calls.every((method) => method === 'eth_accounts' || method === 'eth_chainId'))
  })

  it('preserves intent after a transient RPC rejection and retries without permissions', async () => {
    const h = harness({ stored: preference })
    await h.manager.restore()
    h.failure(new Error('Disconnected from RPC'))
    await h.manager.restore()
    assert.equal(h.state.connection, null)
    assert.equal(h.state.status, 'unavailable')
    assert.match(h.state.error!, /Disconnected/)
    h.failure(null)
    await h.manager.restore()
    assert.equal(h.state.status, 'connected')
  })

  it('handles locked/revoked accounts without inventing an active account or requesting permission', async () => {
    const h = harness({ stored: preference })
    await h.manager.restore()
    h.accounts([])
    const checking = h.manager.accountsChanged()
    assert.equal(h.state.connection, null)
    await checking
    assert.equal(h.state.status, 'unavailable')
    assert.match(h.state.error!, /Unlock|revoked/)
    assert.ok(readWalletPreference(h.storage, h.manager.key))
    h.accounts([accountB])
    await h.manager.accountsChanged()
    assert.equal(h.state.connection?.account, getAddress(accountB))
  })

  it('surfaces a changed wallet chain without automatically switching it', async () => {
    const h = harness({ stored: preference })
    await h.manager.restore()
    h.chain('0x128')
    const checking = h.manager.chainChanged()
    assert.equal(h.state.connection, null)
    await checking
    assert.equal(h.state.connection?.chainId, 296)
    assert.ok(h.calls.every((method) => method === 'eth_accounts' || method === 'eth_chainId'))
  })

  it('handles a late-injected provider and malformed provider responses', async () => {
    const h = harness({ stored: preference })
    h.provider(undefined)
    await h.manager.restore()
    assert.equal(h.state.status, 'unavailable')
    h.provider(h.defaultProvider)
    await h.manager.restore()
    assert.equal(h.state.status, 'connected')
    h.accounts(['bad account'])
    await h.manager.restore()
    assert.equal(h.state.connection, null)
    h.accounts([accountA])
    for (const chain of ['296', '0x0', '0x20000000000000', null]) {
      h.chain(chain)
      await h.manager.restore()
      assert.equal(h.state.connection, null)
      assert.match(h.state.error!, /chain ID/)
    }
  })

  it('ends a hung silent check with an unavailable state and retained intent', async () => {
    const h = harness({ stored: preference, timeoutMs: 5 })
    h.provider({ request: () => new Promise(() => {}) })
    await h.manager.restore()
    assert.equal(h.state.restoring, false)
    assert.equal(h.state.status, 'unavailable')
    assert.match(h.state.error!, /timed out/)
    assert.ok(readWalletPreference(h.storage, h.manager.key))
  })
})

describe('explicit disconnect and asynchronous cancellation', () => {
  it('respects explicit disconnect after reload, focus checks, and provider events', async () => {
    const h = harness({ stored: preference })
    await h.manager.restore()
    h.manager.disconnect()
    const calls = h.calls.length
    await h.manager.restore()
    await h.manager.accountsChanged()
    await h.manager.chainChanged()
    h.manager.providerDisconnected()
    assert.equal(h.state.status, 'disconnected')
    assert.equal(h.calls.length, calls)
    const reloaded = harness({ storage: h.storage })
    await reloaded.manager.restore()
    assert.equal(reloaded.state.connection, null)
    assert.deepEqual(reloaded.calls, [])
  })

  it('does not let a pending restore resurrect an explicitly disconnected account', async () => {
    const h = harness({ stored: preference })
    const accounts = deferred<unknown>()
    h.provider({ request: ({ method }) => method === 'eth_accounts' ? accounts.promise : Promise.resolve('0x7a69') })
    const restoring = h.manager.restore()
    h.manager.disconnect()
    accounts.resolve([accountA])
    await restoring
    assert.equal(h.state.status, 'disconnected')
    assert.equal(readWalletPreference(h.storage, h.manager.key), null)
  })

  it('ignores stale account checks that complete after a newer account event', async () => {
    const h = harness({ stored: preference })
    const oldAccounts = deferred<unknown>()
    h.provider({ request: ({ method }) => method === 'eth_accounts' ? oldAccounts.promise : Promise.resolve('0x7a69') })
    const stale = h.manager.restore()
    h.provider(h.defaultProvider)
    h.accounts([accountB])
    await h.manager.accountsChanged()
    oldAccounts.resolve([accountA])
    await stale
    assert.equal(h.state.connection?.account, getAddress(accountB))
  })

  it('rejects a replaced provider’s late response even without an account event', async () => {
    const h = harness({ stored: preference })
    const oldAccounts = deferred<unknown>()
    h.provider({ request: ({ method }) => method === 'eth_accounts' ? oldAccounts.promise : Promise.resolve('0x7a69') })
    const stale = h.manager.restore()
    h.provider(h.defaultProvider)
    oldAccounts.resolve([accountA])
    await stale
    assert.equal(h.state.connection, null)
    assert.equal(h.state.status, 'unavailable')
    assert.match(h.state.error!, /provider changed/)
    h.accounts([accountB])
    await h.manager.restore()
    assert.equal(h.state.connection?.account, getAddress(accountB))
  })

  it('cancels a late permission response after explicit disconnect or a newer user action', () => {
    const h = harness()
    const first = h.manager.beginUserAction('injected')
    h.manager.disconnect()
    assert.equal(h.manager.acceptConnection({ account: accountA, chainId: 31337, mode: 'injected' }, first), false)
    assert.equal(h.manager.rejectUserAction(first, 'late rejection'), false)
    const second = h.manager.beginUserAction('injected')
    const third = h.manager.beginUserAction('local')
    assert.equal(h.manager.acceptConnection({ account: accountA, chainId: 31337, mode: 'injected' }, second), false)
    assert.equal(h.manager.acceptConnection({ account: accountB, chainId: 31337, mode: 'local' }, third), true)
    assert.equal(h.state.connection?.account, accountB)
  })

  it('cancels first-time permission completion when the provider disconnects', () => {
    const h = harness()
    const action = h.manager.beginUserAction('injected')
    h.manager.providerDisconnected()
    assert.equal(h.manager.acceptConnection({ account: accountA, chainId: 31337, mode: 'injected' }, action), false)
    assert.equal(h.state.connection, null)
  })

  it('revalidates manual permission results if an account changes during confirmation', async () => {
    const h = harness()
    const firstAccounts = deferred<unknown>()
    h.provider({ request: ({ method }) => method === 'eth_accounts' ? firstAccounts.promise : Promise.resolve('0x7a69') })
    const action = h.manager.beginUserAction('injected')
    const confirming = h.manager.confirmInjectedConnection(action)
    h.provider(h.defaultProvider)
    h.accounts([accountB])
    await h.manager.accountsChanged()
    firstAccounts.resolve([accountA])
    await confirming
    assert.equal(h.state.connection?.account, getAddress(accountB))
  })

  it('does not silently restore over an ongoing explicit account choice', async () => {
    const h = harness({ stored: preference })
    h.manager.beginUserAction('injected')
    await h.manager.restore()
    assert.deepEqual(h.calls, [])
  })

  it('propagates a different tab’s disconnect and cancels unmounted managers', async () => {
    const h = harness({ stored: preference })
    await h.manager.restore()
    writeWalletPreference(h.storage, h.manager.key, null)
    await h.manager.reloadPreference()
    assert.equal(h.state.status, 'disconnected')
    const accounts = deferred<unknown>()
    writeWalletPreference(h.storage, h.manager.key, preference)
    h.provider({ request: ({ method }) => method === 'eth_accounts' ? accounts.promise : Promise.resolve('0x7a69') })
    const restoring = h.manager.reloadPreference()
    h.manager.dispose()
    const count = h.states.length
    accounts.resolve([accountA])
    await restoring
    assert.equal(h.states.length, count)
  })

  it('clears the previous active account while verifying another tab’s account choice', async () => {
    const h = harness({ stored: preference })
    await h.manager.restore()
    const accounts = deferred<unknown>()
    h.provider({ request: ({ method }) => method === 'eth_accounts' ? accounts.promise : Promise.resolve('0x7a69') })
    writeWalletPreference(h.storage, h.manager.key, { ...preference, account: accountB })
    const reloading = h.manager.reloadPreference()
    assert.equal(h.state.connection, null)
    assert.equal(h.state.restoring, true)
    accounts.resolve([accountB])
    await reloading
    assert.equal(h.state.connection?.account, getAddress(accountB))
  })

  it('allows in-memory wallet use and explicit disconnect when localStorage access throws', async () => {
    let state: WalletSessionState | undefined
    const provider: SilentProvider = { request: async ({ method }) => method === 'eth_accounts' ? [accountA] : '0x7a69' }
    const manager = new WalletSessionManager({
      config, storage: () => { throw new Error('SecurityError') },
      provider: () => provider,
      localAllowed: () => false, localAccounts: async () => [], localChainId: async () => 31337,
      onChange: (next) => { state = next },
    })
    const action = manager.beginUserAction('injected')
    await manager.confirmInjectedConnection(action)
    assert.equal(state?.status, 'connected')
    await manager.restore()
    assert.equal(state?.status, 'connected')
    manager.disconnect()
    assert.equal(state?.status, 'disconnected')
  })
})

describe('validated local account restoration', () => {
  it('restores only the selected saved account after checking unlocked accounts and chain', async () => {
    const h = harness({ stored: { ...preference, mode: 'local', account: accountB } })
    await h.manager.restore()
    assert.equal(h.state.connection?.account, getAddress(accountB))
    assert.equal(h.state.connection?.mode, 'local')
    assert.equal(h.localCalls, 2)
    assert.deepEqual(h.calls, [])
  })

  it('refuses local restore outside the validated development loopback environment', async () => {
    const h = harness({ stored: { ...preference, mode: 'local' } })
    h.localAllowed(false)
    await h.manager.restore()
    assert.equal(h.state.connection, null)
    assert.equal(h.localCalls, 0)
    assert.match(h.state.error!, /local development chain/)
  })

  it('does not substitute another unlocked account when the saved account disappears', async () => {
    const h = harness({ stored: { ...preference, mode: 'local' } })
    h.localAccounts([accountB])
    await h.manager.restore()
    assert.equal(h.state.connection, null)
    assert.match(h.state.error!, /saved test account is unavailable/)
    h.localAccounts([accountA, accountB])
    await h.manager.restore()
    assert.equal(h.state.connection?.account, getAddress(accountA))
  })

  it('rejects a mismatched live chain and recovers from a temporary local RPC outage', async () => {
    const h = harness({ stored: { ...preference, mode: 'local' } })
    h.localChain(296)
    await h.manager.restore()
    assert.equal(h.state.connection, null)
    assert.match(h.state.error!, /does not match/)
    h.localChain(31337)
    h.failure(new Error('Local RPC offline'))
    await h.manager.restore()
    assert.equal(h.state.connection, null)
    h.failure(null)
    await h.manager.restore()
    assert.equal(h.state.status, 'connected')
  })

  it('ignores browser-wallet events while using a local account', async () => {
    const h = harness({ stored: { ...preference, mode: 'local' } })
    await h.manager.restore()
    h.manager.providerDisconnected()
    await h.manager.accountsChanged()
    await h.manager.chainChanged()
    assert.equal(h.state.status, 'connected')
    assert.equal(h.localCalls, 2)
  })
})

describe('transaction checks after asynchronous preflight', () => {
  it('permits the same verified wallet through routine background checks', async () => {
    const h = harness({ stored: preference })
    await h.manager.restore()
    const guard = h.manager.transactionGuard(h.state.connection!)
    await h.manager.restore()
    assert.doesNotThrow(guard)
  })

  it('cancels preflight after disconnect even if the same account reconnects', async () => {
    const h = harness({ stored: { ...preference, mode: 'local' } })
    await h.manager.restore()
    const connection = h.state.connection!
    const guard = h.manager.transactionGuard(connection)
    h.manager.disconnect()
    assert.throws(guard, /wallet connection changed/)
    const action = h.manager.beginUserAction('local')
    h.manager.acceptConnection(connection, action)
    assert.equal(walletConnectionsEqual(h.state.connection, connection), true)
    assert.throws(guard, /wallet connection changed/)
    assert.doesNotThrow(h.manager.transactionGuard(connection))
  })

  it('cancels a pending preflight after a provider swap, new account choice, or unmount', async () => {
    const h = harness({ stored: preference })
    await h.manager.restore()
    const guard = h.manager.transactionGuard(h.state.connection!)
    h.provider({ request: h.defaultProvider.request })
    assert.throws(guard, /wallet connection changed/)
    h.provider(h.defaultProvider)
    const action = h.manager.beginUserAction('injected')
    assert.throws(guard, /wallet connection changed/)
    h.manager.rejectUserAction(action, 'User cancelled')
    assert.throws(guard, /wallet connection changed/)
    const nextGuard = h.manager.transactionGuard(h.state.connection!)
    h.manager.dispose()
    assert.throws(nextGuard, /wallet connection changed/)
  })
})

it('connection equality includes account, mode and chain', () => {
  const connection: WalletConnection = { account: accountA, mode: 'injected', chainId: 31337 }
  assert.equal(walletConnectionsEqual(connection, { ...connection, account: getAddress(accountA) }), true)
  assert.equal(walletConnectionsEqual(connection, { ...connection, chainId: 296 }), false)
  assert.equal(walletConnectionsEqual(connection, { ...connection, mode: 'local' }), false)
  assert.equal(walletConnectionsEqual(connection, null), false)
  assert.equal(walletConnectionsEqual(null, null), true)
})
