export type CubePart = {
  position: [number, number, number]
  size: [number, number, number]
  material: 'porcelain' | 'teal' | 'dark'
}

type Panel = { x: number; y: number; width: number; height: number }
const MACRO_PITCH = 0.48
const FACE_START = 1.45
const GAP = 0.026

// An original six-by-six architectural layout: broad plates, a narrow rail,
// and stepped voxel bands. These coordinates are authored, not imported assets.
const LANDMARKS: readonly Panel[] = [
  { x: 0, y: 0, width: 2, height: 2 },
  { x: 4, y: 1, width: 1, height: 2 },
  { x: 1, y: 4, width: 2, height: 1 },
  { x: 4, y: 4, width: 2, height: 2 },
]
const FACE_TURNS = [0, 2, 3, 1, 1, 3] as const

function rotate(panel: Panel, turns: number): Panel {
  let result = panel
  for (let step = 0; step < turns; step++) {
    result = { x: 6 - result.y - result.height, y: result.x, width: result.height, height: result.width }
  }
  return result
}

function createParts(): CubePart[] {
  const parts: CubePart[] = [{ position: [0, 0, 0], size: [2.9, 2.9, 2.9], material: 'dark' }]
  for (let face = 0; face < 6; face++) {
    const normalAxis = Math.floor(face / 2)
    const sign = face % 2 === 0 ? 1 : -1
    const uAxis = normalAxis === 0 ? 2 : 0
    const vAxis = normalAxis === 1 ? 2 : 1
    const addPanel = (panel: Panel, depth: number, material: CubePart['material'], lift = 0) => {
      const oriented = rotate(panel, FACE_TURNS[face])
      const position: CubePart['position'] = [0, 0, 0]
      const size: CubePart['size'] = [0, 0, 0]
      position[normalAxis] = sign * (FACE_START + lift + depth / 2)
      position[uAxis] = -1.44 + (oriented.x + oriented.width / 2) * MACRO_PITCH
      position[vAxis] = -1.44 + (oriented.y + oriented.height / 2) * MACRO_PITCH
      size[normalAxis] = depth
      size[uAxis] = oriented.width * MACRO_PITCH - GAP
      size[vAxis] = oriented.height * MACRO_PITCH - GAP
      parts.push({ position, size, material })
    }

    for (const [index, panel] of LANDMARKS.entries()) {
      const depth = 0.16 + ((index + face) % 3) * 0.025
      addPanel(panel, depth, 'porcelain')
      // A smaller elevated shelf makes the largest plate read as a terrace.
      if (index === (face % 2 === 0 ? 0 : 3)) {
        addPanel({ x: panel.x + 0.5, y: panel.y + 0.5, width: 1, height: 0.5 }, 0.045, 'porcelain', depth)
      }
    }

    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 6; x++) {
        if (LANDMARKS.some(panel => x >= panel.x && x < panel.x + panel.width && y >= panel.y && y < panel.y + panel.height)) continue
        const accent = x === 3 && y === 1
        const voxelBand = x === 2 || y === 2 || (x + y + face) % 4 === 0
        if (accent) {
          addPanel({ x, y, width: 1, height: 1 }, 0.115, 'teal')
        } else if (voxelBand) {
          for (let row = 0; row < 2; row++) {
            for (let column = 0; column < 2; column++) {
              const inset = x === 2 && y === 3 && row === 0 && column === 1
              const depth = inset ? 0.105 : 0.135 + ((x + y + row + column + face) % 4) * 0.035
              addPanel({ x: x + column / 2, y: y + row / 2, width: 0.5, height: 0.5 }, depth, inset ? 'teal' : 'porcelain')
            }
          }
        } else {
          addPanel({ x, y, width: 1, height: 1 }, 0.16 + ((x + y + face) % 3) * 0.025, 'porcelain')
        }
      }
    }
  }
  return parts
}

/** Shared immutable source for the instanced sculpture and its SVG still. */
export const CUBE_PARTS: readonly CubePart[] = Object.freeze(createParts().map(part => {
  Object.freeze(part.position)
  Object.freeze(part.size)
  return Object.freeze(part)
}))
