import type { SVGProps } from 'react'
import { CUBE_PARTS } from '../../lib/modular-cube'
import type { CubePart } from '../../lib/modular-cube'

type Point3 = [number, number, number]
type Point2 = [number, number]
type VisibleFace = { vertices: Point3[]; material: CubePart['material']; axis: 0 | 1 | 2 }
const CAMERA: Point3 = [6, 4.5, 6]
const horizontal = Math.SQRT1_2
const elevation = Math.atan2(CAMERA[1], Math.hypot(CAMERA[0], CAMERA[2]))
const sin = Math.sin(elevation)
const cos = Math.cos(elevation)
const SHADES = {
  porcelain: ['#bdcbd3', '#f2f6f8', '#e5edf1'],
  teal: ['#279684', '#80dfc6', '#48c8ad'],
  dark: ['#14212a', '#263942', '#1b2c35'],
} as const

function project([x, y, z]: Point3): Point2 {
  return [(x - z) * horizontal, (x + z) * horizontal * sin - y * cos]
}

function visibleFaces(part: CubePart): VisibleFace[] {
  const low = part.position.map((coordinate, index) => coordinate - part.size[index] / 2)
  const high = part.position.map((coordinate, index) => coordinate + part.size[index] / 2)
  const vertices: Point3[][] = [
    [[high[0], low[1], low[2]], [high[0], high[1], low[2]], [high[0], high[1], high[2]], [high[0], low[1], high[2]]],
    [[low[0], high[1], low[2]], [high[0], high[1], low[2]], [high[0], high[1], high[2]], [low[0], high[1], high[2]]],
    [[low[0], low[1], high[2]], [high[0], low[1], high[2]], [high[0], high[1], high[2]], [low[0], high[1], high[2]]],
  ]
  return vertices.map((face, axis) => ({
    vertices: face,
    material: part.material,
    axis: axis as 0 | 1 | 2,
  }))
}

/** Order overlapping cuboids, not face centroids: a large recessed core must
 * remain behind every foreground panel, including panels near its far edge. */
function painterOrder(parts: readonly CubePart[]): CubePart[] {
  const normals: Point2[] = [[-horizontal * sin, horizontal], [cos, 0], [-horizontal * sin, -horizontal]]
  const boxes = parts.map(part => {
    const projected = visibleFaces(part).flatMap(face => face.vertices.map(project))
    return {
      low: part.position.map((coordinate, axis) => coordinate - part.size[axis] / 2),
      high: part.position.map((coordinate, axis) => coordinate + part.size[axis] / 2),
      intervals: normals.map(normal => {
        const coordinates = projected.map(point => point[0] * normal[0] + point[1] * normal[1])
        return [Math.min(...coordinates), Math.max(...coordinates)]
      }),
      depth: part.position.reduce((total, coordinate, axis) => total + coordinate * CAMERA[axis], 0),
    }
  })
  const outgoing = parts.map(() => [] as number[])
  const incoming = parts.map(() => 0)
  for (let a = 0; a < boxes.length; a++) {
    for (let b = a + 1; b < boxes.length; b++) {
      const first = boxes[a]
      const second = boxes[b]
      // The three projected edge normals form the separating axes of a box.
      if (first.intervals.some(([low, high], axis) => high <= second.intervals[axis][0] || low >= second.intervals[axis][1])) continue
      let order = 0
      for (let axis = 0; axis < 3; axis++) {
        const next = first.high[axis] <= second.low[axis] + 1e-8 ? 1 : second.high[axis] <= first.low[axis] + 1e-8 ? -1 : 0
        if (next && order && next !== order) { order = 0; break }
        if (next) order = next
      }
      if (!order) continue
      const back = order === 1 ? a : b
      const front = order === 1 ? b : a
      outgoing[back].push(front)
      incoming[front]++
    }
  }
  const remaining = new Set(parts.map((_, index) => index))
  const ordered: CubePart[] = []
  while (remaining.size) {
    const ready = [...remaining].filter(index => incoming[index] === 0)
    // Stable fallback keeps the poster renderable if future geometry introduces
    // a cyclic overlap that would need polygon splitting.
    const candidates = ready.length ? ready : [...remaining]
    const next = candidates.reduce((closest, index) => boxes[index].depth < boxes[closest].depth ? index : closest)
    remaining.delete(next)
    ordered.push(parts[next])
    outgoing[next].forEach(index => { incoming[index]-- })
  }
  return ordered
}

const faces = painterOrder(CUBE_PARTS).flatMap(visibleFaces)
const points = faces.flatMap(face => face.vertices.map(project))
const minX = Math.min(...points.map(point => point[0]))
const maxX = Math.max(...points.map(point => point[0]))
const minY = Math.min(...points.map(point => point[1]))
const maxY = Math.max(...points.map(point => point[1]))
// Match the live orthographic camera's 5.3-world-unit short axis.
const scale = 500 / 5.3
const centerX = (minX + maxX) / 2
const centerY = (minY + maxY) / 2
const polygons = faces.map(face => ({
  fill: SHADES[face.material][face.axis],
  points: face.vertices.map(point => {
    const [x, y] = project(point)
    return `${(250 + (x - centerX) * scale).toFixed(2)},${(250 + (y - centerY) * scale).toFixed(2)}`
  }).join(' '),
}))

/** The same original geometry as the live sculpture, without a 3D runtime. */
export default function CubePoster(props: SVGProps<SVGSVGElement>) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Original porcelain modular cube with teal inserts" focusable="false" {...props}>
    <ellipse cx="250" cy="462" rx="163" ry="20" fill="#000000" opacity="0.22" />
    <g strokeLinejoin="round" strokeWidth="0.22" stroke="#526875" strokeOpacity="0.23">
      {polygons.map((polygon, index) => <polygon key={index} points={polygon.points} fill={polygon.fill} />)}
    </g>
  </svg>
}
