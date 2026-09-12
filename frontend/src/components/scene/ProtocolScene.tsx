import { Component, lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { AuctionPhase } from '../../types'
import { SceneLoader } from './SceneLoader'

const ClearingScene = lazy(() => import('./ClearingScene'))
type Props = { phase: AuctionPhase; reducedMotion?: boolean }

class SceneBoundary extends Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <div className="empty-state"><h3>One price. One settlement.</h3><p>The interactive view is unavailable on this device. All four steps remain available alongside it.</p></div> : this.props.children }
}

export function ProtocolScene({ phase, reducedMotion }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(entry.isIntersecting)
      if (entry.isIntersecting) setEntered(true)
    }, { rootMargin: '100px' })
    if (container.current) observer.observe(container.current)
    return () => observer.disconnect()
  }, [])
  return <div ref={container} className="protocol-scene-host">
    {entered ? <SceneBoundary><Suspense fallback={<SceneLoader />}>
      <ClearingScene phase={phase} reducedMotion={reducedMotion || !visible} />
    </Suspense></SceneBoundary> : <SceneLoader />}
  </div>
}
