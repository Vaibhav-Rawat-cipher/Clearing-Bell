import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { PointerEvent, ReactNode, RefObject } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Minus, Pause, Play, Plus, RotateCcw, SlidersHorizontal } from 'lucide-react'
import * as THREE from 'three'
import { formatUnits } from 'viem'
import type { LiveRound } from '../../types'
import { dragOrbit, nudgeOrbit, orbitKey, presetOrbit, presentationOrbit } from '../../lib/depth-navigation'
import type { Orbit, OrbitAction } from '../../lib/depth-navigation'

type Props = { round: LiveRound | null; variant: 'hero' | 'market'; view: 'front' | 'isometric'; reducedMotion: boolean; active: boolean; fallback: ReactNode }
type Bar = { x: number; height: number; buy: boolean; quantity: bigint; priceLow: bigint; priceHigh: bigint }
const colors = { carbon: '#171b21', silver: '#bac5d0', ask: '#a7bcd0', mint: '#9bd4b7', grid: '#3a4653' }
const displayNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 })

function labelNumber(raw: bigint, decimals: number) {
  const value = Number(formatUnits(raw, decimals))
  return value && (value < .001 || value >= 1e9) ? value.toExponential(2).replace('e+', 'e') : displayNumber.format(value)
}

function canvasTexture(canvas: HTMLCanvasElement) {
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  return texture
}

function LedgerLabel({ text, color = '#dce4ed', position, width = 1, etched = false, vertical = false }: {
  text: string; color?: string; position: [number, number, number]; width?: number; etched?: boolean; vertical?: boolean
}) {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) return null
    context.font = '500 58px "IBM Plex Mono", monospace'
    canvas.width = Math.ceil(context.measureText(text).width + 48)
    canvas.height = 112
    context.font = '500 58px "IBM Plex Mono", monospace'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    if (!etched) { context.strokeStyle = '#101419'; context.lineWidth = 9; context.lineJoin = 'round'; context.strokeText(text, canvas.width / 2, 57) }
    context.fillStyle = color
    context.fillText(text, canvas.width / 2, 57)
    return canvasTexture(canvas)
  }, [text, color, etched])
  useEffect(() => () => texture?.dispose(), [texture])
  if (!texture) return null
  const height = vertical ? .27 : etched ? .3 : .36
  const naturalWidth = height * (texture.image as HTMLCanvasElement).width / 112
  const scale = Math.min(1, width / naturalWidth)
  if (etched) return <mesh position={position} rotation={vertical ? [0, 0, 0] : [-Math.PI / 2, 0, 0]}><planeGeometry args={[naturalWidth * scale, height * scale]} /><meshBasicMaterial map={texture} transparent depthWrite={false} /></mesh>
  return <sprite position={position} scale={[naturalWidth * scale, height * scale, 1]}><spriteMaterial map={texture} transparent depthWrite={false} /></sprite>
}

function chamferedPlate(width: number, height: number, thickness: number, corner: number) {
  const x = width / 2
  const y = height / 2
  const outline = new THREE.Shape()
  outline.moveTo(-x + corner, -y)
  outline.lineTo(x - corner, -y)
  outline.lineTo(x, -y + corner)
  outline.lineTo(x, y - corner)
  outline.lineTo(x - corner, y)
  outline.lineTo(-x + corner, y)
  outline.lineTo(-x, y - corner)
  outline.lineTo(-x, -y + corner)
  outline.closePath()
  const geometry = new THREE.ExtrudeGeometry(outline, { depth: thickness, bevelEnabled: true, bevelSize: .045, bevelThickness: .045, bevelSegments: 2, steps: 1 })
  geometry.translate(0, 0, -thickness / 2)
  return geometry
}

