import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createWalletClient, custom, getAddress, http, isAddress, zeroAddress, type EIP1193Provider } from 'viem'
import { auctionAbi, gateAbi, tokenAbi } from '../lib/abi'
import { requiredOrderFunds, sameAddress } from '../lib/amounts'
import { readSnapshot, readToken, type ChainSnapshot } from '../lib/chain'
import { chainFor, isLocalDeployment, loadDeployment, localAccountsFor, publicClientFor, type AuctionPublicClient } from '../lib/config'
import { readableError } from '../lib/errors'
import { WalletSessionManager, walletConnectionsEqual, type WalletConnection, type WalletSessionState } from '../lib/wallet-session'
import type { Address, DemoOrder, DeploymentConfig, Hash, Notice, OpenRoundInput, PendingTransaction } from '../types'
import { DemoSessionContext, type DemoSessionValue } from './DemoSessionContext'

const emptyOrder: DemoOrder = { side: 'BUY', price: '', quantity: '' }

function injectedProvider(): EIP1193Provider | undefined {
  return (window as unknown as { ethereum?: EIP1193Provider }).ethereum
}

function makeWallet(config: DeploymentConfig, connection: WalletConnection) {
  const provider = injectedProvider()
  if (connection.mode === 'injected' && !provider) throw new Error('No browser wallet was found. Install an EVM-compatible wallet and retry.')
  if (connection.mode === 'local' && !isLocalDeployment(config)) throw new Error('Unlocked accounts are available only for a local development chain.')
  return createWalletClient({
    account: connection.account, chain: chainFor(config),
    transport: connection.mode === 'injected' ? custom(provider!) : http(config.rpcUrl, { retryCount: 0, timeout: 12_000 }),
  })
}

type AuctionWallet = ReturnType<typeof makeWallet>

