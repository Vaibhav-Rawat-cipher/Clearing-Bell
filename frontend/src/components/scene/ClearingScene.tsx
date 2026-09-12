import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { AuctionPhase } from '../../types'

type SceneProps = { phase: AuctionPhase; reducedMotion?: boolean }
type Side = -1 | 1

const phaseIndex: Record<AuctionPhase, number> = { commit: 0, reveal: 1, clear: 2, settle: 3 }
const LEVELS = 7

// Normalized, non-financial geometry for the explicitly labelled process schematic.
// The actual order book is rendered from contract bids in ClearingCurve.
const bidDepth = [.24, .37, .5, .63, .76, .89, 1]
const askDepth = [.2, .31, .45, .59, .72, .86, 1]

function stepTarget(index: number, side: Side, stage: number, quantity: number, maximum: number) {
  const depth = .56 + (quantity / maximum) * 1.28
  const distanceFromCentre = 2.28 - index * .29
  const openY = side === -1 ? -.63 + index * .095 : .63 - index * .095

  if (stage === 0) {
    return {
      position: new THREE.Vector3(side * (1.52 + (index % 2) * .11), -.6 + index * .19, .7 - index * .035),
      rotation: new THREE.Euler(0, side * .12, 0),
      scale: new THREE.Vector3(.46, .065, .22),
    }
  }

  const centrePull = stage >= 2 ? .07 : 0
  const matched = index >= LEVELS - 2
  const settling = stage === 3 && matched
  const resolvedDepth = settling ? .32 + (LEVELS - 1 - index) * .08 : depth

  return {
    position: new THREE.Vector3(
      settling ? side * (.56 + (LEVELS - 1 - index) * .34) : side * (distanceFromCentre - centrePull),
      settling ? -.73 : openY,
      1.06 - resolvedDepth / 2,
    ),
    rotation: new THREE.Euler(0, 0, 0),
    scale: new THREE.Vector3(settling ? .28 : .255, settling ? .07 : .065, resolvedDepth),
  }
}

function DepthSteps({ side, stage, reducedMotion }: { side: Side; stage: number; reducedMotion?: boolean }) {
  const mesh = useRef<THREE.InstancedMesh>(null)
  const dummy = useMemo(() => new THREE.Object3D(), [])
  const depths = side === -1 ? bidDepth : askDepth
  const maximum = 1
  const current = useRef(depths.map((quantity, index) => stepTarget(index, side, 0, quantity, maximum)))
  const graphite = useMemo(() => new THREE.Color(side === -1 ? '#59616b' : '#8b8378'), [side])
  const resolved = useMemo(() => new THREE.Color('#aaa1c2'), [])
  const { invalidate } = useThree()

  const draw = (instant = false) => {
    if (!mesh.current) return

    current.current.forEach((state, index) => {
      const target = stepTarget(index, side, stage, depths[index], maximum)
      if (instant) {
        state.position.copy(target.position)
        state.rotation.copy(target.rotation)
        state.scale.copy(target.scale)
      } else {
        state.position.lerp(target.position, .075)
        state.rotation.x = THREE.MathUtils.lerp(state.rotation.x, target.rotation.x, .075)
        state.rotation.y = THREE.MathUtils.lerp(state.rotation.y, target.rotation.y, .075)
        state.rotation.z = THREE.MathUtils.lerp(state.rotation.z, target.rotation.z, .075)
        state.scale.lerp(target.scale, .075)
      }

      dummy.position.copy(state.position)
      dummy.rotation.copy(state.rotation)
      dummy.scale.copy(state.scale)
      dummy.updateMatrix()
      mesh.current!.setMatrixAt(index, dummy.matrix)
      mesh.current!.setColorAt(index, stage >= 2 && index >= LEVELS - 2 ? resolved : graphite)
    })

    mesh.current.instanceMatrix.needsUpdate = true
    if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true
  }

  useEffect(() => {
    if (!reducedMotion) return
    draw(true)
    invalidate()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, reducedMotion, invalidate])

  useFrame(() => {
    if (!reducedMotion) draw()
  })

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, LEVELS]} frustumCulled={false}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial roughness={.76} metalness={.16} />
    </instancedMesh>
  )
}