function depthGeometry(round: LiveRound | null) {
  const orders = round?.bids.filter(bid => bid.quantityRaw > 0n) ?? []
  if (!orders.length) return { bars: [] as Bar[], clearingX: null as number | null, minimum: null as bigint | null, maximum: null as bigint | null }
  let min = orders[0].priceRaw
  let max = min
  for (const bid of orders) { if (bid.priceRaw < min) min = bid.priceRaw; if (bid.priceRaw > max) max = bid.priceRaw }
  if (round?.phase === 'closed' && round.clearingPriceRaw > 0n) { if (round.clearingPriceRaw < min) min = round.clearingPriceRaw; if (round.clearingPriceRaw > max) max = round.clearingPriceRaw }
  const span = max - min
  const buckets = new Map<string, { bin: number; quantity: bigint; buy: boolean; priceLow: bigint; priceHigh: bigint }>()
  for (const bid of orders) {
    const bin = span ? Number((bid.priceRaw - min) * 11n / span) : 5
    const key = `${bid.isBuy}-${bin}`
    const previous = buckets.get(key)
    if (previous) { previous.quantity += bid.quantityRaw; if (bid.priceRaw < previous.priceLow) previous.priceLow = bid.priceRaw; if (bid.priceRaw > previous.priceHigh) previous.priceHigh = bid.priceRaw }
    else buckets.set(key, { bin, quantity: bid.quantityRaw, buy: bid.isBuy, priceLow: bid.priceRaw, priceHigh: bid.priceRaw })
  }
  let largest = 1n
  for (const bucket of buckets.values()) if (bucket.quantity > largest) largest = bucket.quantity
  const bars = [...buckets.values()].map(bucket => ({
    x: span ? -2.05 + bucket.bin / 11 * 4.1 : 0,
    height: Math.max(.025, Number(bucket.quantity * 100000n / largest) / 100000 * 1.9), buy: bucket.buy,
    quantity: bucket.quantity, priceLow: bucket.priceLow, priceHigh: bucket.priceHigh,
  }))
  const clearingX = round?.phase === 'closed' && round.clearingPriceRaw > 0n ? span ? -2.05 + Number((round.clearingPriceRaw - min) * 100000n / span) / 100000 * 4.1 : 0 : null
  return { bars, clearingX, minimum: min, maximum: max }
}

function Etching({ round }: { round: LiveRound | null }) {
  const symbol = round?.bond.symbol
  const roundId = round?.id
  const phase = round?.phase
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1024
    canvas.height = 512
    const context = canvas.getContext('2d')
    if (!context) return null
    context.clearRect(0, 0, 1024, 512)
    context.strokeStyle = '#536b71'
    context.lineWidth = 1.5
    context.strokeRect(28, 28, 968, 456)
    context.beginPath(); context.moveTo(55, 365); context.lineTo(968, 365); context.stroke()
    context.fillStyle = '#14262c'
    context.font = '500 23px "IBM Plex Mono", monospace'
    context.fillText('CLEARING BELL', 60, 85)
    context.font = '400 84px "IBM Plex Sans Variable", sans-serif'
    context.fillText(symbol ?? 'BOND LEDGER', 55, 190)
    context.font = '400 25px "IBM Plex Mono", monospace'
    context.fillStyle = '#354f56'
    context.fillText(roundId && phase ? `ROUND ${roundId.padStart(3, '0')}  /  ${phase.toUpperCase()}` : 'AWAITING MARKET DATA', 60, 260)
    context.font = '400 20px "IBM Plex Mono", monospace'
    context.fillText('PRICE PRIORITY  /  UNIFORM SETTLEMENT', 60, 417)
    return canvasTexture(canvas)
  }, [symbol, roundId, phase])
  useEffect(() => () => texture?.dispose(), [texture])
  if (!texture) return null
  return <mesh position={[0, 1.42, -1.09]}><planeGeometry args={[4.75, 2.37]} /><meshBasicMaterial map={texture} transparent opacity={.85} depthWrite={false} /></mesh>
}

