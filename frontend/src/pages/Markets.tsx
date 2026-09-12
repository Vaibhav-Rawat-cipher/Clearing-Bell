import { ArrowDownUp, ArrowRight, ArrowUpRight, Layers3, RefreshCw, Search } from 'lucide-react'
import { useState, type MouseEvent } from 'react'
import { formatUnits } from 'viem'
import { ViewLink } from '../components/ViewLink'
import { MarketDepth } from '../components/scene/MarketDepth'
import { AuctionDepthChart } from '../components/auction/AuctionDepthChart'
import { ChainState } from '../components/ui/ChainState'
import { useDemoSession } from '../context/DemoSessionContext'
import { amount, dateTime } from '../utils/format'
import type { LiveRound, View } from '../types'

type MarketFilter = 'ALL' | 'OPEN' | 'CLOSED'

function orderQuantity(round: LiveRound, isBuy: boolean) {
  const raw = round.bids.reduce((sum, bid) => bid.isBuy === isBuy ? sum + bid.quantityRaw : sum, 0n)
  return amount(formatUnits(raw, round.bond.decimals))
}

function MarketPhase({ phase }: { phase: LiveRound['phase'] }) {
  return <span className={`market-phase market-phase-${phase}`}><i aria-hidden="true" />{phase === 'open' ? 'Open' : phase === 'closed' ? 'Closed' : 'Clearing'}</span>
}