function usePriceTexture() {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 96
    const context = canvas.getContext('2d')
    if (!context) return null

    context.fillStyle = '#e8e5dd'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#151519'
    context.font = '600 38px "IBM Plex Mono", monospace'
    context.textBaseline = 'middle'
    context.fillText('PRICE', 22, 47)
    context.fillStyle = '#66636b'
    context.font = '500 13px "IBM Plex Mono", monospace'
    context.textAlign = 'right'
    context.fillText('CLEAR', 296, 48)

    const next = new THREE.CanvasTexture(canvas)
    next.colorSpace = THREE.SRGBColorSpace
    next.minFilter = THREE.LinearFilter
    return next
  }, [])

  useEffect(() => () => texture?.dispose(), [texture])
  return texture
}

function ClearingDatum({ stage, reducedMotion }: { stage: number; reducedMotion?: boolean }) {
  const group = useRef<THREE.Group>(null)
  const surface = useRef<THREE.MeshStandardMaterial>(null)
  const edge = useRef<THREE.MeshStandardMaterial>(null)
  const label = useRef<THREE.SpriteMaterial>(null)
  const texture = usePriceTexture()
  const { invalidate } = useThree()

  const update = (instant = false) => {
    if (!group.current || !surface.current || !edge.current || !label.current) return
    const targetY = stage === 0 ? .82 : stage === 1 ? .28 : 0
    const surfaceOpacity = stage >= 2 ? .13 : stage === 1 ? .04 : 0
    const edgeOpacity = stage >= 2 ? .88 : stage === 1 ? .2 : .05
    const labelOpacity = stage >= 2 ? 1 : 0
    const amount = instant ? 1 : .075

    group.current.position.y = THREE.MathUtils.lerp(group.current.position.y, targetY, amount)
    surface.current.opacity = THREE.MathUtils.lerp(surface.current.opacity, surfaceOpacity, amount)
    edge.current.opacity = THREE.MathUtils.lerp(edge.current.opacity, edgeOpacity, amount)
    label.current.opacity = THREE.MathUtils.lerp(label.current.opacity, labelOpacity, amount)
  }

  useEffect(() => {
    if (!reducedMotion) return
    update(true)
    invalidate()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, reducedMotion, invalidate])

  useFrame(() => {
    if (!reducedMotion) update()
  })

  return (
    <group ref={group} position={[0, .82, 0]}>
      <mesh>
        <boxGeometry args={[4.92, .014, 2.38]} />
        <meshStandardMaterial ref={surface} color="#aaa2bf" roughness={.86} metalness={.06} transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh position={[0, .02, 1.205]}>
        <boxGeometry args={[4.92, .034, .025]} />
        <meshStandardMaterial ref={edge} color="#9a8fc1" roughness={.62} metalness={.22} transparent opacity={.05} />
      </mesh>
      {texture && (
        <sprite position={[2.08, .19, 1.22]} scale={[.8, .24, 1]}>
          <spriteMaterial ref={label} map={texture} transparent opacity={0} depthTest={false} />
        </sprite>
      )}
    </group>
  )
}

