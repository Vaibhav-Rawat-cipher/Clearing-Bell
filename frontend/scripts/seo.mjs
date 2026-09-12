import { loadEnv } from 'vite'
import { homeOverview, homeQuestions, metadataFor, publicSiteUrl, resolveView, routeSeo, structuredDataFor, viewPaths } from '../src/content/seo.ts'

const escapeHtml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
const safeJson = (value) => JSON.stringify(value).replaceAll('<', '\\u003c')

export function renderSeoHead(view, siteUrl) {
  const meta = metadataFor(view, siteUrl)
  const data = structuredDataFor(view, siteUrl)
  const tags = [
    `<title>${escapeHtml(meta.title)}</title>`,
    `<meta id="seo-description" name="description" content="${escapeHtml(meta.description)}" />`,
    `<meta id="seo-robots" name="robots" content="${meta.robots}" />`,
    `<meta id="seo-og-title" property="og:title" content="${escapeHtml(meta.title)}" />`,
    `<meta id="seo-og-description" property="og:description" content="${escapeHtml(meta.description)}" />`,
    '<meta id="seo-og-type" property="og:type" content="website" />',
    '<meta id="seo-og-site-name" property="og:site_name" content="Clearing Bell" />',
    '<meta id="seo-twitter-card" name="twitter:card" content="summary" />',
    `<meta id="seo-twitter-title" name="twitter:title" content="${escapeHtml(meta.title)}" />`,
    `<meta id="seo-twitter-description" name="twitter:description" content="${escapeHtml(meta.description)}" />`,
  ]
  if (meta.canonical) tags.push(`<link id="seo-canonical" rel="canonical" href="${escapeHtml(meta.canonical)}" />`, `<meta id="seo-og-url" property="og:url" content="${escapeHtml(meta.canonical)}" />`)
  if (data) tags.push(`<script id="seo-structured-data" type="application/ld+json">${safeJson(data)}</script>`)
  return tags.join('\n    ')
}

export function renderInitialContent(view) {
  const nav = '<nav aria-label="Main navigation"><a href="/">Clearing Bell</a><a href="/markets">Markets</a><a href="/auction">Auction</a><a href="/portfolio">Portfolio</a><a href="/issuer">Issuer console</a></nav>'
  let body
  if (view === 'home') {
    body = `<h1>${routeSeo.home.heading}</h1><p>${escapeHtml(homeOverview)}</p><p><a href="/markets">Explore bond auction markets</a></p><section aria-labelledby="initial-questions"><h2 id="initial-questions">How Clearing Bell works</h2>${homeQuestions.map(({ question, answer }) => `<section><h3>${escapeHtml(question)}</h3><p>${escapeHtml(answer)}</p></section>`).join('')}</section>`
  } else if (view === 'markets') {
    body = `<h1>${routeSeo.markets.heading}</h1><p>${escapeHtml(routeSeo.markets.description)}</p><h2>Review an auction before placing an order</h2><p>Each round identifies its bond and settlement token, order deadline, public bids, and closing result. Live round values load from the configured auction engine. A closed round may have matching trades or close without a trade.</p><h2>Trading requirements</h2><p>Connect a wallet approved in the selected bond’s identity registry. Token approval authorizes settlement; it does not escrow your balance. Keep sufficient tokens and approval available for your outstanding orders.</p><p><a href="/auction">Open the auction workspace</a> or <a href="/">read how Clearing Bell works</a>.</p>`
  } else {
    body = `<h1>${routeSeo[view].heading}</h1><p>${escapeHtml(routeSeo[view].description)}</p><p>Enable JavaScript and connect the appropriate wallet to use this workspace. Wallet balances and transaction details are not embedded in this page.</p><p><a href="/markets">Browse bond auction markets</a></p>`
  }
  return `<div id="initial-overview">${nav}<main>${body}</main><footer><p>Clearing Bell is an independent project built for Hedera. Network and contract availability depend on the configured deployment.</p><a href="https://github.com/Vaibhav-Rawat-cipher/Clearing-Bell">View the project source</a></footer></div>`
}

export function renderRouteHtml(html, view, siteUrl) {
  return html.replace(/<!--seo:head:start-->[\s\S]*?<!--seo:head:end-->/, `<!--seo:head:start-->\n    ${renderSeoHead(view, siteUrl)}\n    <!--seo:head:end-->`)
    .replace(/<!--seo:content:start-->[\s\S]*?<!--seo:content:end-->/, `<!--seo:content:start-->${renderInitialContent(view)}<!--seo:content:end-->`)
}

export function renderRobots(siteUrl) {
  // Private workspaces are crawlable so their initial HTML noindex can be read.
  return siteUrl ? `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n` : '# Pages remain noindex until a public production origin is configured.\nUser-agent: *\nAllow: /\n'
}

export function renderSitemap(siteUrl) {
  if (!siteUrl) return null
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Object.entries(viewPaths).filter(([view]) => routeSeo[view].indexable).map(([, path]) => `<url><loc>${escapeHtml(siteUrl + path)}</loc></url>`).join('')}</urlset>\n`
}

export function seoPlugin() {
  let siteUrl = null
  return {
    name: 'clearing-bell-static-seo', enforce: 'post',
    configResolved(config) {
      const env = loadEnv(config.mode, config.envDir, 'VITE_')
      siteUrl = publicSiteUrl(env.VITE_SITE_URL, config.command === 'build' && config.mode === 'production')
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        const requestedPath = (context.originalUrl || context.path || '/').split('?')[0]
        const view = resolveView(requestedPath) || 'home'
        return renderRouteHtml(html, view, siteUrl)
      },
    },
    generateBundle(_options, bundle) {
      const index = bundle['index.html']
      if (!index || index.type !== 'asset') throw new Error('SEO output requires the Vite index.html entry.')
      const template = String(index.source)
      for (const view of Object.keys(viewPaths).filter((view) => view !== 'home')) {
        this.emitFile({ type: 'asset', fileName: `${view}/index.html`, source: renderRouteHtml(template, view, siteUrl) })
      }
      const notFound = renderRouteHtml(template, 'home', null)
        .replace('<title>Clearing Bell | Tokenized Bond Auctions for Hedera</title>', '<title>Page Not Found | Clearing Bell</title>')
        .replace(/<!--seo:content:start-->[\s\S]*?<!--seo:content:end-->/, '<!--seo:content:start--><main id="initial-overview"><h1>Page not found</h1><p><a href="/">Return to Clearing Bell</a></p></main><!--seo:content:end-->')
      this.emitFile({ type: 'asset', fileName: '404.html', source: notFound })
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: renderRobots(siteUrl) })
      const sitemap = renderSitemap(siteUrl)
      if (sitemap) this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: sitemap })
    },
  }
}
