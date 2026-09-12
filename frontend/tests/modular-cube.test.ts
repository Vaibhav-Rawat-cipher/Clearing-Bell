import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CUBE_PARTS } from '../src/lib/modular-cube.ts'

describe('original modular cube model', () => {
  it('contains a bounded, dense but instancing-friendly number of finite cuboids', () => {
    assert.ok(CUBE_PARTS.length >= 250 && CUBE_PARTS.length <= 600, `${CUBE_PARTS.length} parts`)
    for (const part of CUBE_PARTS) {
      for (let axis = 0; axis < 3; axis++) {
        assert.ok(Number.isFinite(part.position[axis]))
        assert.ok(Number.isFinite(part.size[axis]) && part.size[axis] > 0)
        assert.ok(Math.abs(part.position[axis]) + part.size[axis] / 2 <= 1.72 + 1e-10)
      }
    }
  })

  it('keeps every face detailed and includes sparse teal inserts on all six sides', () => {
    for (let axis = 0; axis < 3; axis++) {
      for (const sign of [-1, 1]) {
        const face = CUBE_PARTS.filter(part => part.position[axis] * sign > 1.45)
        assert.ok(face.length >= 35)
        assert.ok(face.some(part => part.material === 'teal'))
        assert.ok(face.some(part => part.material === 'porcelain'))
      }
    }
    assert.equal(CUBE_PARTS.filter(part => part.material === 'dark').length, 1)
    assert.ok(CUBE_PARTS.filter(part => part.material === 'teal').length < CUBE_PARTS.length / 12)
  })

  it('uses both large readable patches and small stepped voxels', () => {
    assert.ok(CUBE_PARTS.some(part => part.material === 'porcelain' && part.size.filter(size => size > 0.9).length === 2))
    assert.ok(CUBE_PARTS.some(part => part.material === 'porcelain' && part.size.every(size => size < 0.25)))
    const heights = new Set(CUBE_PARTS.slice(1).map(part => Math.min(...part.size)))
    assert.ok(heights.size >= 5)
  })

  it('has no duplicate cuboids or intersecting solid volumes', () => {
    assert.equal(new Set(CUBE_PARTS.map(part => JSON.stringify(part))).size, CUBE_PARTS.length)
    for (let first = 0; first < CUBE_PARTS.length; first++) {
      for (let second = first + 1; second < CUBE_PARTS.length; second++) {
        const a = CUBE_PARTS[first]
        const b = CUBE_PARTS[second]
        const overlaps = a.position.every((coordinate, axis) => Math.abs(coordinate - b.position[axis]) < (a.size[axis] + b.size[axis]) / 2 - 1e-10)
        assert.equal(overlaps, false, `Parts ${first} and ${second} intersect`)
      }
    }
  })

  it('is deeply frozen so poster and runtime cannot diverge through mutation', () => {
    assert.ok(Object.isFrozen(CUBE_PARTS))
    for (const part of CUBE_PARTS) {
      assert.ok(Object.isFrozen(part))
      assert.ok(Object.isFrozen(part.position))
      assert.ok(Object.isFrozen(part.size))
    }
  })
})
