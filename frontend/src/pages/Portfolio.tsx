import { ArrowDownLeft, ArrowRight, ArrowUpRight, ChevronDown, Download, Layers3, LoaderCircle, RefreshCw, WalletCards } from 'lucide-react'
import { useId, useState, type MouseEvent } from 'react'
import { AddressLink } from '../components/ui/ChainState'
import { ViewLink } from '../components/ViewLink'
import { useDemoSession } from '../context/DemoSessionContext'
import { portfolioAmount, portfolioOrders, preferredHolding } from '../lib/portfolio'
import { exportCsv, shortAddress } from '../utils/format'
import type { TokenHolding, View } from '../types'

type Navigation = { onNavigate: (view: View) => void }

function BalanceCard({ kind }: { kind: TokenHolding['kind'] }) {
  const { tokens, config } = useDemoSession()
  const [selected, setSelected] = useState<string | null>(null)
  const choices = tokens.filter(token => token.kind === kind)
  const token = preferredHolding(tokens, kind, selected || (kind === 'bond' ? config?.contracts.bondToken : config?.contracts.settlementToken))
  const cash = kind === 'settlement'
  const Icon = cash ? WalletCards : Layers3
  return <section className={`pf-balance ${cash ? 'pf-balance--cash' : 'pf-balance--bond'}`} aria-label={cash ? 'Cash token balance' : 'Bond balance'}>
    <div className="pf-balance-heading"><span><Icon size={17} aria-hidden="true" />{cash ? 'Cash token balance' : 'Bonds held'}</span>
      {choices.length > 1 ? <label className="pf-token-select"><span className="sr-only">{cash ? 'Choose cash token' : 'Choose bond token'}</span><select value={token?.address} onChange={event => setSelected(event.target.value)}>{choices.map(item => <option value={item.address} key={item.address}>{item.symbol} · {shortAddress(item.address)}</option>)}</select></label> : <span className="pf-token-symbol">{token?.symbol || '—'}</span>}
    </div>
    <p className="pf-balance-value" title={token ? `${token.balance} ${token.symbol}` : undefined}>{token ? portfolioAmount(token.balance) : '—'}</p>
    <div className="pf-balance-footer"><span>{token?.name || 'No token configured'}</span><small>{token ? token.symbol : 'Not available'}</small></div>
  </section>
}

