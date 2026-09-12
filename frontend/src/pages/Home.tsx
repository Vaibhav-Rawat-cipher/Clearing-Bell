
import { ArrowRight, ArrowUpRight, Check, Plus } from 'lucide-react'
import { Brand } from '../components/Brand'
import { ViewLink } from '../components/ViewLink'
import { ClonerCube } from '../components/scene/ClonerCube'
import { useDemoSession } from '../context/DemoSessionContext'
import { homeOverview, homeQuestions } from '../content/seo'
import type { View } from '../types'
import { amount } from '../utils/format'

const principles = [
  { title: 'Any company, any bond.', text: 'The platform is multi-issuer. Any authorized company can list their bond, connect their own KYC registry, and run their own auctions without giving up control.' },
  { title: 'One market. One price.', text: 'Matched buyers and sellers trade at the same clearing price.' },
  { title: 'Eligibility is part of the trade.', text: 'Wallet permissions are checked before orders and settlement.' },
  { title: 'Assets and payment, together.', text: 'Bond and cash-token transfers execute in one transaction.' },
]
const steps = [
  { title: 'Connect', text: 'Connect an eligible wallet and approve the tokens you want to trade.' },
  { title: 'Set your limit', text: 'Choose a side, price, and quantity. Your order joins the public book.' },
  { title: 'Clear the round', text: 'After the window closes, eligible demand meets supply at one price.' },
  { title: 'Receive your assets', text: 'Matched tokens settle to your wallet. Review every fill in your portfolio.' },
]
const workflows: Array<{ view: View; name: string; detail: string }> = [
  { view: 'markets', name: 'Explore the market', detail: 'Find a bond. Read the book. Set your price.' },
  { view: 'portfolio', name: 'See where you stand', detail: 'Token balances, open orders, and settlement records.' },
  { view: 'issuer', name: 'Run the next round', detail: 'Auction windows and controls for authorized issuers.' },
]

export function Home({ onNavigate }: { onNavigate: (view: View) => void }) {
  const { rounds, connectionStatus } = useDemoSession()
  const ready = connectionStatus === 'ready'
  const active = rounds.filter(round => round.phase === 'open')
  const featured = active[0] ?? rounds[0] ?? null
  const settled = rounds.find(round => round.phase === 'closed' && round.clearedQuantityRaw > 0n)
  return <div className="landing-page">
    <section className="landing-hero" aria-labelledby="landing-title">
      <div className="landing-hero-main">
        <div className="landing-intro">
          <p className="landing-eyebrow"><span className="landing-hedera" aria-hidden="true">ℏ</span> TOKENIZED BONDS / BUILT FOR HEDERA</p>
          <h1 id="landing-title">A new market<br />for <span>tokenized<br className="landing-title-break" /> bonds.</span></h1>
          <p className="landing-deck">Transparent auctions. A shared clearing price.<br className="landing-desktop-break" /> A different way to move bonds.</p>
          <div className="landing-actions">
            <ViewLink className="landing-button" view="markets" onNavigate={onNavigate}>Explore markets <ArrowUpRight /></ViewLink>
            <a className="landing-text-link" href="#auction-process">How it works <ArrowRight /></a>
          </div>
          <p className="landing-intro-note"><Check size={14} /> Public order book <span>·</span> Eligibility-aware settlement</p>
        </div>
        <div className="landing-cube-visual">
          <ClonerCube />
        </div>
      </div>
      <div className="landing-market-strip">
        <div className="landing-strip-label"><span className="landing-micro">MARKET SNAPSHOT</span><p>From the connected contracts.</p></div>
        <dl>
          <div><dt>Open auctions</dt><dd>{ready ? active.length : '—'}</dd></div>
          <div><dt>Last matched price</dt><dd>{ready && settled ? amount(settled.clearingPrice, 2) : '—'}{ready && settled && <small>{settled.settlement.symbol}</small>}</dd></div>
          <div><dt>Orders in focus</dt><dd>{ready && featured ? featured.bidCount : '—'}</dd></div>
        </dl>
      </div>
    </section>

    <section className="landing-thesis" aria-labelledby="thesis-title">
      <div className="landing-section-head"><span className="landing-micro">THE CLEARING BELL APPROACH</span><span className="landing-section-mark" aria-hidden="true">[ 01 — 03 ]</span></div>
      <div className="landing-thesis-heading"><h2 id="thesis-title">Liquidity,<br />on a shared clock.</h2><p>{homeOverview}</p></div>
      <div className="landing-principles">{principles.map((item, index) => <article key={item.title}><span className="landing-rule-index">0{index + 1}</span><h3>{item.title}</h3><p>{item.text}</p></article>)}</div>
    </section>

    <section className="landing-process" id="auction-process" aria-labelledby="process-title">
      <div className="landing-section-head"><span className="landing-micro">FROM INTENT TO OWNERSHIP</span><span className="landing-section-mark">THE AUCTION CYCLE</span></div>
      <div className="landing-process-heading">
        <h2 id="process-title">Your price.<br /><span>The market’s moment.</span></h2>
        <p><strong>For Investors:</strong> No chasing the next tick. Place your limit within a shared auction window.</p>
        <p style={{ marginTop: '0.75rem', color: 'var(--color-text-secondary)' }}><strong>For Companies:</strong> The platform is fully multi-issuer. List your tokenized bond, enforce your own KYC compliance registry, and retain full permissionless control over your auction lifecycle.</p>
      </div>
      <ol className="landing-steps">{steps.map((step, index) => <li key={step.title}><div className="landing-step-track"><span>0{index + 1}</span><ArrowRight /></div><h3>{step.title}</h3><p>{step.text}</p></li>)}</ol>
      <p className="landing-process-note">Orders are public and are not escrowed. Keep balances and approvals available until settlement. A limit order may fill partially or not at all.</p>
    </section>

    <section className="landing-workflows" aria-labelledby="workflows-title">
      <div className="landing-workflows-intro"><span className="landing-micro">A CONNECTED WORKSPACE</span><h2 id="workflows-title">Every side<br />of the market.</h2><p>From the first order to the final receipt.</p></div>
      <div className="landing-workflow-links">{workflows.map((item, index) => <ViewLink key={item.view} view={item.view} onNavigate={onNavigate}><span className="landing-workflow-number">0{index + 1}</span><div><h3>{item.name}</h3><p>{item.detail}</p></div><ArrowUpRight /></ViewLink>)}</div>
    </section>

    <section className="landing-faq" aria-labelledby="faq-title">
      <div><span className="landing-micro">THE DETAILS</span><h2 id="faq-title">A clearer picture.</h2></div>
      <div className="landing-questions">{homeQuestions.map(item => <details key={item.question}><summary>{item.question}<Plus aria-hidden="true" /></summary><p>{item.answer}</p></details>)}</div>
    </section>
    <footer className="landing-footer">
      <div><Brand /><p>A shared price. A clearer market.</p></div>
      <ViewLink className="landing-button" view="markets" onNavigate={onNavigate}>Enter the market <ArrowUpRight /></ViewLink>
      <div className="landing-footer-bottom"><span>Built for Hedera. Designed for clarity.</span><a href="https://github.com/AmrendraTheCoder/Clearing-Bell" target="_blank" rel="noreferrer">View source <ArrowUpRight size={14} /></a></div>
    </footer>
  </div>
}
