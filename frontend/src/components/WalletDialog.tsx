import { ArrowDownLeft, ArrowRight, ArrowUpRight, Building2, Check, ChevronDown, CircleAlert, Code2, Fingerprint, LoaderCircle, LockKeyhole, LogOut, RefreshCw, ShieldCheck, UserRound, UserRoundX, WalletCards } from 'lucide-react'
import { useState } from 'react'
import { useDemoSession } from '../context/DemoSessionContext'
import { isLocalDeployment } from '../lib/config'
import { readableError } from '../lib/errors'
import type { Address } from '../types'
import { shortAddress } from '../utils/format'
import { AddressLink } from './ui/ChainState'
import { Dialog } from './ui/Dialog'
import '../styles/wallet.css'

function AccountGlyph({ role, label }: { role: string; label: string }) {
  const Icon = role === 'issuer' ? Building2 : role === 'seller' ? ArrowUpRight : role === 'restricted' ? UserRoundX : /liquidity/i.test(label) ? ArrowDownLeft : UserRound
  return <Icon aria-hidden="true" />
}

export function WalletDialog() {
  const session = useDemoSession()
  const { account, config, walletMode, walletChainId, identityDialogOpen, localAccounts, pendingTx, notice, error, eligibility, connectionStatus, walletError } = session
  const [busy, setBusy] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [accountsOpen, setAccountsOpen] = useState(false)
  const local = Boolean(config && isLocalDeployment(config))
  const wrongChain = Boolean(account && config && walletChainId !== config.chainId)
  const locked = Boolean(busy || pendingTx)
  const currentAccount = config?.accounts.find((entry) => entry.address.toLowerCase() === account?.toLowerCase())
  const accountRows = localAccounts.filter((address) => !config?.accounts.length || config.accounts.some((entry) => entry.address.toLowerCase() === address.toLowerCase()))
  const walletNotice = notice?.tone === 'danger' && /wallet|local connection|network switch/i.test(notice.title) ? notice : null
  const failure = localError || walletNotice?.body || walletError || error

  const run = async (key: string, action: () => Promise<void>) => {
    if (locked) return
    setBusy(key)
    setLocalError(null)
    session.dismissNotice()
    try { await action() } catch (cause) { setLocalError(readableError(cause)) } finally { setBusy(null) }
  }

  const connectLocal = (address: Address) => void run(address, () => session.connectLocalAccount(address))

  return <Dialog open={identityDialogOpen} onClose={session.closeIdentityDialog} titleId="wallet-sheet-title" className="wallet-sheet">
    <header className="wallet-sheet__heading">
      <span className="wallet-sheet__emblem"><Fingerprint aria-hidden="true" /></span>
      <span className="wallet-sheet__eyebrow">Clearing Bell account</span>
      <h2 id="wallet-sheet-title">{account ? 'Your market access' : 'Connect your wallet'}</h2>
      <p>{account ? 'Manage the wallet you use to trade and access your portfolio.' : 'Connect to place orders and manage your bond portfolio.'}</p>
    </header>

    {account && <section className="wallet-sheet__connected" aria-label="Connected account">
      <div className="wallet-sheet__account-title"><span><i aria-hidden="true" />{walletMode === 'local' ? currentAccount?.label || 'Local test account' : 'Browser wallet'}</span><small>{walletMode === 'local' ? 'Test account' : 'Connected'}</small></div>
      <AddressLink value={account} full />
      <div className="wallet-sheet__account-access"><span>{connectionStatus === 'loading' ? <><LoaderCircle className="wallet-sheet__spinner" aria-hidden="true" />Checking access</> : eligibility === true ? <><ShieldCheck aria-hidden="true" />Eligible for this bond</> : eligibility === false ? <><CircleAlert aria-hidden="true" />Eligibility required</> : 'Select a bond to check eligibility'}</span><button disabled={locked} onClick={session.disconnect}><LogOut aria-hidden="true" />Disconnect</button></div>
    </section>}

    {wrongChain && <section className="wallet-sheet__network" role="alert"><CircleAlert aria-hidden="true" /><div><b>Switch your wallet network</b><p>Choose {config?.network} · chain {config?.chainId}. Your wallet is on chain {walletChainId}.</p><button disabled={locked} onClick={() => void run('network', session.switchNetwork)}>{busy === 'network' ? 'Requesting switch…' : 'Switch network'}<ArrowRight aria-hidden="true" /></button></div></section>}

    <button className="wallet-sheet__browser" disabled={locked || !config} aria-busy={busy === 'browser'} onClick={() => void run('browser', session.connectWallet)}>
      <span className="wallet-sheet__browser-icon"><WalletCards aria-hidden="true" /></span>
      <span className="wallet-sheet__browser-copy"><b>{busy === 'browser' ? 'Check your browser wallet' : account ? 'Use another browser wallet' : 'Browser wallet'}</b><small>{busy === 'browser' ? 'Complete the connection request to continue.' : 'Connect an installed EVM wallet'}</small></span>
      {busy === 'browser' ? <LoaderCircle className="wallet-sheet__spinner" aria-hidden="true" /> : <ArrowUpRight aria-hidden="true" />}
    </button>

    {failure && <div className="wallet-sheet__error" role="alert"><CircleAlert aria-hidden="true" /><div><b>{walletNotice?.title || 'Connection unavailable'}</b><p>{failure}</p>{(error || walletError) && <button disabled={locked || session.refreshing || session.walletRestoring} onClick={() => void run('retry', walletError ? session.retryWalletConnection : session.refresh)}><RefreshCw className={busy === 'retry' ? 'wallet-sheet__spinner' : undefined} aria-hidden="true" />{busy === 'retry' ? 'Retrying…' : 'Retry connection'}</button>}</div></div>}

    {pendingTx && <div className="wallet-sheet__pending" role="status"><LoaderCircle className="wallet-sheet__spinner" aria-hidden="true" /><div><b>{pendingTx.label}</b><p>{pendingTx.stage === 'signature' ? 'Confirm the request in your wallet.' : 'Waiting for the network to confirm.'} Account changes are paused until this finishes.</p>{pendingTx.hash && <AddressLink value={pendingTx.hash} transaction />}</div></div>}

    {local && <details className="wallet-sheet__test-accounts" open={accountsOpen} onToggle={(event) => setAccountsOpen(event.currentTarget.open)}>
      <summary tabIndex={0}><Code2 aria-hidden="true" /><span>Test accounts</span><small>Local development</small><ChevronDown aria-hidden="true" /></summary>
      {accountsOpen && <div className="wallet-sheet__test-content"><p>Chain {config?.chainId} on your machine. These unlocked accounts hold test assets only.</p>
        {accountRows.length ? <div className="wallet-sheet__account-list">{accountRows.map((address) => {
          const entry = config?.accounts.find((item) => item.address.toLowerCase() === address.toLowerCase())
          const label = entry?.label || 'Local account'
          const role = entry?.role || 'investor'
          const selected = account?.toLowerCase() === address.toLowerCase()
          const connecting = busy === address
          return <button className={`wallet-sheet__account-row${selected ? ' is-current' : ''}`} key={address} disabled={locked || selected} aria-label={`${selected ? 'Connected to' : 'Connect'} ${label}, ${shortAddress(address)}`} aria-busy={connecting} onClick={() => connectLocal(address)}>
            <span className={`wallet-sheet__role role-${role}`}><AccountGlyph role={role} label={label} /></span>
            <span className="wallet-sheet__row-copy"><b>{label}</b><small>{shortAddress(address)}</small></span>
            <span className="wallet-sheet__row-state">{connecting ? <><span>Connecting</span><LoaderCircle className="wallet-sheet__spinner" aria-hidden="true" /></> : selected ? <><span>Connected</span><Check aria-hidden="true" /></> : <ArrowRight aria-hidden="true" />}</span>
          </button>
        })}</div> : <p className="wallet-sheet__unavailable">Local accounts are unavailable. Check the network connection and retry.</p>}
      </div>}
    </details>}

    <footer className="wallet-sheet__footer"><LockKeyhole aria-hidden="true" /><p>Connecting does not move funds or grant token approval.</p></footer>
  </Dialog>
}