export function DemoSessionProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<DeploymentConfig | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [snapshot, setSnapshot] = useState<ChainSnapshot | null>(null)
  const [connection, setConnection] = useState<WalletConnection | null>(null)
  const [walletState, setWalletState] = useState<WalletSessionState>({ connection: null, restoring: true, status: 'restoring', error: null })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [order, setOrder] = useState<DemoOrder>(emptyOrder)
  const [identityDialogOpen, setIdentityDialogOpen] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const [pendingTx, setPendingTx] = useState<PendingTransaction | null>(null)
  const [lastTxHash, setLastTxHash] = useState<Hash | null>(null)
  const transactionLock = useRef(false)
  const connectedAddress = useRef<Address | null>(null)
  const connectionRef = useRef<WalletConnection | null>(null)
  const walletManager = useRef<WalletSessionManager | null>(null)
  const selectedRoundId = useRef<string | null>(null)
  const refreshSequence = useRef(0)
  const receiptTimer = useRef<number | undefined>(undefined)
  const client = useMemo(() => config ? publicClientFor(config) : null, [config])
  const account = connection?.account ?? null

  const refresh = useCallback(async () => {
    if ((account?.toLowerCase() ?? null) !== (connectedAddress.current?.toLowerCase() ?? null) || selectedId !== selectedRoundId.current) return
    const sequence = ++refreshSequence.current
    setRefreshing(true)
    try {
      if (!config || !client) {
        const deployment = await loadDeployment()
        if (sequence === refreshSequence.current) setConfig(deployment)
        return
      }
      const next = await readSnapshot(client, config, account, selectedId)
      if (sequence !== refreshSequence.current) return
      setSnapshot(next)
      setError(null)
      setConnectionStatus('ready')
    } catch (cause) {
      if (sequence !== refreshSequence.current) return
      setSnapshot(null)
      setError(readableError(cause))
      setConnectionStatus('error')
    } finally {
      if (sequence === refreshSequence.current) setRefreshing(false)
    }
  }, [config, client, account, selectedId])

  useEffect(() => {
    const first = window.setTimeout(() => void refresh(), 0)
    const polling = window.setInterval(() => { if (!document.hidden) void refresh() }, 15_000)
    const invalidate = () => { refreshSequence.current++ }
    return () => { window.clearTimeout(first); window.clearInterval(polling); invalidate() }
  }, [refresh, refreshVersion])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 7500)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => () => window.clearTimeout(receiptTimer.current), [])

  const invalidateAccount = useCallback((next: WalletConnection | null) => {
    if (walletConnectionsEqual(connectionRef.current, next)) return
    refreshSequence.current++
    connectedAddress.current = next?.account ?? null
    connectionRef.current = next
    setSnapshot(null)
    setConnectionStatus('loading')
    setConnection(next)
    setRefreshVersion((version) => version + 1)
  }, [])

  useEffect(() => {
    if (!config || !client) return
    const manager = new WalletSessionManager({
      config,
      storage: () => window.localStorage,
      provider: injectedProvider,
      localAllowed: () => isLocalDeployment(config),
      localAccounts: () => localAccountsFor(config),
      localChainId: () => client.getChainId(),
      onChange: (state) => { setWalletState(state); invalidateAccount(state.connection) },
    })
    walletManager.current = manager
    let listeningProvider: EIP1193Provider | undefined
    const changedAccounts = () => { void manager.accountsChanged() }
    const changedChain = () => { void manager.chainChanged() }
    const disconnected = () => manager.providerDisconnected()
    const connected = () => { void manager.restore() }
    const removeProviderListeners = () => {
      listeningProvider?.removeListener?.('accountsChanged', changedAccounts)
      listeningProvider?.removeListener?.('chainChanged', changedChain)
      listeningProvider?.removeListener?.('disconnect', disconnected)
      listeningProvider?.removeListener?.('connect', connected)
    }
    const attachProvider = () => {
      const provider = injectedProvider()
      if (provider === listeningProvider) return
      removeProviderListeners()
      listeningProvider = provider
      provider?.on?.('accountsChanged', changedAccounts)
      provider?.on?.('chainChanged', changedChain)
      provider?.on?.('disconnect', disconnected)
      provider?.on?.('connect', connected)
    }
    const recheck = () => { attachProvider(); void manager.restore() }
    const visible = () => { if (!document.hidden) recheck() }
    const storageChanged = (event: StorageEvent) => { if (event.key === manager.key || event.key === null) void manager.reloadPreference() }
    attachProvider()
    const first = window.setTimeout(recheck, 0)
    const polling = window.setInterval(visible, 30_000)
    window.addEventListener('focus', recheck)
    window.addEventListener('pageshow', recheck)
    window.addEventListener('online', recheck)
    window.addEventListener('ethereum#initialized', recheck)
    window.addEventListener('storage', storageChanged)
    document.addEventListener('visibilitychange', visible)
    return () => {
      manager.dispose()
      if (walletManager.current === manager) walletManager.current = null
      window.clearTimeout(first)
      window.clearInterval(polling)
      removeProviderListeners()
      window.removeEventListener('focus', recheck)
      window.removeEventListener('pageshow', recheck)
      window.removeEventListener('online', recheck)
      window.removeEventListener('ethereum#initialized', recheck)
      window.removeEventListener('storage', storageChanged)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [config, client, invalidateAccount])

  const connectWallet = async () => {
    const manager = walletManager.current
    const generation = manager?.beginUserAction('injected')
    try {
      if (!config || !manager || generation === undefined) throw new Error('Wait for deployment configuration before connecting your wallet.')
      const provider = injectedProvider()
      if (!provider) throw new Error('No browser wallet was found. Open this app in an EVM-compatible wallet browser or install a browser wallet.')
      const accounts = await provider.request({ method: 'eth_requestAccounts' })
      if (!manager.isCurrentAction(generation)) return
      if (!accounts[0]) throw new Error('No wallet account was selected.')
      const verified = await manager.confirmInjectedConnection(generation)
      if (!verified) return
      const { chainId } = verified
      setIdentityDialogOpen(false)
      if (chainId !== config.chainId) setNotice({ title: 'Switch wallet network', body: `Your wallet is on chain ${chainId}. Select ${config.network} (chain ${config.chainId}) before signing a transaction.`, tone: 'danger' })
    } catch (cause) {
      const message = readableError(cause)
      if (!manager || generation === undefined || manager.rejectUserAction(generation, message)) setNotice({ title: 'Wallet connection failed', body: message, tone: 'danger' })
    }
  }

  const connectLocalAccount = async (requested?: Address) => {
    const manager = walletManager.current
    const generation = manager?.beginUserAction('local')
    try {
      if (!config || !client || !manager || generation === undefined || !isLocalDeployment(config)) throw new Error('Local accounts require the development server and a loopback Anvil chain (31337).')
      if (await client.getChainId() !== 31337) throw new Error('The local RPC is not running chain 31337.')
      const available = await localAccountsFor(config)
      const selected = requested || available[0]
      if (!selected || !available.some((item) => sameAddress(item, selected))) throw new Error('This address is not an unlocked local account.')
      if (manager.acceptConnection({ account: getAddress(selected), chainId: 31337, mode: 'local' }, generation)) setIdentityDialogOpen(false)
    } catch (cause) {
      const message = readableError(cause)
      if (!manager || generation === undefined || manager.rejectUserAction(generation, message)) setNotice({ title: 'Local connection failed', body: message, tone: 'danger' })
    }
  }

  const switchNetwork = async () => {
    const manager = walletManager.current
    const generation = manager?.beginUserAction('injected')
    try {
      const provider = injectedProvider()
      if (!config || !provider || !manager || generation === undefined) throw new Error('Connect a browser wallet to switch its network.')
      const chainId = `0x${config.chainId.toString(16)}` as const
      try {
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] })
      } catch (cause) {
        if ((cause as { code?: number }).code !== 4902) throw cause
        if (!manager.isCurrentAction(generation)) return
        const chain = chainFor(config)
        await provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId, chainName: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: [config.rpcUrl], ...(config.explorerUrl ? { blockExplorerUrls: [config.explorerUrl] } : {}) }] })
        if (!manager.isCurrentAction(generation)) return
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] })
      }
      if (!manager.isCurrentAction(generation)) return
      await manager.confirmInjectedConnection(generation, config.chainId)
    } catch (cause) {
      const message = readableError(cause)
      if (!manager || generation === undefined || manager.rejectUserAction(generation, message)) setNotice({ title: 'Network switch failed', body: message, tone: 'danger' })
    }
  }

  const signer = async () => {
    if (!config || !client || connectionStatus !== 'ready') throw new Error('The blockchain connection is unavailable. Refresh before submitting a transaction.')
    if (!connection) { setIdentityDialogOpen(true); throw new Error('Connect a wallet before continuing.') }
    if (walletState.restoring || !walletConnectionsEqual(connection, connectionRef.current)) throw new Error('Your wallet connection is being checked. Try again when it is ready.')
    const manager = walletManager.current
    if (!manager) throw new Error('Your wallet connection is not ready. Reconnect and retry.')
    const assertCurrentWallet = manager.transactionGuard(connection)
    const wallet = makeWallet(config, connection)
    const [chainId, accounts] = await Promise.all([wallet.getChainId(), wallet.getAddresses()])
    assertCurrentWallet()
    if (!walletConnectionsEqual(connection, connectionRef.current)) throw new Error('The wallet account changed. Review your order and try again.')
    if (chainId !== config.chainId) throw new Error(`Your wallet is on chain ${chainId}. Switch to ${config.network} (chain ${config.chainId}).`)
    if (!accounts.some((item) => sameAddress(item, connection.account))) throw new Error('The connected account is no longer available in your wallet. Reconnect and retry.')
    return { client, wallet, account: connection.account, config, assertCurrentWallet }
  }

  const runTransaction = async (label: string, action: (client: AuctionPublicClient, wallet: AuctionWallet, account: Address, config: DeploymentConfig, assertCurrentWallet: () => void) => Promise<Hash>): Promise<boolean> => {
    if (transactionLock.current) return false
    transactionLock.current = true
    setPendingTx({ label, stage: 'signature' })
    let submittedHash: Hash | null = null
    try {
      const session = await signer()
      submittedHash = await action(session.client, session.wallet, session.account, session.config, session.assertCurrentWallet)
      setLastTxHash(submittedHash)
      setPendingTx({ label, stage: 'confirming', hash: submittedHash })
      const receipt = await session.client.waitForTransactionReceipt({ hash: submittedHash, timeout: 90_000, retryCount: 1 })
      if (receipt.status !== 'success') throw new Error('The transaction reverted on-chain. No changes from that transaction were applied.')
      setNotice({ title: `${label} confirmed`, body: `Confirmed in block ${receipt.blockNumber}.`, tone: 'success' })
      await refresh()
      return true
    } catch (cause) {
      const message = readableError(cause)
      // A receipt timeout is not a failed transaction. Keep the action locked and
      // check the original hash instead of offering a second broadcast.
      if (submittedHash && /timed out|timeout|Cannot reach|not found/i.test(message) && client) {
        const hash = submittedHash
        const receiptClient = client
        setNotice({ title: 'Transaction submitted; confirmation pending', body: 'The network has not returned a receipt yet. The original transaction is still being checked.', tone: 'neutral' })
        const checkReceipt = async () => {
          try {
            const receipt = await receiptClient.getTransactionReceipt({ hash })
            if (receipt.status === 'success') setNotice({ title: `${label} confirmed`, body: `Confirmed in block ${receipt.blockNumber}.`, tone: 'success' })
            else setNotice({ title: `${label} reverted`, body: 'The transaction was included but reverted. No changes were applied.', tone: 'danger' })
            transactionLock.current = false
            receiptTimer.current = undefined
            setPendingTx(null)
            await refresh()
          } catch { receiptTimer.current = window.setTimeout(() => void checkReceipt(), 10_000) }
        }
        receiptTimer.current = window.setTimeout(() => void checkReceipt(), 10_000)
        return false
      }
      setNotice({ title: `${label} failed`, body: message, tone: 'danger' })
      return false
    } finally {
      if (!receiptTimer.current) {
        transactionLock.current = false
        setPendingTx(null)
      }
    }
  }

  const preflightOrder = async (rpc: AuctionPublicClient, address: Address, deployment: DeploymentConfig) => {
    const fresh = await readSnapshot(rpc, deployment, address, selectedId || snapshot?.selectedRound?.id || null)
    const round = fresh.selectedRound
    if (!round) throw new Error('No auction round is selected.')
    if (fresh.paused) throw new Error('The issuer has paused the auction engine.')
    if (round.phase !== 'open') throw new Error('This auction round is already closed.')
    if (fresh.chainTimestamp > round.deadline) throw new Error('The order deadline has passed.')
    if (fresh.eligibility !== true) throw new Error(fresh.eligibilityError || 'This wallet is not approved to trade this bond. Contact the issuer for registry access.')
    if (fresh.roundsTruncated) throw new Error('This wallet has a large auction history. Full outstanding-order coverage must be loaded before another order can be submitted.')
    const funds = requiredOrderFunds(order, round, fresh.rounds, address)
    const holding = fresh.tokens.find((token) => sameAddress(token.address, funds.token.address))
    if (!holding || holding.balanceRaw < funds.required) throw new Error(`Insufficient ${funds.token.symbol}. This order and your open orders require ${funds.requiredFormatted} ${funds.token.symbol}.`)
    return { round, funds, holding }
  }

  const approveOrder = async () => runTransaction('Token approval', async (rpc, wallet, address, deployment, assertCurrentWallet) => {
    const { funds, holding } = await preflightOrder(rpc, address, deployment)
    if (holding.allowanceRaw >= funds.required) throw new Error('Your existing approval already covers this order. Submit the order to continue.')
    const { request } = await rpc.simulateContract({ address: funds.token.address, abi: tokenAbi, functionName: 'approve', args: [deployment.contracts.auctionEngine, funds.required], account: address })
    assertCurrentWallet()
    return wallet.writeContract(request)
  })

  const submitOrder = async () => {
    const success = await runTransaction('Order submission', async (rpc, wallet, address, deployment, assertCurrentWallet) => {
      const { round, funds, holding } = await preflightOrder(rpc, address, deployment)
      if (holding.allowanceRaw < funds.required) throw new Error(`Approve at least ${funds.requiredFormatted} ${funds.token.symbol} before submitting this order.`)
      const { request } = await rpc.simulateContract({ address: deployment.contracts.auctionEngine, abi: auctionAbi, functionName: 'submitBid', args: [BigInt(round.id), funds.price, funds.quantity, funds.isBuy], account: address })
      assertCurrentWallet()
      return wallet.writeContract(request)
    })
    if (success && sameAddress(account, connectedAddress.current)) setOrder((current) => ({ ...current, quantity: '' }))
    return success
  }

  const closeRound = async (id?: string) => runTransaction('Round clearing', async (rpc, wallet, address, deployment, assertCurrentWallet) => {
    const roundId = id || snapshot?.selectedRound?.id
    if (!roundId || !/^\d+$/.test(roundId)) throw new Error('Choose an auction round to clear.')
    const { request } = await rpc.simulateContract({ address: deployment.contracts.auctionEngine, abi: auctionAbi, functionName: 'closeAndClear', args: [BigInt(roundId)], account: address })
    assertCurrentWallet()
    return wallet.writeContract(request)
  })

  const openRound = async (input: OpenRoundInput) => {
    const success = await runTransaction('New auction', async (rpc, wallet, address, deployment, assertCurrentWallet) => {
      if (!isAddress(input.bondToken) || !isAddress(input.settlementToken) || input.bondToken === zeroAddress || input.settlementToken === zeroAddress) throw new Error('Enter valid non-zero bond and settlement token addresses.')
      if (sameAddress(input.bondToken, input.settlementToken)) throw new Error('Bond and settlement token addresses must be different.')
      if (!Number.isSafeInteger(input.bidWindowSeconds) || input.bidWindowSeconds < 60 || input.bidWindowSeconds > 31_536_000) throw new Error('The auction window must be between 60 seconds and one year.')
      const [bond, gate] = await Promise.all([
        readToken(rpc, input.bondToken),
        rpc.readContract({ address: deployment.contracts.auctionEngine, abi: auctionAbi, functionName: 'complianceGate' }),
        readToken(rpc, input.settlementToken),
      ])
      if (bond.decimals !== 18) throw new Error('The auction engine requires an 18-decimal bond token.')
      const registry = await rpc.readContract({ address: gate, abi: gateAbi, functionName: 'identityRegistry', args: [input.bondToken] })
      if (registry === zeroAddress) throw new Error('Register an identity registry for this bond before opening its auction.')
      const { request } = await rpc.simulateContract({ address: deployment.contracts.auctionEngine, abi: auctionAbi, functionName: 'openRound', args: [input.bondToken, input.settlementToken, BigInt(input.bidWindowSeconds)], account: address })
      assertCurrentWallet()
      return wallet.writeContract(request)
    })
    if (success) { selectedRoundId.current = null; setSelectedId(null) }
    return success
  }

  const setPaused = async (value: boolean) => runTransaction(value ? 'Pause auctions' : 'Resume auctions', async (rpc, wallet, address, deployment, assertCurrentWallet) => {
    const { request } = await rpc.simulateContract({ address: deployment.contracts.auctionEngine, abi: auctionAbi, functionName: value ? 'pause' : 'unpause', account: address })
    assertCurrentWallet()
    return wallet.writeContract(request)
  })

  const selectedRound = snapshot?.selectedRound ?? null
  const bondHolding = snapshot?.tokens.find((token) => sameAddress(token.address, selectedRound?.bondToken))
  const settlementHolding = snapshot?.tokens.find((token) => sameAddress(token.address, selectedRound?.settlementToken))
  const value: DemoSessionValue = {
    config, connectionStatus, error, refreshing, account, walletChainId: connection?.chainId ?? null, walletMode: connection?.mode ?? null,
    walletRestoring: config ? walletState.restoring : connectionStatus === 'loading',
    walletStatus: !config && connectionStatus === 'error' ? 'disconnected' : walletState.status,
    walletError: walletState.error,
    localAccounts: snapshot?.localAccounts ?? [], rounds: snapshot?.rounds ?? [], selectedRound, bids: selectedRound?.bids ?? [],
    tokens: snapshot?.tokens ?? [], settlements: snapshot?.settlements ?? [], issuer: snapshot?.bondIssuer ?? null,
    platformAdmin: snapshot?.platformAdmin ?? null,
    bondIssuer: snapshot?.bondIssuer ?? null,
    isPlatformAdmin: sameAddress(account, snapshot?.platformAdmin),
    isIssuer: sameAddress(account, snapshot?.bondIssuer), paused: snapshot?.paused ?? false, eligibility: snapshot?.eligibility ?? null,
    eligibilityError: snapshot?.eligibilityError ?? null,
    balances: account && bondHolding && settlementHolding ? { bond: bondHolding.balance, settlement: settlementHolding.balance, bondAllowance: bondHolding.allowance, settlementAllowance: settlementHolding.allowance } : null,
    pendingTx, lastTxHash, historyError: snapshot?.historyError ?? null, historyFromBlock: snapshot?.historyFromBlock ?? null,
    roundsTruncated: snapshot?.roundsTruncated ?? false, blockNumber: snapshot?.blockNumber ?? null, chainTimestamp: snapshot?.chainTimestamp ?? null,
    identity: account ? snapshot?.eligibility === true ? 'verified' : 'restricted' : 'guest', identityDialogOpen, notice,
    order,
    connectWallet, switchNetwork, connectLocalAccount,
    retryWalletConnection: async () => { await walletManager.current?.restore() },
    disconnect: () => { walletManager.current?.disconnect(); setIdentityDialogOpen(false) },
    selectRound: (id) => { if (!/^\d+$/.test(id)) return; refreshSequence.current++; selectedRoundId.current = id; setSelectedId(id); setSnapshot(null); setConnectionStatus('loading'); setRefreshVersion((version) => version + 1); setOrder(emptyOrder) },
    refresh, approveOrder, submitOrder, closeRound, openRound, setPaused,
    openIdentityDialog: () => setIdentityDialogOpen(true), closeIdentityDialog: () => setIdentityDialogOpen(false),
    updateOrder: (patch) => setOrder((current) => ({ ...current, ...patch })), setOrderSide: (side) => setOrder((current) => ({ ...current, side })),
    showNotice: setNotice, dismissNotice: () => setNotice(null),
  }

  return <DemoSessionContext.Provider value={value}>{children}</DemoSessionContext.Provider>
}
