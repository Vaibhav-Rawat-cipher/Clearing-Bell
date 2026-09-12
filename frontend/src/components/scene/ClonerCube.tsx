import { Component, lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ImageIcon, Pause, Play, RotateCcw } from 'lucide-react'
import CubePoster from './CubePoster'
import './ClonerCube.css'

const LOAD_TIMEOUT_MS = 25_000
type LoadState = 'loading' | 'ready' | 'error'
export type ClonerCubeProps = {
  className?: string
}

class CubeBoundary extends Component<{ children: ReactNode; onFailure: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch() { this.props.onFailure() }
  render() { return this.state.failed ? null : this.props.children }
}

// A failed WebGL context or chunk load is retried with a fresh renderer.
function CubeAttempt({ active, resetKey, onLoaded, onFailure, onInteract }: {
  active: boolean
  resetKey: number
  onLoaded: () => void
  onFailure: () => void
  onInteract: () => void
}) {
  const [Runtime] = useState(() => lazy(() => import('./ClonerCubeRuntime')))
  return <CubeBoundary onFailure={onFailure}><Suspense fallback={null}><Runtime active={active} resetKey={resetKey} onLoaded={onLoaded} onFailure={onFailure} onInteract={onInteract} /></Suspense></CubeBoundary>
}

function CubeExperience({ visible, onStill }: { visible: boolean; onStill: () => void }) {
  const [state, setState] = useState<LoadState>('loading')
  const [attempt, setAttempt] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [resetKey, setResetKey] = useState(0)
  const descriptionId = useId()
  const fail = useCallback(() => setState('error'), [])
  const loaded = useCallback(() => setState('ready'), [])
  const interacted = useCallback(() => setPlaying(false), [])

  useEffect(() => {
    if (state !== 'loading') return
    const timeout = window.setTimeout(fail, LOAD_TIMEOUT_MS)
    return () => window.clearTimeout(timeout)
  }, [state, attempt, fail])

  const retry = () => { setAttempt(current => current + 1); setState('loading'); setPlaying(true) }
  return <div className="cloner-cube-experience" data-state={state}>
    <div className="cloner-cube-stage" aria-busy={state === 'loading'}>
      {state !== 'ready' && <div className="cloner-cube-poster" aria-hidden="true"><CubePoster /></div>}
      {state !== 'error' && <div className={`cloner-cube-live${state === 'ready' ? ' is-ready' : ''}`} inert={state !== 'ready'}><CubeAttempt key={attempt} active={visible && playing} resetKey={resetKey} onLoaded={loaded} onFailure={fail} onInteract={interacted} /></div>}
      {state === 'loading' && <div className="cloner-cube-message" role="status"><span className="cloner-cube-progress" aria-hidden="true" /><span>Loading sculpture</span></div>}
      {state === 'error' && <div className="cloner-cube-message cloner-cube-error" role="status"><p>3D couldn’t load.</p><span>The still image is available. You can retry when ready.</span><button type="button" className="cloner-cube-button" onClick={retry}><RotateCcw size={16} aria-hidden="true" />Retry 3D</button></div>}
    </div>
    <div className="cloner-cube-footer">
      <p id={descriptionId}>{state === 'ready' ? 'Drag to explore' : state === 'loading' ? 'Modular cube' : 'Still preview'}</p>
      <div className="cloner-cube-controls">
        {state === 'ready' && <button type="button" className="cloner-cube-button" aria-label={playing ? 'Pause 3D sculpture' : 'Play 3D sculpture'} aria-describedby={descriptionId} onClick={() => setPlaying(current => !current)}>{playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}<span>{playing ? 'Pause' : 'Play'}</span></button>}
        {state === 'ready' && <button type="button" className="cloner-cube-button" onClick={() => setResetKey(current => current + 1)} aria-label="Reset sculpture view" title="Reset sculpture view"><RotateCcw size={16} aria-hidden="true" /></button>}
        <button type="button" className="cloner-cube-button cloner-cube-still" onClick={onStill}><ImageIcon size={16} aria-hidden="true" /><span>Still image</span></button>
      </div>
    </div>
  </div>
}

/** A decorative brand sculpture, deliberately separate from financial data. */
export function ClonerCube({ className = '' }: ClonerCubeProps) {
  const host = useRef<HTMLElement>(null)
  const [entered, setEntered] = useState(() => typeof window !== 'undefined' && !('IntersectionObserver' in window))
  const [visible, setVisible] = useState(() => typeof window !== 'undefined' && !('IntersectionObserver' in window))
  const [pageVisible, setPageVisible] = useState(() => typeof document !== 'undefined' && document.visibilityState !== 'hidden')
  const [smallScreen, setSmallScreen] = useState(() => typeof window === 'undefined' || window.matchMedia('(max-width: 767px)').matches)
  const [reducedMotion, setReducedMotion] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [optedIn, setOptedIn] = useState(false)
  const [stillOnly, setStillOnly] = useState(false)

  useEffect(() => {
    const small = window.matchMedia('(max-width: 767px)')
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const updateSmall = () => setSmallScreen(small.matches)
    const updateReduced = () => { setReducedMotion(reduced.matches); if (reduced.matches) setOptedIn(false) }
    const updateVisibility = () => setPageVisible(document.visibilityState !== 'hidden')
    small.addEventListener('change', updateSmall)
    reduced.addEventListener('change', updateReduced)
    document.addEventListener('visibilitychange', updateVisibility)
    return () => {
      small.removeEventListener('change', updateSmall)
      reduced.removeEventListener('change', updateReduced)
      document.removeEventListener('visibilitychange', updateVisibility)
    }
  }, [])

  useEffect(() => {
    const element = host.current
    if (!element || !('IntersectionObserver' in window)) return
    const near = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setEntered(true); near.disconnect() }
    }, { rootMargin: '160px' })
    const inView = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting))
    near.observe(element)
    inView.observe(element)
    return () => { near.disconnect(); inView.disconnect() }
  }, [])

  const eligible = !stillOnly && (optedIn || (!smallScreen && !reducedMotion))
  const activate = () => { setEntered(true); setStillOnly(false); setOptedIn(true) }
  return <figure ref={host} className={`cloner-cube ${className}`} aria-label="Modular cube, a decorative white-and-teal sculpture">
    {eligible && entered ? <CubeExperience visible={visible && pageVisible} onStill={() => setStillOnly(true)} /> : <div className="cloner-cube-preview" data-state="preview">
      <div className="cloner-cube-stage"><div className="cloner-cube-poster" aria-hidden="true"><CubePoster /></div></div>
      <div className="cloner-cube-footer"><p>{reducedMotion ? 'Still preview · reduced motion' : 'Modular cube'}</p><button type="button" className="cloner-cube-button" onClick={activate}><Play size={16} aria-hidden="true" />Activate 3D</button></div>
    </div>}
    <figcaption className="sr-only">A decorative white voxel cube with mint accents. It does not represent orders, prices or market activity.</figcaption>
  </figure>
}

export default ClonerCube