function Ledger({ round, variant }: { round: LiveRound | null; variant: 'hero' | 'market' }) {
  const { bars, clearingX, minimum, maximum } = useMemo(() => depthGeometry(round), [round])
  const base = useMemo(() => chamferedPlate(5.55, 3.05, .16, .23), [])
  const certificate = useMemo(() => chamferedPlate(4.95, 2.55, .08, .17), [])
  const baseEdges = useMemo(() => new THREE.EdgesGeometry(base, 28), [base])
  const certificateEdges = useMemo(() => new THREE.EdgesGeometry(certificate, 28), [certificate])
  const brushedMetal = useMemo(() => {
    const data = new Uint8Array(128 * 128 * 4)
    for (let y = 0; y < 128; y++) {
      const shade = 178 + y * 13 % 57
      for (let x = 0; x < 128; x++) { const i = (y * 128 + x) * 4; data[i] = shade; data[i + 1] = shade; data[i + 2] = shade; data[i + 3] = 255 }
    }
    const map = new THREE.DataTexture(data, 128, 128)
    map.needsUpdate = true
    map.minFilter = THREE.LinearFilter
    map.magFilter = THREE.LinearFilter
    return map
  }, [])
  const grid = useMemo(() => {
    const vertices: number[] = []
    for (let i = 0; i <= 12; i++) { const x = -2.45 + i * 4.9 / 12; vertices.push(x, .125, -1.25, x, .125, 1.25) }
    for (let i = 0; i <= 6; i++) { const z = -1.25 + i * 2.5 / 6; vertices.push(-2.45, .125, z, 2.45, .125, z) }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
    return geometry
  }, [])
  useEffect(() => () => { base.dispose(); certificate.dispose(); baseEdges.dispose(); certificateEdges.dispose(); grid.dispose(); brushedMetal.dispose() }, [base, certificate, baseEdges, certificateEdges, grid, brushedMetal])
  return <group position={[0, -.76, 0]}>
    <mesh geometry={base} rotation={[-Math.PI / 2, 0, 0]} position={[0, -.065, 0]} scale={[1.014, 1.014, .38]}><meshPhysicalMaterial color="#bec6d0" metalness={.75} roughness={.25} /></mesh>
    <mesh geometry={base} rotation={[-Math.PI / 2, 0, 0]} receiveShadow><meshPhysicalMaterial color={colors.carbon} metalness={.42} roughness={.56} clearcoat={.12} /></mesh>
    <lineSegments geometry={baseEdges} rotation={[-Math.PI / 2, 0, 0]}><lineBasicMaterial color={colors.silver} transparent opacity={.65} /></lineSegments>
    <lineSegments geometry={grid}><lineBasicMaterial color={colors.grid} transparent opacity={.4} /></lineSegments>
    <LedgerLabel text="BID" color={colors.mint} position={[-2.48, .141, .66]} width={.48} etched />
    <LedgerLabel text="ASK" color={colors.ask} position={[-2.48, .141, -.32]} width={.48} etched />
    <LedgerLabel text={`PRICE · ${round?.settlement.symbol ?? '—'}`} position={[0, -.015, 1.58]} width={1.9} etched vertical />
    {minimum !== null && maximum !== null && <>
      <LedgerLabel text={labelNumber(minimum, round?.settlement.decimals ?? 6)} position={[-2.05, .142, 1.34]} width={.95} etched />
      <LedgerLabel text={labelNumber(maximum, round?.settlement.decimals ?? 6)} position={[2.05, .142, 1.34]} width={.95} etched />
    </>}
    {variant === 'hero' && <>
      <mesh geometry={certificate} position={[.035, 1.385, -1.3]} castShadow><meshStandardMaterial color="#26363b" metalness={.7} roughness={.3} /></mesh>
      <lineSegments geometry={certificateEdges} position={[.035, 1.385, -1.3]}><lineBasicMaterial color="#d1dedd" transparent opacity={.7} /></lineSegments>
      <mesh geometry={certificate} position={[0, 1.42, -1.18]} castShadow><meshPhysicalMaterial color="#b2c1c3" metalness={.48} roughness={.6} roughnessMap={brushedMetal} clearcoat={.35} /></mesh>
      <lineSegments geometry={certificateEdges} position={[0, 1.42, -1.18]}><lineBasicMaterial color="#eff9f6" transparent opacity={.9} /></lineSegments>
      <Etching round={round} />
    </>}
    {bars.map((bar, index) => <group key={`${bar.buy}-${bar.x}-${index}`} position={[bar.x, .13 + bar.height / 2, bar.buy ? .66 : -.32]}>
      <mesh castShadow receiveShadow><boxGeometry args={[.25, bar.height, .59]} /><meshPhysicalMaterial color={bar.buy ? colors.mint : colors.ask} metalness={bar.buy ? .25 : .65} roughness={.33} clearcoat={.2} /></mesh>
      <mesh position={[0, bar.height / 2 + .006, 0]}><boxGeometry args={[.25, .012, .59]} /><meshBasicMaterial color={bar.buy ? '#c6efda' : '#e0e7f1'} /></mesh>
      {bars.length <= 6 && <LedgerLabel text={labelNumber(bar.quantity, round?.bond.decimals ?? 18)} color={bar.buy ? '#c0e9d4' : '#d3dfec'} position={[0, bar.height / 2 + .19, 0]} width={Math.max(.8, labelNumber(bar.quantity, round?.bond.decimals ?? 18).length * .12)} />}
    </group>)}
    {bars.length <= 6 && bars.map((bar, index) => <LedgerLabel key={`price-${index}`} text={bar.priceLow === bar.priceHigh ? labelNumber(bar.priceLow, round?.settlement.decimals ?? 6) : `${labelNumber(bar.priceLow, round?.settlement.decimals ?? 6)}–${labelNumber(bar.priceHigh, round?.settlement.decimals ?? 6)}`} color={bar.buy ? '#b9d8c8' : '#b5c8db'} position={[bar.x, .30, bar.buy ? 1.08 : .09]} width={bar.priceLow === bar.priceHigh ? .95 : 1.45} />)}
    {clearingX !== null && <group position={[clearingX, 1.22, 0]}>
      <mesh><boxGeometry args={[.016, 2.2, 2.58]} /><meshBasicMaterial color={colors.mint} transparent opacity={.16} depthWrite={false} /></mesh>
      <mesh position={[0, 1.1, 0]}><boxGeometry args={[.022, .018, 2.58]} /><meshBasicMaterial color={colors.mint} /></mesh>
      <mesh position={[0, 0, 1.29]}><boxGeometry args={[.022, 2.2, .018]} /><meshBasicMaterial color={colors.mint} /></mesh>
    </group>}
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -.16, 0]} receiveShadow><planeGeometry args={[20, 20]} /><shadowMaterial transparent opacity={.38} /></mesh>
  </group>
}

