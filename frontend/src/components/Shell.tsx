import { AnimatePresence, motion } from 'motion/react'
import { ArrowUpRight, Check, LoaderCircle, Menu, RefreshCw, ShieldAlert, WalletCards, X } from 'lucide-react'
import { useState } from 'react'
import { useDemoSession } from '../context/DemoSessionContext'
import type { View } from '../types'
import { shortAddress } from '../utils/format'
import { Brand } from './Brand'
import { WalletDialog } from './WalletDialog'
import { AddressLink } from './ui/ChainState'
import { ViewLink } from './ViewLink'

export function Shell({ view, onNavigate, children }: { view: View; onNavigate: (view: View) => void; children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const session = useDemoSession()
  const { account, config, error, notice, pendingTx, walletChainId, identityDialogOpen, walletRestoring, walletStatus } = session
  const walletLabel = account ? shortAddress(account) : walletRestoring ? 'Restoring…' : walletStatus === 'unavailable' ? 'Reconnect wallet' : 'Connect wallet'
  const wrongChain = account && walletChainId !== config?.chainId
  const navigate = (next: View) => { onNavigate(next); setMenuOpen(false) }
  return <div className={`site-shell view-${view}`}>
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); const main = document.getElementById('main-content'); main?.focus(); main?.scrollIntoView({ block: 'start' }) }}>Skip to content</a>
    <header className="site-header">
      <ViewLink className="brand-button" view="home" onNavigate={navigate} aria-label="Clearing Bell home"><Brand /></ViewLink>
      <nav className={menuOpen ? 'site-nav open' : 'site-nav'} aria-label="Primary navigation">
        {(view === 'home' ? [{ view: 'markets' as View, label: 'Markets' }] : [{ view: 'markets' as View, label: 'Markets' }, { view: 'portfolio' as View, label: 'Portfolio' }, { view: 'issuer' as View, label: 'Issuer' }]).map(item => <ViewLink key={item.view} view={item.view} onNavigate={navigate} className={view === item.view || item.view === 'markets' && view === 'auction' ? 'active' : ''} aria-current={view === item.view ? 'page' : undefined}>{item.label}</ViewLink>)}
        {view === 'home' && <a href="#auction-process" onClick={() => setMenuOpen(false)}>How it works</a>}
      </nav>
      <div className="header-actions">
        {view === 'home' ? <ViewLink className="header-primary" view="markets" onNavigate={navigate}>Launch app <ArrowUpRight /></ViewLink> : <button className="header-primary account" aria-label={account ? `Manage wallet ${shortAddress(account)}` : walletRestoring ? 'Restoring wallet connection' : walletLabel} aria-busy={walletRestoring} disabled={walletRestoring && !account} onClick={session.openIdentityDialog}>{walletRestoring && !account ? <LoaderCircle aria-hidden="true" /> : <WalletCards aria-hidden="true" />}<span>{walletLabel}</span></button>}
        <button className="mobile-menu" onClick={() => setMenuOpen(!menuOpen)} aria-label="Toggle navigation" aria-expanded={menuOpen}>{menuOpen ? <X /> : <Menu />}</button>
      </div>
    </header>
    {error && !identityDialogOpen && <div className="inline-error" role="alert"><ShieldAlert size={18} /><span>{error}</span><button onClick={() => void session.refresh()}><RefreshCw size={14} />Retry</button></div>}
    {wrongChain && !identityDialogOpen && <div className="inline-error" role="alert">Your wallet is on chain {walletChainId}. Connect to {config?.network} (chain {config?.chainId}) to submit transactions.<button onClick={() => void session.switchNetwork()}>Switch network</button></div>}
    {pendingTx && !identityDialogOpen && <div className="transaction-status" role="status"><LoaderCircle size={17} /><span><b>{pendingTx.label}</b> · {pendingTx.stage === 'signature' ? 'Confirm in your wallet' : 'Waiting for confirmation'}</span>{pendingTx.hash && <AddressLink value={pendingTx.hash} transaction />}</div>}
    <main id="main-content" key={view} tabIndex={-1}>{children}</main>
    <div className="environment-disclosure"><i />{config ? `${config.network} · chain ${config.chainId} · ${config.chainId === 31337 ? 'Local test assets; transactions run on your machine' : 'On-chain auction data'}` : 'Network configuration required'}</div>
    <WalletDialog />
    <AnimatePresence>{notice && !identityDialogOpen && <motion.div className={`notice ${notice.tone ?? 'neutral'}`} role="status" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}><i>{notice.tone === 'danger' ? <ShieldAlert /> : <Check />}</i><span><b>{notice.title}</b><small>{notice.body}</small></span><button onClick={session.dismissNotice} aria-label="Dismiss notification"><X /></button></motion.div>}</AnimatePresence>
  </div>
}
