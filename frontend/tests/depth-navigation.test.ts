import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { boundOrbit, dragOrbit, nudgeOrbit, orbitKey, presetOrbit, presentationOrbit } from '../src/lib/depth-navigation.ts'

describe('spatial market controls', () => {
  it('returns independent reset presets', () => {
    const start = presetOrbit('isometric')
    start.zoom = 4
    assert.equal(presetOrbit('isometric').zoom, 1)
    assert.deepEqual(presetOrbit('front'), { azimuth: 0, elevation: .34, zoom: 1 })
  })
  it('limits rotation, tilt and magnification to readable ranges', () => {
    assert.deepEqual(boundOrbit({ azimuth: 8, elevation: -5, zoom: 100 }), { azimuth: .9, elevation: .24, zoom: 1.2 })
    assert.deepEqual(boundOrbit({ azimuth: -8, elevation: 5, zoom: 0 }), { azimuth: -.9, elevation: .98, zoom: .85 })
  })
  it('normalizes drag distance to viewport size and preserves zoom', () => {
    const start = presetOrbit('front')
    assert.deepEqual(dragOrbit(start, 40, 20, 400, 200), dragOrbit(start, 80, 40, 800, 400))
    assert.equal(dragOrbit(start, 80, 40, 800, 400).zoom, 1)
    assert.ok(Object.values(dragOrbit(start, 20, 30, 0, 0)).every(Number.isFinite))
    assert.deepEqual(start, presetOrbit('front'))
  })
  it('provides every drag direction and zoom as a tap/keyboard action', () => {
    const start = presetOrbit('front')
    for (const action of ['left', 'right', 'up', 'down', 'in', 'out'] as const) assert.notDeepEqual(nudgeOrbit(start, action), start)
    assert.equal(orbitKey('ArrowLeft'), 'left')
    assert.equal(orbitKey('ArrowRight'), 'right')
    assert.equal(orbitKey('ArrowUp'), 'up')
    assert.equal(orbitKey('ArrowDown'), 'down')
    assert.equal(orbitKey('+'), 'in')
    assert.equal(orbitKey('='), 'in')
    assert.equal(orbitKey('-'), 'out')
    assert.equal(orbitKey('Home'), 'reset')
    assert.equal(orbitKey('Tab'), null)
    assert.equal(orbitKey('Escape'), null)
  })
  it('starts presentation motion at the chosen view and stays bounded', () => {
    const start = presetOrbit('isometric')
    assert.deepEqual(presentationOrbit(start, 0), start)
    for (let time = 0; time < 300; time++) {
      const orbit = presentationOrbit(start, time)
      assert.equal(orbit.zoom, start.zoom)
      assert.ok(orbit.azimuth <= .9 && orbit.azimuth >= -.9)
      assert.ok(orbit.elevation <= .98 && orbit.elevation >= .24)
    }
  })
})
