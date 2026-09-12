import { useEffect, useRef, useState } from 'react'
import { resolveView, viewPaths } from '../content/seo'
import type { View } from '../types'

function readView(): View {
  return resolveView(window.location.pathname, window.location.hash) || 'home'
}

export function viewHref(view: View): string {
  return viewPaths[view]
}

const legacyRoutePattern = /^#\/(home|market|markets|auction|portfolio|issuer)(?:[/?].*)?$/

export function routeTransition(previous: { pathname: string; search: string }, next: { pathname: string; search: string; hash: string }) {
  const legacy = legacyRoutePattern.test(next.hash)
  const pageChanged = previous.pathname !== next.pathname
  const queryChanged = previous.search !== next.search
  return {
    update: legacy || pageChanged || queryChanged,
    // Native anchors, including browser Back/Forward between anchors, retain
    // their own scroll behavior. Query-only auction changes also keep position.
    scrollToTop: legacy || (pageChanged && !next.hash),
  }
}

export function routeKeyForLocation(location: { pathname: string; search: string; hash: string }): string {
  if (!legacyRoutePattern.test(location.hash)) return `${location.pathname}${location.search}`
  const view = resolveView(location.pathname, location.hash) || 'home'
  const params = new URLSearchParams(location.search)
  const hashQuery = location.hash.split('?')[1]
  if (hashQuery) for (const [key, value] of new URLSearchParams(hashQuery)) params.set(key, value)
  const query = params.toString()
  return `${viewHref(view)}${query ? `?${query}` : ''}`
}

function normalizeLegacyRoute() {
  if (!legacyRoutePattern.test(window.location.hash)) return
  window.history.replaceState({ view: readView() }, '', routeKeyForLocation(window.location))
}

export function useHashRoute() {
  const [route, setRoute] = useState(() => ({ view: readView(), key: routeKeyForLocation(window.location) }))
  const previousLocation = useRef({ pathname: window.location.pathname, search: window.location.search })
  const { view } = route

  useEffect(() => {
    normalizeLegacyRoute()
    previousLocation.current = { pathname: window.location.pathname, search: window.location.search }
    const sync = () => {
      const transition = routeTransition(previousLocation.current, window.location)
      if (!transition.update) return
      normalizeLegacyRoute()
      previousLocation.current = { pathname: window.location.pathname, search: window.location.search }
      setRoute({ view: readView(), key: routeKeyForLocation(window.location) })
      if (transition.scrollToTop) window.scrollTo({ top: 0, behavior: 'auto' })
    }
    window.addEventListener('popstate', sync)
    window.addEventListener('hashchange', sync)
    return () => {
      window.removeEventListener('popstate', sync)
      window.removeEventListener('hashchange', sync)
    }
  }, [])

  const navigate = (next: View) => {
    const href = viewHref(next)
    if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== href) window.history.pushState({ view: next }, '', href)
    previousLocation.current = { pathname: window.location.pathname, search: window.location.search }
    setRoute({ view: next, key: href })
    window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }

  return { view, navigate, routeKey: route.key }
}
