import { useEffect } from 'react'
import { metadataFor, publicSiteUrl, resolveView, structuredDataFor } from '../content/seo'
import type { View } from '../types'

function setMeta(id: string, key: 'name' | 'property', name: string, content: string) {
  let tag = document.getElementById(id) as HTMLMetaElement | null
  if (!tag) { tag = document.createElement('meta'); tag.id = id; document.head.append(tag) }
  tag.setAttribute(key, name)
  tag.content = content
}

export function Seo({ view }: { view: View }) {
  useEffect(() => {
    const siteUrl = publicSiteUrl(import.meta.env.VITE_SITE_URL, import.meta.env.PROD && import.meta.env.MODE === 'production')
    const knownRoute = resolveView(window.location.pathname, window.location.hash)
    const meta = metadataFor(view, knownRoute ? siteUrl : null)
    const title = knownRoute ? meta.title : 'Page Not Found | Clearing Bell'
    document.title = title
    setMeta('seo-description', 'name', 'description', meta.description)
    setMeta('seo-robots', 'name', 'robots', meta.robots)
    setMeta('seo-og-title', 'property', 'og:title', title)
    setMeta('seo-og-description', 'property', 'og:description', meta.description)
    setMeta('seo-og-type', 'property', 'og:type', 'website')
    setMeta('seo-og-site-name', 'property', 'og:site_name', 'Clearing Bell')
    setMeta('seo-twitter-card', 'name', 'twitter:card', 'summary')
    setMeta('seo-twitter-title', 'name', 'twitter:title', title)
    setMeta('seo-twitter-description', 'name', 'twitter:description', meta.description)
    if (meta.canonical) {
      let canonical = document.getElementById('seo-canonical') as HTMLLinkElement | null
      if (!canonical) { canonical = document.createElement('link'); canonical.id = 'seo-canonical'; canonical.rel = 'canonical'; document.head.append(canonical) }
      canonical.href = meta.canonical
      setMeta('seo-og-url', 'property', 'og:url', meta.canonical)
    } else {
      document.getElementById('seo-canonical')?.remove()
      document.getElementById('seo-og-url')?.remove()
    }
    const data = knownRoute ? structuredDataFor(view, siteUrl) : null
    if (data) {
      let script = document.getElementById('seo-structured-data') as HTMLScriptElement | null
      if (!script) { script = document.createElement('script'); script.id = 'seo-structured-data'; script.type = 'application/ld+json'; document.head.append(script) }
      script.textContent = JSON.stringify(data)
    } else document.getElementById('seo-structured-data')?.remove()
  }, [view])
  return null
}
