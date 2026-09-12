import { lazy, Suspense, useEffect, useRef } from 'react'
import { Shell } from './components/Shell'
import { Seo } from './components/Seo'
import { useDemoSession } from './context/DemoSessionContext'
import { useHashRoute } from './hooks/useHashRoute'
import { Home } from './pages/Home'
import { resolveView } from './content/seo'
import { ViewLink } from './components/ViewLink'

const Markets = lazy(() => import('./pages/Markets').then((module) => ({ default: module.Markets })))
const Auction = lazy(() => import('./pages/Auction').then((module) => ({ default: module.Auction })))
const Portfolio = lazy(() => import('./pages/Portfolio').then((module) => ({ default: module.Portfolio })))
const Issuer = lazy(() => import('./pages/Issuer').then((module) => ({ default: module.Issuer })))

function PageFallback() {
  return <div className="page-fallback" role="status"><i /><span>Loading page</span></div>
}

export default function App() {
  const { view, navigate, routeKey } = useHashRoute()
  const { rounds, selectedRound, selectRound } = useDemoSession()
  const appliedRoundUrl = useRef<string | null>(null)

  useEffect(() => {
    if (view !== 'auction') { appliedRoundUrl.current = null; return }
    if (appliedRoundUrl.current === routeKey) return
    const id = new URLSearchParams(window.location.search).get('round')
    if (id && /^\d+$/.test(id) && rounds.some(round => round.id === id)) {
      appliedRoundUrl.current = routeKey
      if (selectedRound?.id !== id) selectRound(id)
    }
  }, [view, routeKey, rounds, selectedRound?.id, selectRound])

  let page: React.ReactNode
  if (!resolveView(window.location.pathname, window.location.hash)) page = <section className="empty-state"><h1>Page not found.</h1><p>This address doesn’t lead to a Clearing Bell page.</p><ViewLink className="primary-action" view="markets" onNavigate={navigate}>Explore markets</ViewLink></section>
  else if (view === 'home') page = <Home onNavigate={navigate} />
  else if (view === 'markets') page = <Markets onNavigate={navigate} />
  else if (view === 'auction') page = <Auction onNavigate={navigate} />
  else if (view === 'portfolio') page = <Portfolio onNavigate={navigate} />
  else page = <Issuer onNavigate={navigate} />

  return (
    <Shell view={view} onNavigate={navigate}>
      <Seo key={routeKey} view={view} />
      <Suspense fallback={<PageFallback />}>{page}</Suspense>
    </Shell>
  )
}
