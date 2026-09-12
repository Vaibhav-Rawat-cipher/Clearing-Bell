import { Check, Crosshair, LockKeyhole, ScanLine } from 'lucide-react'
import { mechanismStages } from '../../content/site'
import type { AuctionPhase } from '../../types'

export function SectionLabel({ index, children, inverse = false }: { index: string; children: React.ReactNode; inverse?: boolean }) {
  return <div className={`section-label ${inverse ? 'inverse' : ''}`}><span>{index}</span><i /><b>{children}</b></div>
}

export function PanelHeader({ eyebrow, title, action }: { eyebrow: React.ReactNode; title: React.ReactNode; action?: React.ReactNode }) {
  return <div className="panel-header"><div><span>{eyebrow}</span><h2>{title}</h2></div>{action}</div>
}

export function StatusBadge({ tone = 'neutral', children }: { tone?: 'neutral' | 'live' | 'success' | 'danger' | 'optional'; children: React.ReactNode }) {
  return <span className={`status-badge ${tone}`}><i />{children}</span>
}

const phaseOrder: AuctionPhase[] = ['commit', 'reveal', 'clear', 'settle']

export function PhaseRail({ phase, clock }: { phase: AuctionPhase; clock?: string }) {
  const activeIndex = phaseOrder.indexOf(phase)
  return (
    <div className="phase-rail" aria-label={`Auction phase: ${phase}`}>
      {mechanismStages.map((stage, index) => {
        const done = index < activeIndex
        const active = index === activeIndex
        const Icon = index === 0 ? LockKeyhole : index === 1 ? ScanLine : index === 2 ? Crosshair : Check
        return (
          <div className={`${done ? 'done' : ''} ${active ? 'active' : ''}`} key={stage.phase}>
            <span className="phase-node">{done ? <Check /> : <Icon />}</span>
            <span><b>{stage.label}</b><small>{active && clock ? `${clock} remaining` : stage.proof.split(' · ')[0]}</small></span>
            {index < mechanismStages.length - 1 && <i className="phase-line" />}
          </div>
        )
      })}
    </div>
  )
}