function PortfolioAccount({ onNavigate }: Navigation) {
  const { account, tokens, rounds, settlements, config, selectRound, historyError, historyFromBlock, roundsTruncated, refresh, refreshing, blockNumber, chainTimestamp, connectionStatus } = useDemoSession()
  const orders = portfolioOrders(rounds, account)
  const [activity, setActivity] = useState<'orders' | 'settlements'>(() => orders.length ? 'orders' : 'settlements')
  const [showAll, setShowAll] = useState(false)
  const activityId = useId()
  const exportHoldings = () => exportCsv('clearing-bell-holdings.csv', [['Network', 'Account', 'Token', 'Symbol', 'Balance', 'Engine allowance'], ...tokens.map(token => [config?.network || '', account || '', token.address, token.symbol, token.balance, token.allowance])])
  const exportActivity = () => activity === 'settlements'
    ? exportCsv('clearing-bell-settlements.csv', [['Round', 'Side', 'Quantity', 'Bond', 'Price', 'Payment token', 'Transaction', 'Block'], ...settlements.map(item => [item.roundId, item.isBuy ? 'Buy' : 'Sell', item.quantity, item.bondSymbol, item.price, item.settlementSymbol, item.transactionHash, item.blockNumber])])
    : exportCsv('clearing-bell-orders.csv', [['Round', 'Side', 'Quantity', 'Bond', 'Limit price', 'Payment token'], ...orders.map(({ round, bid }) => [round.id, bid.isBuy ? 'Buy' : 'Sell', bid.quantity, round.bond.symbol, bid.price, round.settlement.symbol])])
  const openRound = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    selectRound(id)
    onNavigate('auction')
  }
  const activityCount = activity === 'orders' ? orders.length : settlements.length
  const limit = showAll ? activityCount : 5
  return <>
    {connectionStatus === 'error' && <p className="pf-notice" role="status">Updates unavailable. Showing the last fetched balances.</p>}
    <div className="pf-overview">
      <BalanceCard kind="settlement" />
      <BalanceCard kind="bond" />
      <button className="pf-order-summary" onClick={() => { setActivity('orders'); setShowAll(false); document.getElementById(activityId)?.scrollIntoView({ block: 'nearest', behavior: 'instant' }) }} aria-label={`View ${orders.length} open orders`}><span>Open orders</span><strong>{roundsTruncated ? `≥${orders.length}` : orders.length}</strong><span>View activity <ArrowRight size={17} aria-hidden="true" /></span></button>
    </div>

    <section className="pf-activity" id={activityId} aria-labelledby="portfolio-activity-title">
      <header className="pf-section-heading"><h2 id="portfolio-activity-title">Activity</h2><button className="pf-quiet-action" disabled={!activityCount} onClick={exportActivity}><Download size={16} aria-hidden="true" />Export</button></header>
      <div className="pf-activity-controls"><div className="pf-tabs" role="group" aria-label="Portfolio activity"><button aria-pressed={activity === 'orders'} onClick={() => { setActivity('orders'); setShowAll(false) }}>Open orders <span>{roundsTruncated ? '≥' : ''}{orders.length}</span></button><button aria-pressed={activity === 'settlements'} onClick={() => { setActivity('settlements'); setShowAll(false) }}>Settlements <span>{historyError ? '—' : settlements.length}</span></button></div><span className="pf-record-label">On-chain records</span></div>
      {activity === 'settlements' && historyError && <div className="pf-history-error" role="alert"><p>Settlement history is incomplete. Your balances are unaffected.</p><button className="pf-quiet-action" disabled={refreshing} onClick={() => void refresh()}>Retry history <RefreshCw size={15} aria-hidden="true" /></button></div>}
      {activityCount > 0 ? <div className="pf-table-scroll" tabIndex={0} role="region" aria-label={activity === 'orders' ? 'Open orders table' : 'Settlement history table'}>
        <table className="pf-table"><caption className="sr-only">{activity === 'orders' ? 'Unsettled orders for your connected wallet' : 'Confirmed settlements for your connected wallet'}</caption>
          <thead><tr><th scope="col">Security / round</th><th scope="col">Side</th><th scope="col">Quantity</th><th scope="col">{activity === 'orders' ? 'Limit price' : 'Clearing price'}</th><th scope="col">{activity === 'orders' ? 'Status' : 'Receipt'}</th></tr></thead>
          <tbody>{activity === 'orders' ? orders.slice(0, limit).map(({ round, bid }) => <tr key={`${round.id}-${bid.index}`}>
            <th scope="row"><a href={`/auction?round=${round.id}`} onClick={event => openRound(event, round.id)}><b>{round.bond.symbol}</b><span>Round {round.id.padStart(3, '0')} <ArrowUpRight size={12} aria-hidden="true" /></span></a></th>
            <td><span className={`pf-side ${bid.isBuy ? 'pf-side--buy' : ''}`}>{bid.isBuy ? <ArrowDownLeft size={14} aria-hidden="true" /> : <ArrowUpRight size={14} aria-hidden="true" />}{bid.isBuy ? 'Buy' : 'Sell'}</span></td>
            <td title={`${bid.quantity} ${round.bond.symbol}`}><strong>{portfolioAmount(bid.quantity)}</strong><small>{round.bond.symbol}</small></td>
            <td title={`${bid.price} ${round.settlement.symbol}`}><strong>{portfolioAmount(bid.price)}</strong><small>{round.settlement.symbol}</small></td>
            <td><span className="pf-order-state">{round.phase === 'clearing' ? 'Clearing' : chainTimestamp !== null && chainTimestamp >= round.deadline ? 'Awaiting close' : 'In auction'}</span></td>
          </tr>) : settlements.slice(0, limit).map(item => <tr key={item.id}>
            <th scope="row"><a href={`/auction?round=${item.roundId}`} onClick={event => openRound(event, item.roundId)}><b>{item.bondSymbol}</b><span>Round {item.roundId.padStart(3, '0')} <ArrowUpRight size={12} aria-hidden="true" /></span></a></th>
            <td><span className={`pf-side ${item.isBuy ? 'pf-side--buy' : ''}`}>{item.isBuy ? <ArrowDownLeft size={14} aria-hidden="true" /> : <ArrowUpRight size={14} aria-hidden="true" />}{item.isBuy ? 'Bought' : 'Sold'}</span></td>
            <td title={`${item.quantity} ${item.bondSymbol}`}><strong>{portfolioAmount(item.quantity)}</strong><small>{item.bondSymbol}</small></td>
            <td title={`${item.price} ${item.settlementSymbol}`}><strong>{portfolioAmount(item.price)}</strong><small>{item.settlementSymbol}</small></td>
            <td><AddressLink value={item.transactionHash} transaction /><small>Block {item.blockNumber}</small></td>
          </tr>)}</tbody>
        </table>
      </div> : !(activity === 'settlements' && historyError) && <div className="pf-empty-activity"><span className="pf-empty-symbol"><Layers3 size={23} aria-hidden="true" /></span><div><h3>{activity === 'orders' ? 'No open orders.' : 'No settlements yet.'}</h3><p>{activity === 'orders' ? 'Your next trade starts in the market.' : 'Matched trades will appear here after clearing.'}</p></div><ViewLink view="markets" onNavigate={onNavigate} className="pf-quiet-action">Explore markets <ArrowUpRight size={16} aria-hidden="true" /></ViewLink></div>}
      {activityCount > 5 && <button className="pf-show-more" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show latest 5' : `Show all ${activityCount} records`}<ChevronDown size={16} aria-hidden="true" /></button>}
      {(activity === 'orders' && orders.length > 0 || activity === 'settlements' || roundsTruncated) && <footer className="pf-activity-note">{activity === 'orders' ? 'Orders are not escrowed or cancellable. Keep balances and approvals available until settlement.' : `History from block ${historyFromBlock ?? '—'}. Latest 20,000 blocks and 100 rounds.`}{roundsTruncated && ' Older rounds are not fully loaded.'}</footer>}
    </section>

    <details className="pf-details">
      <summary><span>Token details & approvals</span><span>{tokens.length} {tokens.length === 1 ? 'asset' : 'assets'}<ChevronDown size={17} aria-hidden="true" /></span></summary>
      <div className="pf-details-body"><div className="pf-details-intro"><p>Balances and allowances for tokens used in this market. Token quantities are not a portfolio valuation.</p><button className="pf-quiet-action" onClick={exportHoldings} disabled={!tokens.length}><Download size={16} aria-hidden="true" />Export balances</button></div>
        <div className="pf-table-scroll" tabIndex={0} role="region" aria-label="Token balances and approvals table"><table className="pf-table"><caption className="sr-only">Exact token balances and auction-engine allowances</caption><thead><tr><th scope="col">Asset</th><th scope="col">Token address</th><th scope="col">Exact balance</th><th scope="col">Engine allowance</th></tr></thead><tbody>{tokens.map(token => <tr key={token.address}><th scope="row"><b>{token.symbol}</b><small>{token.name}</small></th><td><AddressLink value={token.address} /></td><td className="pf-exact-number">{token.balance}<small>{token.symbol}</small></td><td className="pf-exact-number">{token.allowance}<small>{token.symbol}</small></td></tr>)}</tbody></table></div>
        {!tokens.length && <p className="pf-empty-token">No tracked token balances are available.</p>}
      </div>
    </details>
    <footer className="pf-footnote"><span>{account && <AddressLink value={account} />}</span><span>{connectionStatus === 'error' ? 'Last fetched' : 'Read from contracts'} · block {blockNumber ?? '—'}</span></footer>
  </>
}

