import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { formatUnits } from 'viem'
import type { LiveRound } from '../../types'
import { buildDepthModel, nearestDepthPoint, plotRatio, priceTicks, quantityTicks } from '../../lib/depth-chart'
import type { DepthModel } from '../../lib/depth-chart'
import './auction-depth-chart.css'

type Mode = 'depth' | 'volume'
type Props = { round: LiveRound | null; compact?: boolean }
const formatNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 })
const exact = (raw: bigint, decimals: number) => formatUnits(raw, decimals)
function axis(raw: bigint, decimals: number) {
  const value = Number(exact(raw, decimals))
  if (!value) return '0'
  return value < .001 || value >= 1e9 ? value.toExponential(2).replace('e+', 'e') : formatNumber.format(value)
}

function stepLine(model: DepthModel, side: 'bid' | 'ask', x: (price: bigint) => number, y: (quantity: bigint) => number) {
  let path = `M ${x(model.priceDomain[0])} ${y(side === 'bid' ? model.totalBid : 0n)}`
  for (const point of model.points) {
    // A bid remains eligible at its limit and drops immediately after that
    // level. An ask enters at its limit. The inspector retains inclusive values.
    const after = side === 'bid' ? point.bidDepth - point.bidVolume : point.askDepth
    path += ` H ${x(point.priceRaw)} V ${y(after)}`
  }
  return `${path} H ${x(model.priceDomain[1])}`
}

