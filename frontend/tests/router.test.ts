import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL)
      if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
const { routeTransition, routeKeyForLocation, viewHref } = await import('../src/hooks/useHashRoute.ts')

test('native same-page anchors do not reset scrolling or trigger route navigation', () => {
  const home = { pathname: '/', search: '' }
  for (const hash of ['#auction-process', '#questions', '#main-content', '']) {
    assert.deepEqual(routeTransition(home, { ...home, hash }), { update: false, scrollToTop: false })
  }
})

test('legacy hash routes are migrated and use page navigation scrolling', () => {
  const home = { pathname: '/', search: '' }
  for (const hash of ['#/markets', '#/market', '#/auction?round=2']) {
    assert.deepEqual(routeTransition(home, { ...home, hash }), { update: true, scrollToTop: true })
  }
})

test('Back and Forward between pages update the route and reset scroll', () => {
  assert.deepEqual(routeTransition({ pathname: '/markets', search: '' }, { pathname: '/', search: '', hash: '' }), { update: true, scrollToTop: true })
  assert.deepEqual(routeTransition({ pathname: '/', search: '' }, { pathname: '/auction', search: '?round=2', hash: '' }), { update: true, scrollToTop: true })
})

test('Back and Forward between exact auction queries update the route without moving the viewport', () => {
  assert.deepEqual(routeTransition({ pathname: '/auction', search: '?round=2' }, { pathname: '/auction', search: '?round=1', hash: '' }), { update: true, scrollToTop: false })
})

test('cross-page navigation with a native anchor preserves the browser anchor target', () => {
  assert.deepEqual(routeTransition({ pathname: '/markets', search: '' }, { pathname: '/', search: '', hash: '#auction-process' }), { update: true, scrollToTop: false })
})

test('public links use pathname routes', () => {
  assert.equal(viewHref('home'), '/')
  assert.equal(viewHref('markets'), '/markets')
  assert.equal(viewHref('auction'), '/auction')
})

test('route keys include exact round queries, ignore native anchors and preserve legacy deep-link parameters', () => {
  assert.equal(routeKeyForLocation({ pathname: '/auction', search: '?round=2', hash: '' }), '/auction?round=2')
  assert.equal(routeKeyForLocation({ pathname: '/', search: '', hash: '#auction-process' }), '/')
  assert.equal(routeKeyForLocation({ pathname: '/', search: '', hash: '#/auction?round=2' }), '/auction?round=2')
  assert.equal(routeKeyForLocation({ pathname: '/', search: '?round=1&source=share', hash: '#/auction?round=2' }), '/auction?round=2&source=share')
})
