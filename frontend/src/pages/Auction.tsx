
import { ArrowLeft, ArrowRight, ArrowRightLeft, CheckCircle2, RefreshCw, ShieldCheck, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AuctionDepthChart } from '../components/auction/AuctionDepthChart'
import { OrderComposer } from '../components/auction/OrderComposer'
import { ProtocolReceipt } from '../components/auction/ProtocolReceipt'
import { PanelHeader, StatusBadge } from '../components/ui/Primitives'
import { AddressLink, ChainState, TxLink } from '../components/ui/ChainState'
import { Dialog } from '../components/ui/Dialog'
import { ViewLink } from '../components/ViewLink'
import { useDemoSession } from '../context/DemoSessionContext'
import { amount, dateTime, shortAddress } from '../utils/format'
import type { View } from '../types'

export function Auction({ onNavigate }: { onNavigate: (view: View) => void }) {
  const [receiptOpen, setReceiptOpen] = useState(false)
  const [closeOpen, setCloseOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const { selectedRound: round, rounds, selectRound, account, config, isIssuer, eligibility, paused, closeRound, pendingTx, refresh, refreshing, settlements } = useDemoSession()
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  const seconds = Math.max(0, (round?.deadline || 0) - Math.floor(now / 1000))
  const clock = seconds > 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m` : `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  const canClose = Boolean(account && round?.phase === 'open' && (isIssuer || now / 1000 > round.deadline) && !paused)
  const deadlinePassed = seconds === 0

  // Settlements for the selected round
  const roundSettlements = settlements.filter(s => round && s.roundId === round.id)

  return <div className="workspace auction-page">
    <div className="auction-utility">
      <ViewLink view="markets" onNavigate={onNavigate}><ArrowLeft />All markets</ViewLink>
      <span>AUCTION WORKSPACE</span>
      <button disabled={refreshing} onClick={() => void refresh(true)}><RefreshCw className={refreshing ? 'is-refreshing' : ''} />{refreshing ? 'Refreshing' : 'Refresh'}</button>
    </div>
    <ChainState>{round ? <div className="auction-content">
      <header className="auction-heading">
        <div className="auction-identity"><span className="auction-token-mark" aria-hidden="true">{round.bond.symbol.slice(0, 2)}</span><div><p>{round.bond.symbol} <span>/ {round.settlement.symbol}</span></p><h1>{round.bond.name}</h1></div></div>
        <label className="auction-round-selector"><span>AUCTION ROUND</span><select aria-label="Select auction round" value={round.id} disabled={Boolean(pendingTx)} onChange={event => selectRound(event.target.value)}>{rounds.map(item => <option key={item.id} value={item.id}>#{item.id.padStart(3, '0')} · {item.phase === 'closed' ? 'Closed' : 'Open'}</option>)}</select></label>
      </header>
      <dl className="auction-overview">
        <div><dt>Order book</dt><dd>{round.bidCount}<small>public orders</small></dd></div>
        <div><dt>{round.phase === 'closed' ? 'Round ended' : 'Bidding closes in'}</dt><dd>{round.phase === 'closed' ? 'Closed' : seconds ? clock : 'Awaiting close'}</dd><small>{dateTime(round.deadline)}</small></div>
        <div><dt>Final clearing price</dt><dd>{round.clearedQuantityRaw > 0n ? amount(round.clearingPrice) : '—'}<small>{round.settlement.symbol}</small></dd><small>{round.phase === 'closed' ? `${amount(round.clearedQuantity)} bonds matched` : 'Determined at settlement'}</small></div>
        <div><dt>Market status</dt><dd><StatusBadge tone={paused ? 'danger' : round.phase === 'open' ? 'live' : 'success'}>{paused ? 'Paused' : round.phase === 'open' && deadlinePassed ? 'Awaiting close' : round.phase === 'closed' ? 'Settled' : 'Open for orders'}</StatusBadge></dd><small>Uniform-price auction</small></div>
      </dl>
      <div className="auction-trading-layout">
        <div className="auction-book-column">
          <AuctionDepthChart round={round} />
          <section className="auction-orders-panel">
            <PanelHeader eyebrow="PUBLIC ORDER BOOK" title="Submitted orders" action={<span>{round.bidCount} total</span>} />
            <div className="table-scroll"><table className="data-table">
              <caption className="sr-only">Submitted auction orders with limit price, quantity and wallet address</caption>
              <thead><tr><th scope="col">Side / order</th><th scope="col">Limit price</th><th scope="col">Quantity</th><th scope="col">Wallet</th></tr></thead>
              <tbody>{round.bids.map(bid => <tr key={bid.index}><th scope="row"><span className={bid.isBuy ? 'auction-side is-buy' : 'auction-side'}>{bid.isBuy ? 'Buy' : 'Sell'}</span><small>#{Number(bid.index) + 1}</small></th><td>{amount(bid.price, 6)}<small>{round.settlement.symbol}</small></td><td>{amount(bid.quantity, 6)}<small>{round.bond.symbol}</small></td><td><AddressLink value={bid.bidder} />{bid.bidder.toLowerCase() === account?.toLowerCase() && <small>Your order</small>}</td></tr>)}</tbody>
            </table></div>
            {round.bids.length === 0 && <p className="auction-order-empty">No orders yet. The first eligible limit order starts the book.</p>}
          </section>
        </div>
        <OrderComposer deadlinePassed={deadlinePassed} onCommitted={() => setReceiptOpen(true)} onBrowseMarkets={() => onNavigate('markets')} />
      </div>

      {/* ── Settlement & Execution Result (only when closed) ─────────────────── */}
      {round.phase === 'closed' && round.clearedQuantityRaw > 0n && (
        <div className="auction-execution-panel">
          {/* Clearing result summary */}
          <section className="exec-card exec-card--result">
            <PanelHeader eyebrow="UNIFORM-PRICE AUCTION RESULT" title="Clearing & DvP Settlement" action={<CheckCircle2 className="exec-icon exec-icon--success" />} />
            <div className="exec-result-grid">
              <div className="exec-stat">
                <span>Clearing price</span>
                <strong>{amount(round.clearingPrice)} <small>{round.settlement.symbol}</small></strong>
                <p>All matched bids fill at this single price regardless of their limit.</p>
              </div>
              <div className="exec-stat">
                <span>Volume matched</span>
                <strong>{amount(round.clearedQuantity)} <small>{round.bond.symbol}</small></strong>
                <p>Total bonds exchanged in this round at the uniform clearing price.</p>
              </div>
              <div className="exec-stat">
                <span>Gross settlement</span>
                <strong>{amount((Number(round.clearingPrice) * Number(round.clearedQuantity)).toFixed(2))} <small>{round.settlement.symbol}</small></strong>
                <p>Total {round.settlement.symbol} transferred to sellers. Delivery vs Payment, atomic on-chain.</p>
              </div>
            </div>
          </section>

          {/* DvP Settlement transactions */}
          {roundSettlements.length > 0 && (
            <section className="exec-card exec-card--txns">
              <PanelHeader eyebrow="ON-CHAIN TRANSACTIONS" title="Settlement records" action={<ArrowRightLeft className="exec-icon" />} />
              <p className="exec-card-desc">Each matched order settled atomically. Bonds and cash transferred simultaneously with no counterparty risk.</p>
              <div className="table-scroll"><table className="data-table exec-txn-table">
                <thead><tr>
                  <th scope="col">Participant</th>
                  <th scope="col">Side</th>
                  <th scope="col">Quantity</th>
                  <th scope="col">Price</th>
                  <th scope="col">HashScan</th>
                </tr></thead>
                <tbody>{roundSettlements.map(s => (
                  <tr key={s.id}>
                    <td><AddressLink value={s.bidder} /></td>
                    <td><span className={s.isBuy ? 'auction-side is-buy' : 'auction-side'}>{s.isBuy ? 'Buy' : 'Sell'}</span></td>
                    <td>{amount(s.quantity)} <small>{s.bondSymbol}</small></td>
                    <td>{amount(s.price)} <small>{s.settlementSymbol}</small></td>
                    <td><TxLink hash={s.transactionHash} label="View on HashScan" /></td>
                  </tr>
                ))}</tbody>
              </table></div>
            </section>
          )}

          {/* Uniswap v4 Hook section */}
          <section className="exec-card exec-card--hook">
            <PanelHeader eyebrow="UNISWAP V4 HOOK" title="Swap interception & routing" action={<Zap className="exec-icon exec-icon--hook" />} />
            <div className="exec-hook-grid">
              <div className="exec-hook-flow">
                <div className="hook-step">
                  <span className="hook-step-num">1</span>
                  <div><strong>User initiates swap</strong><p>A swap request hits the Uniswap v4 PoolManager for the bond/USDC pool.</p></div>
                </div>
                <div className="hook-step hook-step--active">
                  <span className="hook-step-num">2</span>
                  <div><strong>beforeSwap intercepted</strong><p>ClearingBell hook intercepts the swap in <code>beforeSwap</code>. Instead of AMM pricing, the order is queued into the active auction round as a bid.</p></div>
                </div>
                <div className="hook-step">
                  <span className="hook-step-num">3</span>
                  <div><strong>Clearing price synced</strong><p>After <code>closeAndClear()</code>, the hook calls <code>afterEpochClose()</code> to sync the uniform clearing price on-chain.</p></div>
                </div>
                <div className="hook-step">
                  <span className="hook-step-num">4</span>
                  <div><strong>Settlement at clearing price</strong><p>All intercepted swaps fill at the uniform clearing price — not AMM spot. No slippage, no MEV.</p></div>
                </div>
              </div>
              <div className="exec-hook-stats">
                <div className="exec-stat">
                  <span>Hook address</span>
                  <strong className="exec-monospace">ClearingBellHookTestnet</strong>
                  <p>Deployed on Hedera testnet. Bypasses BaseHook address validation for demo.</p>
                </div>
                <div className="exec-stat">
                  <span>Clearing price synced</span>
                  <strong>{amount(round.clearingPrice)} {round.settlement.symbol}</strong>
                  <p>Value written to <code>lastClearingPrice[bondToken]</code> on the hook after epoch close.</p>
                </div>
                <div className="exec-stat exec-stat--note">
                  <span>To run the hook demo</span>
                  <code className="exec-cmd">npx tsx scripts/demo-hook-swap.ts</code>
                  <p>Opens a new round (N+1), dispatches two hook-intercepted swaps via TestnetPoolManager, closes &amp; clears, syncs price to hook.</p>
                </div>
              </div>
            </div>
          </section>
        </div>
      )}

      <div className="auction-settlement-grid">
        <section><PanelHeader eyebrow="SETTLEMENT" title={round.phase === 'closed' ? 'Round complete' : 'Close and clear'} /><p>{round.phase === 'closed' ? round.clearedQuantityRaw > 0n ? `${amount(round.clearedQuantity)} bonds exchanged at ${amount(round.clearingPrice)} ${round.settlement.symbol} per bond.` : 'This round closed without a matching trade.' : 'The issuer can close early. After the deadline, any connected wallet can clear the round. Eligible matches and token transfers execute together.'}</p>{round.phase === 'open' && <button className="primary-action" disabled={!canClose || Boolean(pendingTx)} onClick={() => setCloseOpen(true)}>Close and settle round <ArrowRight /></button>}<p className="privacy-note">Funds are not escrowed. A failed transfer reverts the entire settlement.</p></section>
        <section><PanelHeader eyebrow="CONTRACT RECORD" title="Asset and eligibility" action={<ShieldCheck />} /><dl className="auction-proof-data"><div><dt>Bond token</dt><dd><AddressLink value={round.bondToken} /></dd></div><div><dt>Payment token</dt><dd><AddressLink value={round.settlementToken} /></dd></div><div><dt>Your eligibility</dt><dd>{!account ? 'Connect to check' : eligibility === true ? 'Eligible' : eligibility === false ? 'Not eligible' : 'Checking'}</dd></div><div><dt>Auction engine</dt><dd>{config && <AddressLink value={config.contracts.auctionEngine} />}</dd></div></dl></section>
      </div>
      <Dialog open={closeOpen} onClose={() => { if (!pendingTx) setCloseOpen(false) }} titleId="close-round-title" className="auction-confirm-dialog"><span className="dialog-index">ROUND {round.id} / IRREVERSIBLE ACTION</span><h2 id="close-round-title">Close this auction?</h2><p>This ends bidding and executes eligible matches. {seconds > 0 && 'You are closing before the scheduled deadline. '}The transaction is sent from {shortAddress(account)}.</p><button className="primary-action receipt-action" disabled={!canClose || Boolean(pendingTx)} onClick={async () => { if (await closeRound(round.id)) setCloseOpen(false) }}>{pendingTx ? 'Confirming settlement…' : 'Confirm close and settle'}</button></Dialog>
    </div> : <section className="empty-state"><h2>No auction selected</h2><p>Explore the directory to choose a round, or open one from the issuer console.</p><ViewLink className="primary-action" view="markets" onNavigate={onNavigate}>View markets <ArrowRight /></ViewLink></section>}</ChainState>
    <ProtocolReceipt open={receiptOpen} onClose={() => setReceiptOpen(false)} onNavigate={onNavigate} />
  </div>
}