function CameraRig({ reducedMotion, active, orbit, liveOrbitRef, playing, variant }: Pick<Props, 'reducedMotion' | 'active' | 'variant'> & { orbit: Orbit; liveOrbitRef: RefObject<Orbit>; playing: boolean }) {
  const { size, invalidate } = useThree()
  const desired = useMemo(() => new THREE.Vector3(), [])
  const lookAt = useMemo(() => new THREE.Vector3(0, variant === 'hero' ? .32 : .02, 0), [variant])
  const elapsed = useRef(0)
  const initialized = useRef(false)
  useEffect(() => { elapsed.current = 0; invalidate() }, [orbit, playing, invalidate])
  useEffect(() => { invalidate() }, [reducedMotion, active, size.width, size.height, invalidate])
  useFrame((state, delta) => {
    if (!active) return
    const camera = state.camera
    const moving = playing && !reducedMotion
    if (moving) elapsed.current += Math.min(delta, .05)
    const target = moving ? presentationOrbit(orbit, elapsed.current) : orbit
    liveOrbitRef.current = target
    const radius = 10
    desired.set(radius * Math.cos(target.elevation) * Math.sin(target.azimuth), lookAt.y + radius * Math.sin(target.elevation), radius * Math.cos(target.elevation) * Math.cos(target.azimuth))
    const immediate = reducedMotion || !initialized.current
    const damping = immediate ? 1 : 1 - Math.exp(-Math.min(delta, .05) * 12)
    camera.position.lerp(desired, damping)
    camera.lookAt(lookAt)
    let zoomSettled = true
    if (camera instanceof THREE.OrthographicCamera) {
      const zoom = Math.min(size.width / 8.8, size.height / (variant === 'hero' ? 5 : 4.2)) * target.zoom
      zoomSettled = Math.abs(camera.zoom - zoom) < .01
      camera.zoom = zoomSettled ? zoom : THREE.MathUtils.lerp(camera.zoom, zoom, damping)
      camera.updateProjectionMatrix()
    }
    initialized.current = true
    if (moving || (!reducedMotion && (camera.position.distanceToSquared(desired) > .00001 || !zoomSettled))) invalidate()
  })
  return null
}