export function Portfolio({ onNavigate }: Navigation) {
  const session = useDemoSession()
  const { account, walletRestoring, walletStatus, connectionStatus, blockNumber, refresh, refreshing, openIdentityDialog } = session
  const loading = walletRestoring || connectionStatus === 'loading'
  return <div className="portfolio-page"><div className="pf-workbench">
    <header className="pf-masthead"><div><span className="pf-eyebrow">YOUR ACCOUNT</span><h1>Portfolio</h1></div><div className="pf-header-actions">{account && <button className="pf-icon-button" aria-label="Refresh portfolio" disabled={refreshing || loading} onClick={() => void refresh()}><RefreshCw size={18} className={refreshing ? 'pf-spin' : ''} aria-hidden="true" /></button>}<ViewLink view="markets" onNavigate={onNavigate} className="pf-primary-action">Explore markets <ArrowUpRight size={17} aria-hidden="true" /></ViewLink></div></header>
    {loading ? <section className="pf-loading" role="status" aria-busy="true"><LoaderCircle size={22} aria-hidden="true" className="pf-spin" /><p>{walletRestoring ? 'Restoring your wallet…' : 'Reading your balances…'}</p><div className="pf-loading-lines" aria-hidden="true"><i /><i /></div></section>
      : account && blockNumber ? <PortfolioAccount key={account} onNavigate={onNavigate} />
      : account || connectionStatus === 'error' ? <section className="pf-connect"><WalletCards size={32} aria-hidden="true" /><h2>Balances unavailable.</h2><p>{account ? 'Your wallet connection is retained. Retry when the network is available.' : 'The market connection is unavailable. Retry to load your portfolio.'}</p><button className="pf-primary-action" disabled={refreshing} onClick={() => void refresh()}>Retry connection <RefreshCw size={17} aria-hidden="true" /></button></section>
      : <section className="pf-connect"><span className="pf-connect-emblem"><WalletCards size={28} aria-hidden="true" /></span><span className="pf-eyebrow">YOUR ASSETS, IN ONE PLACE</span><h2>{walletStatus === 'unavailable' ? 'Reconnect your wallet.' : 'A clearer view of what you hold.'}</h2><p>{walletStatus === 'unavailable' ? 'Unlock your wallet or reconnect to restore your portfolio.' : 'Your balances, orders and settlements. One connected wallet.'}</p><button className="pf-primary-action" onClick={openIdentityDialog}>Connect wallet <ArrowRight size={18} aria-hidden="true" /></button><small>Connecting never moves funds or approves tokens.</small></section>}
  </div></div>
}
