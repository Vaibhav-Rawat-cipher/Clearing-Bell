import { useEffect, useId, useRef } from 'react'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { CUBE_PARTS } from '../../lib/modular-cube'

type Props = {
  active: boolean
  resetKey: number
  onLoaded: () => void
  onFailure: () => void
  onInteract: () => void
}
type CubeController = { setActive: (active: boolean) => void; reset: () => void }

/** Local geometry only: no scene downloads, textures, SDK branding or remote requests. */
export default function ClonerCubeRuntime({ active, resetKey, onLoaded, onFailure, onInteract }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const controller = useRef<CubeController | null>(null)
  const callbacks = useRef({ onLoaded, onFailure, onInteract })
  const activeRef = useRef(active)
  const instructionsId = useId()

  useEffect(() => { callbacks.current = { onLoaded, onFailure, onInteract } }, [onLoaded, onFailure, onInteract])
  useEffect(() => { activeRef.current = active; controller.current?.setActive(active) }, [active])
  useEffect(() => { controller.current?.reset() }, [resetKey])

  useEffect(() => {
    const host = container.current
    const element = canvas.current
    if (!host || !element) return

    let disposed = false
    let renderer: THREE.WebGLRenderer | undefined
    let resizeObserver: ResizeObserver | undefined
    let frame = 0
    let activeNow = activeRef.current
    let lastTime = 0
    let yaw = 0
    let pitch = 0
    let pointer: { id: number; x: number; y: number; touch: boolean } | null = null
    let hasSize = false
    let reportedReady = false
    const geometry = new RoundedBoxGeometry(1, 1, 1, 1, .035)
    const materials = {
      porcelain: new THREE.MeshStandardMaterial({ color: '#e9edf3', roughness: .38, metalness: .12 }),
      teal: new THREE.MeshStandardMaterial({ color: '#48c8ad', roughness: .3, metalness: .24 }),
      dark: new THREE.MeshStandardMaterial({ color: '#1b2830', roughness: .65, metalness: .18 }),
    }
    const scene = new THREE.Scene()
    const sculpture = new THREE.Group()
    scene.add(sculpture)
    const camera = new THREE.OrthographicCamera(-3.4, 3.4, 2.9, -2.9, .1, 50)
    camera.position.set(6, 4.5, 6)
    camera.lookAt(0, 0, 0)

    for (const material of ['porcelain', 'teal', 'dark'] as const) {
      const parts = CUBE_PARTS.filter(part => part.material === material)
      if (!parts.length) continue
      const mesh = new THREE.InstancedMesh(geometry, materials[material], parts.length)
      const transform = new THREE.Object3D()
      parts.forEach((part, index) => {
        transform.position.set(...part.position)
        transform.scale.set(...part.size)
        transform.updateMatrix()
        mesh.setMatrixAt(index, transform.matrix)
      })
      mesh.instanceMatrix.needsUpdate = true
      mesh.castShadow = true
      mesh.receiveShadow = true
      sculpture.add(mesh)
    }

    scene.add(new THREE.HemisphereLight('#eef5ff', '#233730', 2.2))
    const key = new THREE.DirectionalLight('#fff9ee', 4.2)
    key.position.set(-3, 7, 5)
    key.castShadow = true
    key.shadow.mapSize.set(1024, 1024)
    key.shadow.camera.left = key.shadow.camera.bottom = -3
    key.shadow.camera.right = key.shadow.camera.top = 3
    key.shadow.camera.near = 1
    key.shadow.camera.far = 18
    key.shadow.normalBias = .025
    key.shadow.bias = -.00015
    scene.add(key)
    const rim = new THREE.DirectionalLight('#bed5ff', 2)
    rim.position.set(4, 2, -4)
    scene.add(rim)

    const stop = () => { window.cancelAnimationFrame(frame); frame = 0; lastTime = 0 }
    const fail = () => { if (!disposed) { activeNow = false; stop(); callbacks.current.onFailure() } }
    const draw = (time: number) => {
      frame = 0
      if (disposed || !renderer || !hasSize) return false
      const delta = lastTime ? Math.min((time - lastTime) / 1000, .05) : 0
      lastTime = time
      if (activeNow && !pointer) yaw = (yaw + delta * .085) % (Math.PI * 2)
      sculpture.rotation.set(pitch, yaw, 0)
      try { renderer.render(scene, camera) } catch { fail(); return false }
      if (!reportedReady) { reportedReady = true; callbacks.current.onLoaded() }
      if (activeNow) frame = window.requestAnimationFrame(draw)
      return true
    }
    const invalidate = () => { if (!disposed && !frame) frame = window.requestAnimationFrame(draw) }
    const resize = () => {
      if (disposed || !renderer) return
      const { width, height } = host.getBoundingClientRect()
      hasSize = width > 0 && height > 0
      if (!hasSize) { stop(); return }
      // Render a fresh frame even when paused: resizing clears the WebGL buffer.
      const aspect = width / height
      const halfHeight = Math.max(2.65, 2.65 / aspect)
      camera.left = -halfHeight * aspect
      camera.right = halfHeight * aspect
      camera.top = halfHeight
      camera.bottom = -halfHeight
      camera.updateProjectionMatrix()
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
      renderer.setSize(Math.round(width), Math.round(height), false)
      invalidate()
    }
    const beginDrag = (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0) return
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, touch: event.pointerType === 'touch' }
      host.setPointerCapture(event.pointerId)
    }
    const drag = (event: PointerEvent) => {
      if (!pointer || pointer.id !== event.pointerId) return
      const dx = event.clientX - pointer.x
      const dy = event.clientY - pointer.y
      if (Math.abs(dx) + Math.abs(dy) < 2) return
      callbacks.current.onInteract()
      yaw += dx / Math.max(host.clientWidth, 1) * 4
      if (!pointer.touch) pitch = THREE.MathUtils.clamp(pitch + dy / Math.max(host.clientHeight, 1) * 2, -.45, .45)
      pointer.x = event.clientX
      pointer.y = event.clientY
      invalidate()
    }
    const endDrag = (event: PointerEvent) => {
      if (pointer?.id !== event.pointerId) return
      pointer = null
      if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId)
    }
    const reset = () => { yaw = 0; pitch = 0; lastTime = 0; invalidate() }
    const keyDown = (event: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return
      event.preventDefault()
      callbacks.current.onInteract()
      if (event.key === 'Home') { reset(); return }
      if (event.key === 'ArrowLeft') yaw -= .15
      if (event.key === 'ArrowRight') yaw += .15
      if (event.key === 'ArrowUp') pitch = Math.max(-.45, pitch - .1)
      if (event.key === 'ArrowDown') pitch = Math.min(.45, pitch + .1)
      invalidate()
    }
    const lost = (event: Event) => { event.preventDefault(); fail() }
    const dispose = () => {
      disposed = true
      stop()
      resizeObserver?.disconnect()
      window.removeEventListener('resize', resize)
      host.removeEventListener('pointerdown', beginDrag)
      host.removeEventListener('pointermove', drag)
      host.removeEventListener('pointerup', endDrag)
      host.removeEventListener('pointercancel', endDrag)
      host.removeEventListener('lostpointercapture', endDrag)
      host.removeEventListener('keydown', keyDown)
      element.removeEventListener('webglcontextlost', lost)
      sculpture.children.forEach(child => { if (child instanceof THREE.InstancedMesh) child.dispose() })
      geometry.dispose()
      Object.values(materials).forEach(material => material.dispose())
      key.shadow.dispose()
      renderer?.dispose()
      // StrictMode reuses the DOM canvas on effect replay. Forcing context loss
      // here would invalidate the new renderer; explicit GPU disposal is enough.
      controller.current = null
    }

    try {
      renderer = new THREE.WebGLRenderer({ canvas: element, alpha: true, antialias: true, powerPreference: 'low-power' })
      renderer.setClearColor('#0b0d11', 0)
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      renderer.toneMappingExposure = 1.05
      renderer.shadowMap.enabled = true
      renderer.shadowMap.type = THREE.PCFSoftShadowMap
      element.addEventListener('webglcontextlost', lost)
      host.addEventListener('pointerdown', beginDrag)
      host.addEventListener('pointermove', drag)
      host.addEventListener('pointerup', endDrag)
      host.addEventListener('pointercancel', endDrag)
      host.addEventListener('lostpointercapture', endDrag)
      host.addEventListener('keydown', keyDown)
      controller.current = {
        setActive(next) { activeNow = next; stop(); invalidate() },
        reset,
      }
      resize()
      // Complete the first render before replacing the independently usable poster.
      stop()
      draw(performance.now())
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(resize)
        resizeObserver.observe(host)
      } else window.addEventListener('resize', resize)
    } catch { fail() }

    return dispose
  }, [])

  return <div ref={container} className="cloner-cube-runtime" tabIndex={0} role="group" aria-label="Rotate the 3D cube" aria-describedby={instructionsId}>
    <canvas ref={canvas} aria-hidden="true" />
    <span id={instructionsId} className="sr-only">Drag to rotate, or use the arrow keys. Home resets the view. Interacting pauses automatic rotation.</span>
  </div>
}
