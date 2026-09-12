import { ArrowUpRight } from 'lucide-react'
import { useDemoSession } from '../../context/DemoSessionContext'
import { dateTime, amount } from '../../utils/format'
import type { View } from '../../types'

export function AuctionDocket({ onNavigate }: { onNavigate: (view: View) => void }) {
  const { rounds, selectRound, connectionStatus } = useDemoSession()
  const round = rounds.find(r => r.phase === 'open') || rounds[0]
  return <aside className="auction-docket" aria-label="Latest auction">
    <header><span>{round ? `ROUND ${round.id.padStart(3, '0')}` : 'AUCTION DIRECTORY'}</span><span className="docket-state"><i />{round?.phase === 'open' ? 'Open for orders' : round ? 'Closed' : connectionStatus === 'loading' ? 'Loading' : 'No open round'}</span></header>
    <div className="docket-security"><span>{round ? `${round.bond.symbol} / ${round.settlement.symbol}` : 'CLEARING BELL'}</span><h2>{round?.bond.name || 'The next clearing window.'}</h2></div>
    <dl className="docket-terms"><div><dt>Bid deadline</dt><dd>{round ? dateTime(round.deadline) : '—'}</dd></div><div><dt>Orders received</dt><dd>{round?.bidCount ?? '—'}</dd></div><div><dt>Settlement</dt><dd>Atomic exchange</dd></div><div><dt>Clearing price</dt><dd>{round?.clearedQuantityRaw ? amount(round.clearingPrice) : 'Set at close'}</dd></div></dl>
    <footer><span className="docket-identity">Eligible wallets only</span><button className="docket-open" onClick={() => { if (round) selectRound(round.id); onNavigate(round ? 'auction' : 'markets') }}>View auction <ArrowUpRight /></button></footer>
  </aside>
}
