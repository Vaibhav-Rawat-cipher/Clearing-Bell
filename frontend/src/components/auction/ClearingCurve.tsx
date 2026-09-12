import { useDemoSession } from '../../context/DemoSessionContext'
import { amount } from '../../utils/format'
import { PanelHeader, StatusBadge } from '../ui/Primitives'

export function ClearingCurve() {
  const { selectedRound: round } = useDemoSession()
  if (!round) return null
  const buys = round.bids.filter(b => b.isBuy).sort((a,b) => Number(b.price) - Number(a.price))
  const sells = round.bids.filter(b => !b.isBuy).sort((a,b) => Number(a.price) - Number(b.price))
  const demand = buys.reduce((sum,b) => sum + Number(b.quantity), 0)
  const supply = sells.reduce((sum,b) => sum + Number(b.quantity), 0)
  const prices = round.bids.map(b => Number(b.price))
  const minimum = Math.min(...prices, Number(round.clearingPrice) || Infinity)
  const maximum = Math.max(...prices, Number(round.clearingPrice))
  const spread = maximum - minimum || Math.max(maximum * .02, 1)
  const low = minimum - spread * .15
  const high = maximum + spread * .15
  const quantity = Math.max(demand, supply, 1)
  const y = (price: number) => 340 - (price - low) / (high - low) * 300
  const x = (q: number) => 10 + q / quantity * 790
  const path = (bids: typeof buys) => {
    let q = 0
    return bids.map((b,i) => { const from = q; q += Number(b.quantity); return `${i === 0 ? 'M' : 'L'} ${x(from)} ${y(Number(b.price))} H ${x(q)}` }).join(' ')
  }
  return <section className="clearing-panel">
    <PanelHeader eyebrow={`ROUND ${round.id} / PUBLIC ORDER BOOK`} title="Where supply meets demand" action={<StatusBadge tone={round.phase === 'open' ? 'live' : 'neutral'}>{round.phase}</StatusBadge>} />
    {round.bids.length ? <div className="clearing-chart" role="img" aria-label={`Cumulative order depth: ${amount(demand)} bonds of demand and ${amount(supply)} bonds of supply. Horizontal axis quantity; vertical axis limit price in ${round.settlement.symbol}. Orders may be excluded if eligibility changes before clearing.`}>
      <div className="chart-y">{[high, high - (high-low)/4, (high+low)/2, low + (high-low)/4, low].map((price,i) => <span key={i}>{amount(price, 2)}</span>)}</div>
      <svg viewBox="0 0 820 390" preserveAspectRatio="none" aria-hidden="true">{[40, 115, 190, 265, 340].map(v => <line key={v} x1="0" x2="820" y1={v} y2={v} className="grid-line" />)}<path className="demand-line" d={path(buys)} /><path className="supply-line" d={path(sells)} />{round.clearedQuantityRaw > 0n && <line className="price-line" x1="0" x2="820" y1={y(Number(round.clearingPrice))} y2={y(Number(round.clearingPrice))} />}</svg>
      <div className="chart-x">{[0,.25,.5,.75,1].map(ratio => <span key={ratio}>{amount(quantity * ratio, 1)}{ratio === 1 ? ' bonds' : ''}</span>)}</div>
    </div> : <div className="empty-state"><h3>The book is open</h3><p>No orders have been submitted. Eligible participants can place the first limit order.</p></div>}
    <div className="chart-legend"><span><i className="buy" />Buy limits</span><span><i className="sell" />Sell limits</span><b>PUBLIC ORDERS</b></div>
    <div className="clearing-metrics"><div><span>Orders</span><b>{round.bidCount}</b><small>submitted</small></div><div><span>Demand</span><b>{amount(demand)}</b><small>bonds</small></div><div><span>Supply</span><b>{amount(supply)}</b><small>bonds</small></div><div><span>Final price</span><b>{round.clearedQuantityRaw > 0n ? amount(round.clearingPrice) : '—'}</b><small>{round.clearedQuantityRaw > 0n ? round.settlement.symbol : 'Determined at close'}</small></div></div>
  </section>
}
