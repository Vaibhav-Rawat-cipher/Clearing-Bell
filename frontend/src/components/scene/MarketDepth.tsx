import { Component, lazy, Suspense, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { formatUnits } from 'viem'
import type { LiveRound } from '../../types'
import './market-depth.css'

const MarketDepthCanvas = lazy(() => import('./MarketDepthCanvas'))
type View = 'isometric' | 'front' | '2d'
type Props = { round: LiveRound | null; variant?: 'hero' | 'market' }

const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 })
function quantity(raw: bigint, decimals: number) {
  return number.format(Number(formatUnits(raw, decimals)))
}

class DepthBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}

function FlatDepth({ round, loading = false }: { round: LiveRound | null; loading?: boolean }) {
  const bids = round?.bids ?? []
  const maximum = bids.reduce((max, bid) => bid.quantityRaw > max ? bid.quantityRaw : max, 1n)
  return <div className="market-depth-flat">
    <div className="market-depth-flat-heading"><span>{loading ? 'Preparing market depth' : 'Order depth'}</span><span>Price / quantity</span></div>
    {bids.length ? <div className="market-depth-flat-book">
      {bids.slice(0, 8).map(bid => <div className={`market-depth-flat-row ${bid.isBuy ? 'is-buy' : 'is-sell'}`} key={bid.index}>
        <i aria-hidden="true" style={{ width: `${Number(bid.quantityRaw * 10000n / maximum) / 100}%` }} />
        <span>{bid.isBuy ? 'Bid' : 'Ask'}</span><strong>{number.format(Number(bid.price))}</strong><span>{number.format(Number(bid.quantity))}</span>
      </div>)}
      {bids.length > 8 && <p>Showing 8 of {bids.length} orders. Totals below include every order.</p>}
    </div> : <div className="market-depth-flat-empty"><div aria-hidden="true" className="market-depth-empty-lines" /><p>{round ? 'The order book is empty.' : 'Market depth appears when a round is available.'}</p></div>}
  </div>
}

export function MarketDepth({ round, variant = 'market' }: Props) {
  const container = useRef<HTMLElement>(null)
  const captionId = useId()
  const [entered, setEntered] = useState(() => typeof window !== 'undefined' && !('IntersectionObserver' in window))
  const [visible, setVisible] = useState(() => typeof window !== 'undefined' && !('IntersectionObserver' in window))
  const [view, setView] = useState<View | null>(null)
  const [reducedMotion, setReducedMotion] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    const element = container.current
    if (!element) return
    if (!('IntersectionObserver' in window)) return
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(entry.isIntersecting)
      if (entry.isIntersecting) setEntered(true)
    }, { rootMargin: '140px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const chosenView = view ?? (reducedMotion ? '2d' : 'isometric')
  const totals = (round?.bids ?? []).reduce((sum, bid) => {
    sum[bid.isBuy ? 0 : 1] += bid.quantityRaw
    return sum
  }, [0n, 0n])
  const hasCleared = Boolean(round?.phase === 'closed' && round.clearingPriceRaw > 0n)
  const fallback = <FlatDepth round={round} />

  return <figure ref={container} className={`market-depth market-depth--${variant}`} aria-describedby={captionId}>
    <div className="market-depth-topline">
      <span>{round ? `${round.bond.symbol} / ${round.settlement.symbol}` : 'Bond market'}</span>
      <span>{round ? `Round ${round.id.padStart(3, '0')}` : 'Awaiting round'}</span>
    </div>
    <div className="market-depth-stage">
      {chosenView === '2d' ? fallback : entered ? <DepthBoundary fallback={fallback}>
        <Suspense fallback={<FlatDepth round={round} loading />}>
          <MarketDepthCanvas key={`${chosenView}-${reducedMotion}`} round={round} variant={variant} view={chosenView} reducedMotion={reducedMotion} active={visible} fallback={fallback} />
        </Suspense>
      </DepthBoundary> : <FlatDepth round={round} loading />}
    </div>
    <div className="market-depth-toolbar">
      <span className="market-depth-key"><i className="depth-bid" />Bid <i className="depth-ask" />Ask</span>
      <div className="market-depth-views" role="group" aria-label="Market depth view">
        {(['isometric', 'front', '2d'] as const).map(value => <button key={value} type="button" aria-pressed={chosenView === value} onClick={() => setView(value)}>{value === 'isometric' ? 'Isometric' : value === 'front' ? 'Front' : '2D'}</button>)}
      </div>
    </div>
    <figcaption id={captionId} className="market-depth-caption">
      <div><span>Bid quantity</span><strong>{round ? quantity(totals[0], round.bond.decimals) : '—'} <small>{round?.bond.symbol ?? ''}</small></strong></div>
      <div><span>Ask quantity</span><strong>{round ? quantity(totals[1], round.bond.decimals) : '—'} <small>{round?.bond.symbol ?? ''}</small></strong></div>
      <div><span>{hasCleared ? 'Clearing price' : 'Clearing'}</span><strong>{hasCleared ? `${number.format(Number(round!.clearingPrice))} ${round!.settlement.symbol}` : round?.phase === 'closed' ? 'No crossing' : 'Pending'}</strong></div>
      <p>{variant === 'hero' ? 'Submitted order depth. Height represents quantity.' : <>{round?.phase === 'closed' ? 'Submitted orders for the completed round.' : 'Submitted order quantities grouped by price.'} Bar height shows volume. {hasCleared ? 'Mint plane marks the recorded clearing price.' : 'The clearing price is determined when the round closes.'} This view is not a pricing oracle.</>}</p>
    </figcaption>
  </figure>
}

export default MarketDepth