export function Markets({ onNavigate }: { onNavigate: (view: View) => void }) {
  const [filter, setFilter] = useState<MarketFilter>('ALL')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('newest')
  const [visual, setVisual] = useState<'chart' | 'spatial'>('chart')
  const { rounds, selectRound, refresh, refreshing, paused, chainTimestamp, roundsTruncated } = useDemoSession()
  const latest = [...rounds].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? 1 : BigInt(a.id) > BigInt(b.id) ? -1 : 0)
  const featured = latest.find(round => round.phase === 'open') || latest[0] || null
  const lastCleared = featured && latest.find(round => round.phase === 'closed' && round.clearedQuantityRaw > 0n && round.bondToken.toLowerCase() === featured.bondToken.toLowerCase() && round.settlementToken.toLowerCase() === featured.settlementToken.toLowerCase())
  const rows = latest.filter(round => (filter === 'ALL' || round.phase.toUpperCase() === filter) && `${round.bond.name} ${round.bond.symbol} ${round.settlement.symbol} ${round.id}`.toLowerCase().includes(query.trim().toLowerCase()))
  if (sort === 'oldest') rows.reverse()
  const counts = { ALL: rounds.length, OPEN: rounds.filter(round => round.phase === 'open').length, CLOSED: rounds.filter(round => round.phase === 'closed').length }
  const deadlinePassed = featured && chainTimestamp !== null && chainTimestamp >= featured.deadline
  const open = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    selectRound(id)
    onNavigate('auction')
  }

  return <div className="workspace markets-page">
    <div className="market-workbench">
      <header className="market-masthead">
        <div><span className="market-eyebrow">TOKENIZED SECURITIES</span><h1>The bond market,<br className="market-title-break" /> <em>restructured.</em></h1></div>
        <p>Public orders.<br />One clearing price.</p>
      </header>

      <ChainState>
        {paused && <div className="market-system-notice" role="status">Trading is paused by the issuer. You can still review every round and its orders.</div>}

        {featured && <section className="market-feature" aria-labelledby="featured-security">
          <header className="market-feature-bar"><span><Layers3 size={16} aria-hidden="true" />FEATURED SECURITY</span><div className="market-visual-switch" role="group" aria-label="Market visualization"><button aria-pressed={visual === 'chart'} onClick={() => setVisual('chart')}>Auction chart</button><button aria-pressed={visual === 'spatial'} onClick={() => setVisual('spatial')}>3D view</button></div></header>
          <div className="market-feature-body">
            <div className="market-instrument">
              <div className="market-instrument-heading"><span className="market-pair">{featured.bond.symbol} / {featured.settlement.symbol}</span><MarketPhase phase={featured.phase} /></div>
              <h2 id="featured-security">{featured.bond.symbol}</h2>
              <p className="market-instrument-name">{featured.bond.name}</p>
              <dl className="market-instrument-details">
                <div><dt>{featured.phase === 'closed' ? 'Round deadline' : 'Bidding deadline'}</dt><dd>{dateTime(featured.deadline)}</dd></div>
                <div><dt>Order book</dt><dd>{featured.bidCount} public {featured.bidCount === 1 ? 'order' : 'orders'}</dd></div>
                <div><dt>Settlement</dt><dd>Atomic delivery vs. payment</dd></div>
              </dl>
              <a className="market-primary-action" href={`/auction?round=${featured.id}`} onClick={event => open(event, featured.id)}>View auction <ArrowUpRight size={19} /></a>
              {featured.phase === 'open' && deadlinePassed && <p className="market-deadline-note">Bidding has ended. Awaiting issuer close.</p>}
            </div>
            <div className="market-feature-visual">{visual === 'chart' ? <AuctionDepthChart round={featured} compact /> : <MarketDepth round={featured} variant="market" />}</div>
          </div>
          <dl className="market-feature-metrics">
            <div><dt><i className="market-key market-key-buy" />Buy demand</dt><dd>{orderQuantity(featured, true)} <span>{featured.bond.symbol}</span></dd></div>
            <div><dt><i className="market-key market-key-sell" />Sell supply</dt><dd>{orderQuantity(featured, false)} <span>{featured.bond.symbol}</span></dd></div>
            <div><dt>Last clearing price</dt><dd>{lastCleared ? <>{amount(lastCleared.clearingPrice)} <span>{lastCleared.settlement.symbol}</span></> : <span className="market-no-price">No matched round yet</span>}</dd></div>
          </dl>
        </section>}

        <section className="market-rounds" aria-labelledby="market-rounds-title">
          <header className="market-rounds-heading"><div><h2 id="market-rounds-title">Auction directory</h2><p>{roundsTruncated ? 'Latest ' : ''}{rounds.length} {rounds.length === 1 ? 'round' : 'rounds'} on record</p></div><button className="market-refresh" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={16} className={refreshing ? 'is-refreshing' : ''} />{refreshing ? 'Refreshing' : 'Refresh'}</button></header>
          <div className="market-directory-controls">
            <div className="market-filter-tabs" role="group" aria-label="Filter auction rounds">{(['ALL', 'OPEN', 'CLOSED'] as const).map(item => <button key={item} className={filter === item ? 'active' : ''} aria-pressed={filter === item} onClick={() => setFilter(item)}>{item === 'ALL' ? 'All rounds' : item === 'OPEN' ? 'Open' : 'Closed'}<span>{counts[item]}</span></button>)}</div>
            <div className="market-search-sort">
              <label className="market-search"><Search size={17} aria-hidden="true" /><span className="sr-only">Search securities or rounds</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search security or round" type="search" /></label>
              <label className="market-sort"><ArrowDownUp size={16} aria-hidden="true" /><span className="sr-only">Sort auction rounds</span><select value={sort} onChange={event => setSort(event.target.value)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label>
            </div>
          </div>
          <div className="table-scroll market-table-wrap"><table className="market-round-table"><caption className="sr-only">Auction rounds with security, deadline, public order count, clearing price and status</caption><thead><tr><th scope="col">Security / round</th><th scope="col">Bid deadline</th><th scope="col">Orders</th><th scope="col">Clearing price</th><th scope="col">Status</th><th scope="col"><span className="sr-only">View auction</span></th></tr></thead><tbody>{rows.map(round => <tr key={round.id}>
            <th scope="row"><a className="market-security-link" href={`/auction?round=${round.id}`} onClick={event => open(event, round.id)}><span><b>{round.bond.symbol}</b><i>#{round.id.padStart(3, '0')}</i></span><small>{round.bond.name}</small></a></th>
            <td><time dateTime={new Date(round.deadline * 1000).toISOString()}>{dateTime(round.deadline)}</time></td>
            <td className="market-number">{round.bidCount}</td>
            <td className="market-price-cell">{round.phase === 'closed' && round.clearedQuantityRaw > 0n ? <>{amount(round.clearingPrice)}<small>{round.settlement.symbol}</small></> : <span className="market-table-muted">{round.phase === 'closed' ? 'No match' : 'Not cleared'}</span>}</td>
            <td><MarketPhase phase={round.phase} /></td>
            <td><a className="market-row-action" href={`/auction?round=${round.id}`} aria-label={`View auction round ${round.id}`} onClick={event => open(event, round.id)}><ArrowRight size={18} /></a></td>
          </tr>)}</tbody></table></div>
          {!rows.length && <div className="market-directory-empty"><Layers3 size={26} aria-hidden="true" /><h3>{rounds.length ? 'No matching rounds' : 'The first round starts here.'}</h3><p>{rounds.length ? 'Try another security, round number or status.' : 'Published auction rounds will appear here when the issuer opens bidding.'}</p>{rounds.length > 0 ? <button className="market-refresh" onClick={() => { setFilter('ALL'); setQuery('') }}>Clear filters</button> : <ViewLink className="market-refresh" view="issuer" onNavigate={onNavigate}>Open issuer console <ArrowUpRight size={16} /></ViewLink>}</div>}
          <footer className="market-directory-foot"><span role="status">{rows.length} of {rounds.length} {rounds.length === 1 ? 'round' : 'rounds'}</span><span>Prices in the round’s settlement token</span></footer>
        </section>
      </ChainState>
    </div>
  </div>
}