export default function MarketDepthCanvas({ round, variant, view, reducedMotion, active, fallback }: Props) {
  const [orbit, setOrbit] = useState(() => presetOrbit(view))
  const [playing, setPlaying] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== 'hidden')
  const [ready, setReady] = useState(false)
  const liveOrbit = useRef(orbit)
  const hintId = useId()
  const drag = useRef<{ id: number; x: number; y: number; width: number; height: number; start: Orbit; touch: boolean } | null>(null)
  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  const pause = () => { if (playing) setOrbit(liveOrbit.current); setPlaying(false) }
  const reset = () => { setPlaying(false); setOrbit(presetOrbit(view)) }
  const adjust = (action: OrbitAction) => { setPlaying(false); setOrbit(nudgeOrbit(liveOrbit.current, action)) }
  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return
    drag.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const controls = [
    ['left', 'Rotate left', ArrowLeft], ['right', 'Rotate right', ArrowRight], ['up', 'Tilt up', ArrowUp],
    ['down', 'Tilt down', ArrowDown], ['out', 'Zoom out', Minus], ['in', 'Zoom in', Plus],
  ] as const
  return <div className="depth-explorer">
    <div className={`depth-orbit-viewport${dragging ? ' is-dragging' : ''}`} role="group" tabIndex={ready ? 0 : -1} aria-label="Interactive 3D order depth" aria-describedby={hintId}
      onFocus={pause}
      onKeyDown={event => {
        if (event.altKey || event.metaKey || event.ctrlKey) return
        const action = orbitKey(event.key)
        if (!action) return
        event.preventDefault()
        if (action === 'reset') reset(); else adjust(action)
      }}
      onPointerDown={event => {
        if (!ready || !event.isPrimary || event.button !== 0) return
        pause()
        event.currentTarget.focus({ preventScroll: true })
        const rect = event.currentTarget.getBoundingClientRect()
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, width: rect.width, height: rect.height, start: liveOrbit.current, touch: event.pointerType === 'touch' }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => {
        const start = drag.current
        if (!start || start.id !== event.pointerId) return
        const dx = event.clientX - start.x
        const dy = event.clientY - start.y
        if (Math.hypot(dx, dy) < 5) return
        setDragging(true)
        // Touch retains vertical page scrolling and pinch-to-zoom; tilt also has tap controls.
        setOrbit(dragOrbit(start.start, dx, start.touch ? 0 : dy, start.width, start.height))
      }}
      onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={finishDrag}>
    <Canvas orthographic shadows frameloop="demand" dpr={[1, 1.5]} camera={{ position: [5.5, 4.6, 7.5], zoom: 70, near: .1, far: 60 }}
    gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }} fallback={fallback}
    onCreated={({ gl }) => { gl.setClearColor('#091113', 0); gl.toneMappingExposure = 1.2; setReady(true) }} aria-hidden="true">
    <ambientLight intensity={.65} />
    <hemisphereLight args={['#edf1f8', '#191d24', 1.35]} />
    <directionalLight position={[-3, 7, 5]} intensity={3.7} color="#f4f5f8" castShadow shadow-mapSize={[1024, 1024]} shadow-bias={-.001} shadow-camera-left={-5} shadow-camera-right={5} shadow-camera-top={5} shadow-camera-bottom={-5} />
    <directionalLight position={[5, 3, -2]} intensity={3.4} color="#b2c4d2" />
    <directionalLight position={[-4, 2, -4]} intensity={1.5} color="#c1ccd9" />
    <Ledger round={round} variant={variant} />
    <CameraRig reducedMotion={reducedMotion} active={active && pageVisible} orbit={orbit} liveOrbitRef={liveOrbit} playing={playing} variant={variant} />
    </Canvas>
    </div>
    {ready && <div className="depth-navigation">
      <p id={hintId}><span>Drag to explore</span><span className="depth-keyboard-hint">Arrow keys rotate · + / − zoom · Home resets</span></p>
      <div className="depth-navigation-actions">
        <button type="button" onClick={() => { if (playing) pause(); else setPlaying(true) }} disabled={reducedMotion} aria-pressed={playing && !reducedMotion} aria-label={playing && !reducedMotion ? 'Pause motion' : 'Play motion'} title={reducedMotion ? 'Motion disabled by your reduced-motion preference' : playing ? 'Pause motion' : 'Play motion'}>{playing && !reducedMotion ? <Pause aria-hidden="true" size={16} /> : <Play aria-hidden="true" size={16} />}</button>
        <button type="button" onClick={reset} aria-label="Reset 3D view" title="Reset view"><RotateCcw aria-hidden="true" size={16} /></button>
        <details className="depth-adjustments" onToggle={event => { if (event.currentTarget.open) pause() }} onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() } }}>
          <summary aria-label="Adjust 3D view" title="Adjust view"><SlidersHorizontal aria-hidden="true" size={16} /></summary>
          <div className="depth-adjustment-panel" role="group" aria-label="3D view adjustments">
            {controls.map(([action, label, Icon]) => <button type="button" key={action} onClick={() => adjust(action)}><Icon size={16} aria-hidden="true" /><span>{label}</span></button>)}
          </div>
        </details>
      </div>
    </div>}
  </div>
}