function SettlementRail({ stage, reducedMotion }: { stage: number; reducedMotion?: boolean }) {
  const asset = useRef<THREE.Mesh>(null)
  const payment = useRef<THREE.Mesh>(null)
  const railMaterial = useRef<THREE.MeshStandardMaterial>(null)
  const { invalidate } = useThree()

  const update = (instant = false) => {
    if (!asset.current || !payment.current || !railMaterial.current) return
    const amount = instant ? 1 : .065
    const settled = stage === 3
    asset.current.position.x = THREE.MathUtils.lerp(asset.current.position.x, settled ? 1.46 : -1.46, amount)
    payment.current.position.x = THREE.MathUtils.lerp(payment.current.position.x, settled ? -1.46 : 1.46, amount)
    railMaterial.current.opacity = THREE.MathUtils.lerp(railMaterial.current.opacity, stage >= 2 ? .72 : .22, amount)
  }

  useEffect(() => {
    if (!reducedMotion) return
    update(true)
    invalidate()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, reducedMotion, invalidate])

  useFrame(() => {
    if (!reducedMotion) update()
  })

  return (
    <group position={[0, -.84, 1.02]}>
      <mesh>
        <boxGeometry args={[4.2, .025, .075]} />
        <meshStandardMaterial ref={railMaterial} color="#a5a39d" roughness={.58} metalness={.46} transparent opacity={.22} />
      </mesh>
      <mesh position={[-2.1, .045, 0]}><boxGeometry args={[.025, .12, .075]} /><meshStandardMaterial color="#706f6b" roughness={.66} metalness={.3} /></mesh>
      <mesh position={[2.1, .045, 0]}><boxGeometry args={[.025, .12, .075]} /><meshStandardMaterial color="#706f6b" roughness={.66} metalness={.3} /></mesh>
      <mesh ref={asset} position={[-1.46, .075, 0]}>
        <boxGeometry args={[.4, .115, .16]} />
        <meshStandardMaterial color="#9c93b6" roughness={.7} metalness={.18} />
      </mesh>
      <mesh ref={payment} position={[1.46, .075, 0]}>
        <boxGeometry args={[.4, .115, .16]} />
        <meshStandardMaterial color="#d2cec3" roughness={.78} metalness={.12} />
      </mesh>
    </group>
  )
}

function LedgerAssembly({ phase, reducedMotion }: SceneProps) {
  const stage = phaseIndex[phase]
  const assembly = useRef<THREE.Group>(null)
  const { invalidate } = useThree()

  useEffect(() => {
    if (!reducedMotion || !assembly.current) return
    assembly.current.rotation.set(-.12, 0, 0)
    invalidate()
  }, [reducedMotion, invalidate])

  useFrame((state, delta) => {
    if (!assembly.current || reducedMotion) return
    assembly.current.rotation.x = THREE.MathUtils.damp(assembly.current.rotation.x, -.12 - state.pointer.y * .018, 2.5, delta)
    assembly.current.rotation.y = THREE.MathUtils.damp(assembly.current.rotation.y, state.pointer.x * .035, 2.5, delta)
  })

  return (
    <group ref={assembly} position={[0, .03, 0]} rotation={[-.12, 0, 0]}>
      <DepthSteps side={-1} stage={stage} reducedMotion={reducedMotion} />
      <DepthSteps side={1} stage={stage} reducedMotion={reducedMotion} />
      <ClearingDatum stage={stage} reducedMotion={reducedMotion} />
      <SettlementRail stage={stage} reducedMotion={reducedMotion} />
    </group>
  )
}

function MarketField({ phase, reducedMotion }: SceneProps) {
  return (
    <>
      <ambientLight intensity={.82} color="#ddd9d0" />
      <directionalLight position={[3.5, 5.5, 5]} intensity={2.15} color="#f0ede5" />
      <directionalLight position={[-4, -1.5, 3]} intensity={.55} color="#9da5b0" />
      <LedgerAssembly phase={phase} reducedMotion={reducedMotion} />
    </>
  )
}

export default function ClearingScene({ phase, reducedMotion }: SceneProps) {
  return (
    <Canvas camera={{ position: [0, .25, 6.6], fov: 39 }} dpr={[1, 1.5]} frameloop={reducedMotion ? 'demand' : 'always'} gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}>
      <MarketField phase={phase} reducedMotion={reducedMotion} />
    </Canvas>
  )
}