export function AuctionDepthChart({ round, compact = false }: Props) {
  const model = useMemo(() => buildDepthModel(round), [round])
  const [mode, setMode] = useState<Mode>('depth')
  const [inspectedPrice, setInspectedPrice] = useState<string | null>(null)
  const [width, setWidth] = useState(700)
  const plot = useRef<HTMLDivElement>(null)
  const id = useId()
  useEffect(() => {
    const target = plot.current
    if (!target || !('ResizeObserver' in window)) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.round(entry.contentRect.width))))
    observer.observe(target)
    return () => observer.disconnect()
  }, [])

  const priceDecimals = round?.settlement.decimals ?? 6
  const quantityDecimals = round?.bond.decimals ?? 18
  const currency = round?.settlement.symbol ?? 'settlement token'
  const symbol = round?.bond.symbol ?? 'bonds'
  const selectedMatch = model.points.findIndex(point => point.priceRaw.toString() === inspectedPrice)
  const selectedIndex = selectedMatch >= 0 ? selectedMatch : Math.floor((model.points.length - 1) / 2)
  const selected = model.points[selectedIndex]
  const yTicks = quantityTicks(mode === 'depth' ? model.maxDepth : model.maxVolume)
  const yMaximum = yTicks.at(-1) ?? 1n
  const xTicks = priceTicks(model.priceDomain, width < 480 ? 2 : 4)
  const height = compact ? 208 : 280
  const left = width < 480 ? 61 : 73
  const right = width - 20
  const top = 25
  const bottom = height - 50
  const x = (price: bigint) => left + plotRatio(price, ...model.priceDomain) * (right - left)
  const y = (quantity: bigint) => bottom - plotRatio(quantity, 0n, yMaximum) * (bottom - top)
  const bidLine = stepLine(model, 'bid', x, y)
  const askLine = stepLine(model, 'ask', x, y)
  const area = (path: string) => `${path} L ${right} ${bottom} L ${left} ${bottom} Z`
  const barWidth = Math.min(22, Math.max(3, (right - left) / Math.max(model.points.length * 3.2, 8)))
  const select = (index: number) => setInspectedPrice(model.points[index]?.priceRaw.toString() ?? null)

  return <section className={`auction-depth-chart ${compact ? 'auction-depth-chart--compact' : ''}`} aria-label="Auction order depth">
    <div className="adc-heading"><div><h3>Order depth</h3><span>{round ? `${symbol} / ${currency} · Round ${round.id}` : 'Awaiting a market'}</span></div>
      <div className="adc-mode" role="group" aria-label="Chart measure"><button type="button" aria-pressed={mode === 'depth'} onClick={() => setMode('depth')}>Depth</button><button type="button" aria-pressed={mode === 'volume'} onClick={() => setMode('volume')}>Order volume</button></div>
    </div>
    <div className="adc-legend"><span><i className="adc-bid-key" />Bids <b>{axis(model.totalBid, quantityDecimals)}</b></span><span><i className="adc-ask-key" />Asks <b>{axis(model.totalAsk, quantityDecimals)}</b></span><small>{model.orderCount} {model.orderCount === 1 ? 'order' : 'orders'} · {symbol}</small></div>
    <div className="adc-plot" ref={plot} style={{ height }}>
      {model.points.length ? <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${id}-title ${id}-description`}
        onPointerMove={event => { const bounds = event.currentTarget.getBoundingClientRect(); const localX = (event.clientX - bounds.left) * width / bounds.width; select(nearestDepthPoint(model.points, (localX - left) / (right - left), model.priceDomain)) }}>
        <title id={`${id}-title`}>{mode === 'depth' ? 'Cumulative demand and supply' : 'Submitted volume at each limit price'}</title>
        <desc id={`${id}-description`}>Horizontal axis: limit price in {currency}. Vertical axis: quantity in {symbol}. Bids use a solid mint line; asks use a dashed blue line. Exact values are available in the price inspector and table below.</desc>
        {yTicks.map(tick => <g key={tick.toString()}><line x1={left} x2={right} y1={y(tick)} y2={y(tick)} className="adc-grid" /><text x={left - 12} y={y(tick) + 4} textAnchor="end" className="adc-tick">{axis(tick, quantityDecimals)}</text></g>)}
        {xTicks.map((tick, index) => <g key={tick.toString()}><line x1={x(tick)} x2={x(tick)} y1={top} y2={bottom} className="adc-grid adc-grid--vertical" /><text x={x(tick)} y={bottom + 22} textAnchor={index === 0 ? 'start' : index === xTicks.length - 1 ? 'end' : 'middle'} className="adc-tick">{axis(tick, priceDecimals)}</text></g>)}
        <text x={left} y={13} className="adc-axis-label">Quantity · {symbol}</text><text x={(left + right) / 2} y={height - 5} textAnchor="middle" className="adc-axis-label">Limit price · {currency}</text>
        {mode === 'depth' ? <><path d={area(bidLine)} className="adc-area adc-area--bid" /><path d={area(askLine)} className="adc-area adc-area--ask" /><path d={bidLine} className="adc-line adc-line--bid" /><path d={askLine} className="adc-line adc-line--ask" /></> : model.points.map(point => <g key={point.priceRaw.toString()}>
          {point.bidVolume > 0n && <rect x={x(point.priceRaw) - barWidth - 1} y={y(point.bidVolume)} width={barWidth} height={bottom - y(point.bidVolume)} className="adc-volume adc-volume--bid" />}
          {point.askVolume > 0n && <rect x={x(point.priceRaw) + 1} y={y(point.askVolume)} width={barWidth} height={bottom - y(point.askVolume)} className="adc-volume adc-volume--ask" />}
        </g>)}
        {model.clearingPrice !== null && <g><line x1={x(model.clearingPrice)} x2={x(model.clearingPrice)} y1={top} y2={bottom} className="adc-clearing-line" /><text x={Math.min(right - 8, Math.max(left + 8, x(model.clearingPrice)))} y={top + 13} textAnchor={x(model.clearingPrice) > (left + right) / 2 ? 'end' : 'start'} className="adc-clearing-label">Cleared {axis(model.clearingPrice, priceDecimals)}</text></g>}
        {selected && <g><line x1={x(selected.priceRaw)} x2={x(selected.priceRaw)} y1={top} y2={bottom} className="adc-inspection-line" />
          <circle cx={x(selected.priceRaw) - (mode === 'volume' ? barWidth / 2 + 1 : 0)} cy={y(mode === 'depth' ? selected.bidDepth : selected.bidVolume)} r={4} className="adc-dot adc-dot--bid" /><circle cx={x(selected.priceRaw) + (mode === 'volume' ? barWidth / 2 + 1 : 0)} cy={y(mode === 'depth' ? selected.askDepth : selected.askVolume)} r={4} className="adc-dot adc-dot--ask" />
        </g>}
      </svg> : <div className="adc-empty"><strong>{round ? 'No orders in this round' : 'No round selected'}</strong><p>{round ? 'Submitted bids and asks will appear here at their actual limit prices.' : 'Choose an available round to inspect its order depth.'}</p></div>}
    </div>
    {selected && <>
      <dl className="adc-inspector" aria-live="off"><div><dt>At price <small>{currency}</small></dt><dd>{exact(selected.priceRaw, priceDecimals)}</dd></div><div className="adc-inspector-bid"><dt>{mode === 'depth' ? 'Bid depth' : 'Bid volume'} <small>{symbol}</small></dt><dd>{exact(mode === 'depth' ? selected.bidDepth : selected.bidVolume, quantityDecimals)}</dd></div><div className="adc-inspector-ask"><dt>{mode === 'depth' ? 'Ask depth' : 'Ask volume'} <small>{symbol}</small></dt><dd>{exact(mode === 'depth' ? selected.askDepth : selected.askVolume, quantityDecimals)}</dd></div></dl>
      <div className="adc-scrubber"><label htmlFor={`${id}-price`}>Inspect price</label><input id={`${id}-price`} type="range" min={0} max={Math.max(0, model.points.length - 1)} step={1} value={selectedIndex} disabled={model.points.length < 2} onChange={event => select(Number(event.target.value))} aria-valuetext={`${exact(selected.priceRaw, priceDecimals)} ${currency}; bid ${mode} ${exact(mode === 'depth' ? selected.bidDepth : selected.bidVolume, quantityDecimals)}, ask ${mode} ${exact(mode === 'depth' ? selected.askDepth : selected.askVolume, quantityDecimals)} ${symbol}`} /><span>{selectedIndex + 1} / {model.points.length}</span></div>
    </>}
    <details className="adc-data"><summary>View exact depth data{model.points.length ? ` · ${model.points.length} price ${model.points.length === 1 ? 'level' : 'levels'}` : ''}</summary>
      <div className="adc-table-scroll"><table><caption>All submitted limit prices and cumulative quantities. {model.clearingPrice !== null ? 'The recorded clearing price is included as an inspection level.' : 'Clearing price is not predicted by this chart.'}</caption><thead><tr><th>Price ({currency})</th><th>Bid volume ({symbol})</th><th>Ask volume ({symbol})</th><th>Bid depth ({symbol})</th><th>Ask depth ({symbol})</th></tr></thead><tbody>{model.points.map(point => <tr key={point.priceRaw.toString()}><th scope="row">{exact(point.priceRaw, priceDecimals)}</th><td>{exact(point.bidVolume, quantityDecimals)}</td><td>{exact(point.askVolume, quantityDecimals)}</td><td>{exact(point.bidDepth, quantityDecimals)}</td><td>{exact(point.askDepth, quantityDecimals)}</td></tr>)}{!model.points.length && <tr><td colSpan={5}>No submitted orders.</td></tr>}</tbody></table></div>
      <p>Bid depth includes orders with limits at or above each price. Ask depth includes limits at or below it. Submitted depth can differ from final fills if eligibility changes before settlement.</p>
    </details>
    {!compact && <p className="adc-footnote">{model.clearingPrice !== null ? `Recorded clearing price: ${exact(model.clearingPrice, priceDecimals)} ${currency}.` : round?.phase === 'closed' ? 'This round closed without a recorded crossing.' : 'Clearing price is determined when the round closes.'}</p>}
  </section>
}
