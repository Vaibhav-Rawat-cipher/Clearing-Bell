import { useState } from 'react'
import { mechanismStages } from '../../content/site'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import type { AuctionPhase } from '../../types'
import { ProtocolScene } from '../scene/ProtocolScene'

export function MechanismPanel() {
  const [phase, setPhase] = useState<AuctionPhase>('commit')
  const reducedMotion = useReducedMotion()
  const activeIndex = mechanismStages.findIndex((stage) => stage.phase === phase)
  const active = mechanismStages[activeIndex]

  return (
    <section className="mechanism-section" id="auction-process">
      <header className="section-intro mechanism-intro">
        <span>HOW IT WORKS</span>
        <h2>A clear path to ownership.</h2>
      </header>

      <div className="mechanism-composition">
        <div className="clearing-ledger" aria-label={`Auction process: ${active.label}`}>
          <ProtocolScene phase={phase} reducedMotion={reducedMotion} />
          <div className="ledger-caption">
            <span>Process schematic</span>
            <b>{active.label}</b>
            <span>{activeIndex + 1} / {mechanismStages.length}</span>
          </div>
          <div className="ledger-price"><span>Execution rule</span><b>One price</b><small>At auction close</small></div>
        </div>

        <div className="mechanism-list" role="tablist" aria-label="Auction phases">
          {mechanismStages.map((stage, index) => (
            <button key={stage.phase} role="tab" aria-selected={phase === stage.phase} className={phase === stage.phase ? 'active' : ''} onClick={() => setPhase(stage.phase)}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <span><b>{stage.label}</b><p>{stage.body}</p></span>
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}
