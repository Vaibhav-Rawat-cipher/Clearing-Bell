import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { homeQuestions, metadataFor, publicSiteUrl, resolveView, routeSeo, structuredDataFor, viewPaths } from '../src/content/seo.ts'
import { renderInitialContent, renderRobots, renderRouteHtml, renderSeoHead, renderSitemap } from '../scripts/seo.mjs'

const publishedOrigin = 'https://clearingbell.org'

test('pathnames and old shared hash URLs resolve to the same product views', () => {
  for (const [view, path] of Object.entries(viewPaths)) {
    assert.equal(resolveView(path), view)
    assert.equal(resolveView(path + (path === '/' ? '' : '/')), view)
    assert.equal(resolveView('/', `#/${view}`), view)
  }
  assert.equal(resolveView('/', '#/market'), 'markets')
  assert.equal(resolveView('/', '#/auction?round=2'), 'auction')
  assert.equal(resolveView('/markets', '#auction-process'), 'markets')
  assert.equal(resolveView('/unknown'), null)
})

test('only an explicitly configured public production origin enables indexing', () => {
  assert.equal(publicSiteUrl(undefined, true), null)
  assert.equal(publicSiteUrl(publishedOrigin, false), null)
  assert.equal(publicSiteUrl(publishedOrigin + '/', true), publishedOrigin)
  for (const value of ['http://clearingbell.org', 'https://localhost', 'https://127.0.0.1', 'https://demo.test', 'https://clearing.example', 'https://clearingbell.org/staging', 'https://user:secret@clearingbell.org', 'https://clearingbell.org?x=1']) {
    assert.throws(() => publicSiteUrl(value, true), /VITE_SITE_URL/)
  }
})

test('every local route is noindex and has no placeholder canonical or schema', () => {
  for (const view of Object.keys(viewPaths) as (keyof typeof viewPaths)[]) {
    assert.equal(metadataFor(view, null).robots, 'noindex, nofollow')
    assert.equal(metadataFor(view, null).canonical, null)
    assert.equal(structuredDataFor(view, null), null)
    assert.doesNotMatch(renderSeoHead(view, null), /rel="canonical"|application\/ld\+json/)
  }
  assert.equal(renderSitemap(null), null)
  assert.match(renderRobots(null), /Allow: \/\n/)
  assert.doesNotMatch(renderRobots(null), /Sitemap:/)
})

test('published informational pages receive unique metadata while workspaces stay noindex', () => {
  assert.equal(new Set(Object.values(routeSeo).map((route) => route.title)).size, 5)
  assert.equal(new Set(Object.values(routeSeo).map((route) => route.description)).size, 5)
  assert.equal(metadataFor('home', publishedOrigin).canonical, publishedOrigin + '/')
  assert.equal(metadataFor('markets', publishedOrigin).canonical, publishedOrigin + '/markets')
  for (const view of ['auction', 'portfolio', 'issuer'] as const) {
    assert.equal(metadataFor(view, publishedOrigin).robots, 'noindex, nofollow')
    assert.equal(metadataFor(view, publishedOrigin).canonical, null)
    assert.equal(structuredDataFor(view, publishedOrigin), null)
  }
  const sitemap = renderSitemap(publishedOrigin)!
  assert.equal((sitemap.match(/<url>/g) || []).length, 2)
  assert.doesNotMatch(sitemap, /auction|portfolio|issuer/)
  assert.match(renderRobots(publishedOrigin), /Sitemap: https:\/\/clearingbell.org\/sitemap.xml/)
})

test('initial HTML contains the same factual answers and crawlable links before JavaScript', () => {
  const content = renderInitialContent('home')
  assert.equal((content.match(/<h1>/g) || []).length, 1)
  for (const question of homeQuestions) assert.ok(content.includes(question.question))
  assert.match(content, /public limit orders/)
  assert.match(content, /do not escrow funds/)
  assert.match(content, /href="\/markets"/)
  assert.match(content, /href="\/auction"/)
  assert.doesNotMatch(content, /guaranteed return|official Hedera|Hedera-endorsed|sealed bids/i)
})

test('static route exports replace homepage metadata and content rather than duplicating tags', () => {
  const template = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const marketHtml = renderRouteHtml(template, 'markets', publishedOrigin)
  const issuerHtml = renderRouteHtml(marketHtml, 'issuer', publishedOrigin)
  assert.equal((marketHtml.match(/<title>/g) || []).length, 1)
  assert.equal((marketHtml.match(/name="description"/g) || []).length, 1)
  assert.equal((marketHtml.match(/rel="canonical"/g) || []).length, 1)
  assert.ok(marketHtml.includes(routeSeo.markets.title))
  assert.ok(marketHtml.includes('Live round values load from the configured auction engine.'))
  assert.ok(issuerHtml.includes(routeSeo.issuer.title))
  assert.match(issuerHtml, /name="robots" content="noindex, nofollow"/)
  assert.doesNotMatch(issuerHtml, /rel="canonical"|application\/ld\+json/)
})

test('structured data describes the application without invented offers, ratings or endorsements', () => {
  const schema = JSON.stringify(structuredDataFor('home', publishedOrigin))
  assert.match(schema, /WebSite/)
  assert.match(schema, /WebApplication/)
  assert.doesNotMatch(schema, /aggregateRating|reviewCount|offers|sponsor|award|FAQPage|certification/)
})
