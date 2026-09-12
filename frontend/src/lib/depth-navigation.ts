export type DepthView = 'front' | 'isometric'
export type Orbit = { azimuth: number; elevation: number; zoom: number }
export type OrbitAction = 'left' | 'right' | 'up' | 'down' | 'in' | 'out'

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function presetOrbit(view: DepthView): Orbit {
  return { azimuth: view === 'front' ? 0 : .63, elevation: view === 'front' ? .34 : .47, zoom: 1 }
}

// Keep the certificate face, price axis and volume bars in view at every angle.
export function boundOrbit(orbit: Orbit): Orbit {
  return { azimuth: clamp(orbit.azimuth, -.9, .9), elevation: clamp(orbit.elevation, .24, .98), zoom: clamp(orbit.zoom, .85, 1.2) }
}

export function dragOrbit(start: Orbit, dx: number, dy: number, width: number, height: number): Orbit {
  return boundOrbit({ ...start, azimuth: start.azimuth - dx / Math.max(1, width) * 2.2, elevation: start.elevation + dy / Math.max(1, height) * .9 })
}

export function nudgeOrbit(orbit: Orbit, action: OrbitAction): Orbit {
  return boundOrbit({
    azimuth: orbit.azimuth + (action === 'left' ? -.14 : action === 'right' ? .14 : 0),
    elevation: orbit.elevation + (action === 'up' ? .1 : action === 'down' ? -.1 : 0),
    zoom: orbit.zoom + (action === 'in' ? .1 : action === 'out' ? -.1 : 0),
  })
}

export function orbitKey(key: string): OrbitAction | 'reset' | null {
  const actions: Record<string, OrbitAction | 'reset'> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', '+': 'in', '=': 'in', '-': 'out', Home: 'reset' }
  return actions[key] ?? null
}

export function presentationOrbit(orbit: Orbit, elapsed: number): Orbit {
  return boundOrbit({ ...orbit, azimuth: orbit.azimuth + Math.sin(elapsed * .3) * .18, elevation: orbit.elevation + Math.sin(elapsed * .22) * .045 })
}
