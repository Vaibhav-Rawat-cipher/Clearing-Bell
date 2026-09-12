import { ArrowRight, ArrowUpRight, CirclePause, Code2, ExternalLink, Play, Plus, ShieldCheck, WalletCards } from 'lucide-react'
import { useState, type MouseEvent } from 'react'
import { isAddress } from 'viem'
import { AuctionDepthChart } from '../components/auction/AuctionDepthChart'
import { useDemoSession } from '../context/DemoSessionContext'
import { AddressLink, ChainState } from '../components/ui/ChainState'
import { Dialog } from '../components/ui/Dialog'
import { amount, dateTime } from '../utils/format'
import type { LiveRound, View } from '../types'

function IssuerRoundStatus({ phase }: { phase: LiveRound['phase'] }) {
  return <span className={`issuer-round-status is-${phase}`}><i aria-hidden="true" />{phase === 'open' ? 'Open' : phase === 'closed' ? 'Closed' : 'Clearing'}</span>
}

export function Issuer({ onNavigate }: { onNavigate: (view: View) => void }) {
  const [dialog, setDialog] = useState<'open' | 'pause' | null>(null)
  const [bond, setBond] = useState('')
  const [settlement, setSettlement] = useState('')
  const [minutes, setMinutes] = useState('60')
  const [focusId, setFocusId] = useState('')
  const [filter, setFilter] = useState('all')
  const { config, account, issuer, isIssuer, isPlatformAdmin, paused, rounds, selectedRound, selectRound, openRound, setPaused, pendingTx, openIdentityDialog, blockNumber, roundsTruncated, chainTimestamp } = useDemoSession()
  const latest = [...rounds].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? 1 : BigInt(a.id) > BigInt(b.id) ? -1 : 0)
  const current = latest.find(round => round.id === focusId) || latest.find(round => round.phase === 'open') || latest[0] || null
  const shownRounds = latest.filter(round => filter === 'all' || round.phase === filter)
  const sameToken = Boolean(bond.trim() && settlement.trim() && bond.trim().toLowerCase() === settlement.trim().toLowerCase())
  const validWindow = /^\d+$/.test(minutes) && Number(minutes) >= 1 && Number(minutes) <= 10080
  const invalid = !isAddress(bond.trim()) || !isAddress(settlement.trim()) || sameToken || !validWindow
  const busy = Boolean(pendingTx)
  const deadlinePassed = current && chainTimestamp !== null && chainTimestamp >= current.deadline
  const openRoundDialog = () => {
    setBond(config?.contracts.bondToken || selectedRound?.bondToken || '')
    setSettlement(config?.contracts.settlementToken || selectedRound?.settlementToken || '')
    setDialog('open')
  }
  const goToRound = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    selectRound(id)
    onNavigate('auction')
  }
  const confirmOpen = async () => {
    if (invalid || !isIssuer || paused || busy) return
    if (await openRound({ bondToken: bond.trim(), settlementToken: settlement.trim(), bidWindowSeconds: Number(minutes) * 60 })) {
      setDialog(null)
      setFocusId('')
      setFilter('all')
    }
  }

  return <div className="issuer-console">
    <div className="issuer-workspace">
      <header className="issuer-masthead">
        <div><span className="issuer-eyebrow">MARKET OPERATIONS</span><h1>Issuer console</h1><p>Manage auction windows and the controls behind the market.</p></div>
        <div className="issuer-header-actions">
          {isIssuer ? <><button className="issuer-secondary-button" disabled={busy} onClick={() => setDialog('pause')}>{paused ? <Play size={16} /> : <CirclePause size={16} />}{paused ? 'Resume trading' : 'Pause trading'}</button><button className="issuer-primary-button" disabled={paused || busy} onClick={openRoundDialog}><Plus size={17} />Open a round</button></> : <button className="issuer-primary-button" onClick={openIdentityDialog}><WalletCards size={17} />{account ? 'Switch issuer wallet' : 'Connect issuer wallet'}</button>}
        </div>
      </header>

      <ChainState>
        <div className="issuer-authority-bar">
          <span><ShieldCheck size={15} aria-hidden="true" /><b>{isPlatformAdmin ? 'Platform admin' : isIssuer ? 'Bond issuer access' : 'Read-only access'}</b></span>
          <span className={`issuer-trading-state ${paused ? 'is-paused' : ''}`}><i aria-hidden="true" />Trading {paused ? 'paused' : 'enabled'}</span>
          <span className="issuer-network-record">{config?.network}<i aria-hidden="true">/</i>Chain {config?.chainId}</span>
        </div>
        {!isIssuer && !isPlatformAdmin && <p className="issuer-access-note">All contract records are visible. Only a registered bond issuer can open rounds. The platform admin can register new issuers.</p>}
        {paused && <div className="issuer-pause-notice" role="status">New rounds, new orders and clearing are paused. Existing deadlines continue to run.</div>}

        <dl className="issuer-summary-strip">
          <div><dt>Open rounds</dt><dd>{rounds.filter(round => round.phase === 'open').length}</dd></div>
          <div><dt>Closed rounds</dt><dd>{rounds.filter(round => round.phase === 'closed').length}</dd></div>
          <div><dt>Orders received</dt><dd>{rounds.reduce((sum, round) => sum + round.bidCount, 0)}</dd></div>
          <div><dt>Latest block</dt><dd>{blockNumber || '—'}</dd></div>
        </dl>

        {current ? <section className="issuer-current-round" aria-labelledby="issuer-current-title">
          <div className="issuer-round-card">
            <header className="issuer-card-heading"><span className="issuer-eyebrow">ROUND MONITOR</span><label className="issuer-round-picker"><span className="sr-only">Round to monitor</span><select value={current.id} onChange={event => setFocusId(event.target.value)}>{latest.map(round => <option key={round.id} value={round.id}>Round {round.id.padStart(3, '0')}</option>)}</select></label></header>
            <div className="issuer-current-title"><h2 id="issuer-current-title">{current.bond.symbol}</h2><IssuerRoundStatus phase={current.phase} /></div>
            <p className="issuer-security-name">{current.bond.name}</p>
            <dl className="issuer-round-stats">
              <div><dt>Public orders</dt><dd>{current.bidCount}</dd></div>
              <div><dt>Matched quantity</dt><dd>{current.phase === 'closed' ? amount(current.clearedQuantity) : '—'} <small>{current.bond.symbol}</small></dd></div>
              <div><dt>Bid deadline</dt><dd className="issuer-date-value">{dateTime(current.deadline)}</dd></div>
              <div><dt>Clearing price</dt><dd>{current.phase === 'closed' && current.clearedQuantityRaw > 0n ? <>{amount(current.clearingPrice)} <small>{current.settlement.symbol}</small></> : <span className="issuer-stat-caption">{current.phase === 'closed' ? 'No matched orders' : 'Not cleared'}</span>}</dd></div>
            </dl>
            <a className="issuer-round-link" href={`/auction?round=${current.id}`} onClick={event => goToRound(event, current.id)}>Review round {current.id.padStart(3, '0')} <ArrowUpRight size={18} /></a>
            {current.phase === 'open' && deadlinePassed && <p className="issuer-deadline-note">Bidding has ended. Review the order book to close this round.</p>}
          </div>
          <div className="issuer-depth-card"><AuctionDepthChart round={current} compact /></div>
        </section> : <section className="issuer-empty-register"><Plus size={24} aria-hidden="true" /><h2>No auction rounds yet</h2><p>{isIssuer ? 'Open the first window for your registered bond and payment token.' : 'New rounds will appear here when the issuer opens bidding.'}</p>{isIssuer && <button className="issuer-primary-button" disabled={paused || busy} onClick={openRoundDialog}>Open the first round <ArrowRight size={17} /></button>}</section>}

        <section className="issuer-register" aria-labelledby="issuer-register-title">
          <header className="issuer-section-heading"><div><h2 id="issuer-register-title">Round register</h2><p>{roundsTruncated ? 'Latest 100 rounds' : `${rounds.length} ${rounds.length === 1 ? 'round' : 'rounds'} on record`}</p></div><label className="issuer-register-filter"><span className="sr-only">Filter issuer rounds</span><select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All rounds</option><option value="open">Open rounds</option><option value="closed">Closed rounds</option></select></label></header>
          <div className="table-scroll issuer-register-scroll"><table className="issuer-register-table"><caption className="sr-only">Issuer auction rounds and their recorded results</caption><thead><tr><th scope="col">Round / security</th><th scope="col">Bid deadline</th><th scope="col">Orders</th><th scope="col">Matched bonds</th><th scope="col">Clearing price</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Review round</span></th></tr></thead><tbody>{shownRounds.map(round => <tr key={round.id}>
            <th scope="row"><a className="issuer-security-link" href={`/auction?round=${round.id}`} onClick={event => goToRound(event, round.id)}><b>Round {round.id.padStart(3, '0')}</b><small>{round.bond.symbol} / {round.settlement.symbol}</small></a></th>
            <td><time dateTime={new Date(round.deadline * 1000).toISOString()}>{dateTime(round.deadline)}</time></td>
            <td>{round.bidCount}</td>
            <td>{round.phase === 'closed' ? amount(round.clearedQuantity) : '—'}</td>
            <td>{round.phase === 'closed' && round.clearedQuantityRaw > 0n ? <>{amount(round.clearingPrice)} <small>{round.settlement.symbol}</small></> : <span className="issuer-table-muted">{round.phase === 'closed' ? 'No match' : 'Not cleared'}</span>}</td>
            <td><IssuerRoundStatus phase={round.phase} /></td>
            <td><a className="issuer-table-action" href={`/auction?round=${round.id}`} aria-label={`Review auction round ${round.id}`} onClick={event => goToRound(event, round.id)}><ArrowRight size={18} /></a></td>
          </tr>)}</tbody></table></div>
          {!shownRounds.length && <p className="issuer-register-empty">{rounds.length ? 'No rounds with this status.' : 'No rounds have been created by this engine.'}</p>}
        </section>

        <div className="issuer-records-grid">
          <section className="issuer-record-panel" aria-labelledby="issuer-authority-title"><header className="issuer-record-heading"><h2 id="issuer-authority-title">Issuer authority</h2><ShieldCheck size={19} aria-hidden="true" /></header><p>The engine verifies the signer before allowing operational changes.</p><dl className="issuer-record-list">
            <div><dt>Authorized issuer</dt><dd>{issuer ? <AddressLink value={issuer} /> : 'Unavailable'}</dd></div>
            <div><dt>Connected account</dt><dd>{account ? <AddressLink value={account} /> : 'Not connected'}</dd></div>
            <div><dt>Permissions</dt><dd className={isIssuer ? 'issuer-permission-active' : ''}>{isIssuer ? 'Manage rounds and trading' : 'Inspect records only'}</dd></div>
          </dl></section>
          <section className="issuer-record-panel" aria-labelledby="issuer-deployment-title"><header className="issuer-record-heading"><h2 id="issuer-deployment-title">Deployment record</h2><Code2 size={19} aria-hidden="true" /></header>{config && <dl className="issuer-record-list">{Object.entries(config.contracts).filter((entry): entry is [string, `0x${string}`] => Boolean(entry[1])).map(([name, address]) => <div key={name}><dt>{name.replace(/([A-Z])/g, ' $1')}</dt><dd><AddressLink value={address} /></dd></div>)}</dl>}<a className="issuer-source-link" href="https://github.com/AmrendraTheCoder/Clearing-Bell/tree/main/contracts/src" target="_blank" rel="noreferrer">Contract source <ExternalLink size={14} /></a></section>
        </div>

        <section className="issuer-record-panel" style={{ marginTop: '24px' }} aria-labelledby="issuer-flow-title">
          <header className="issuer-record-heading">
            <h2 id="issuer-flow-title">Multi-Issuer Lifecycle</h2>
          </header>
          <p style={{ marginTop: 0, marginBottom: '16px' }}>How companies list and manage bonds on the platform.</p>
          
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '24px' }}>
            <div>
              <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--issuer-text)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Backend Admin Setup (One-Time)</h3>
              <ul style={{ fontSize: '13px', color: 'var(--issuer-muted)', paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '8px', margin: 0 }}>
                <li><b>1. Get Whitelisted (Platform Admin):</b> Admin calls <code>AuctionEngine.registerBondIssuer()</code>.</li>
                <li><b>2. Connect Compliance (Company):</b> Company links ATS registry via <code>ComplianceGate.registerRegistry()</code>.</li>
                <li><b>3. Configure Bond (Company):</b> Company registers engine and token via <code>BondConfig.configure()</code>.</li>
              </ul>
            </div>
            <div>
              <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--issuer-text)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Frontend Dashboard (Daily Operations)</h3>
              <ul style={{ fontSize: '13px', color: 'var(--issuer-muted)', paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '8px', margin: 0 }}>
                <li><b>4. Open a Round:</b> Click "Open a round" above to start a live auction for your bond.</li>
                <li><b>5. Close and Clear:</b> Click "Close Round" to automatically calculate the uniform clearing price and settle trades.</li>
              </ul>
            </div>
          </div>
        </section>
      </ChainState>
    </div>

    <Dialog open={dialog !== null} onClose={() => { if (!busy) setDialog(null) }} titleId="issuer-dialog-title" className="issuer-confirmation-dialog">
      <span className="issuer-dialog-eyebrow">ISSUER ACTION / {config?.network}</span>
      <h2 id="issuer-dialog-title">{dialog === 'open' ? 'Open an auction round' : paused ? 'Resume trading?' : 'Pause all trading?'}</h2>
      {dialog === 'open' ? <>
        <p>Choose a registered 18-decimal bond token and an ERC-20 payment token. The window starts when the transaction confirms.</p>
        <div className="issuer-field"><label htmlFor="issuer-bond-token">Bond token address</label><input id="issuer-bond-token" value={bond} onChange={event => setBond(event.target.value)} placeholder="0x…" disabled={busy} autoComplete="off" spellCheck={false} aria-invalid={Boolean(bond && !isAddress(bond.trim()))} aria-describedby="issuer-bond-help" /><small id="issuer-bond-help">{bond && !isAddress(bond.trim()) ? 'Enter a valid EVM token address.' : 'Registered bond token with 18 decimals.'}</small></div>
        <div className="issuer-field"><label htmlFor="issuer-payment-token">Payment token address</label><input id="issuer-payment-token" value={settlement} onChange={event => setSettlement(event.target.value)} placeholder="0x…" disabled={busy} autoComplete="off" spellCheck={false} aria-invalid={Boolean(settlement && !isAddress(settlement.trim())) || sameToken} aria-describedby="issuer-payment-help" /><small id="issuer-payment-help">{sameToken ? 'Choose a different token for payment.' : settlement && !isAddress(settlement.trim()) ? 'Enter a valid EVM token address.' : 'ERC-20 token used to price and settle this round.'}</small></div>
        <div className="issuer-field"><label htmlFor="issuer-bid-window">Bidding window</label><div className="issuer-unit-field"><input id="issuer-bid-window" value={minutes} onChange={event => setMinutes(event.target.value)} inputMode="numeric" disabled={busy} aria-invalid={!validWindow} aria-describedby="issuer-window-help" /><span>minutes</span></div><small id="issuer-window-help">{validWindow ? '1 minute to 7 days. The issuer may close early.' : 'Enter a whole number from 1 to 10,080.'}</small></div>
        <div className="issuer-confirmation-actions"><button className="issuer-secondary-button" disabled={busy} onClick={() => setDialog(null)}>Cancel</button><button className="issuer-primary-button" disabled={invalid || !isIssuer || paused || busy} onClick={() => void confirmOpen()}>{busy ? pendingTx?.stage === 'signature' ? 'Check your wallet…' : 'Opening round…' : 'Confirm and open'}<ArrowRight size={17} /></button></div>
      </> : <>
        <p>{paused ? 'New orders, new rounds and clearing will become available again. Existing deadlines do not change.' : 'This stops new rounds, new orders and clearing across the entire engine. Existing bids remain recorded. Deadlines continue to run.'}</p>
        <div className="issuer-confirmation-actions"><button className="issuer-secondary-button" disabled={busy} onClick={() => setDialog(null)}>Cancel</button><button className={`issuer-primary-button ${!paused ? 'issuer-danger-button' : ''}`} disabled={!isIssuer || busy} onClick={async () => { if (await setPaused(!paused)) setDialog(null) }}>{busy ? 'Confirming…' : paused ? 'Confirm resume' : 'Confirm pause'}</button></div>
      </>}
    </Dialog>
  </div>
}
