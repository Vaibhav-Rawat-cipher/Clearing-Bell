import type { View } from '../types.ts'

export const homeOverview = 'Clearing Bell is a multi-issuer tokenized bond auction platform built for Hedera. Any authorized company can list their bonds, enforce their own KYC rules, and run their own auctions. Eligible wallets place public limit orders in a shared auction window, and matched trades settle at one clearing price.'

export const homeQuestions = [
  { question: 'What is Clearing Bell?', answer: 'Clearing Bell is a batch-auction application for tokenized bonds, built for Hedera. It connects a public order book, token eligibility checks, an investor portfolio, and issuer controls.' },
  { question: 'How is the clearing price found?', answer: 'Buyers and sellers submit public limit orders during an auction window. When the round closes, the contract matches eligible demand and supply at a single clearing price. Orders may be partially filled or receive no fill.' },
  { question: 'Who can trade?', answer: 'A wallet must be approved in the bond’s registered identity registry. Eligibility is checked when an order is submitted and again during settlement. Approval for one bond does not imply access to every bond.' },
  { question: 'How does settlement work?', answer: 'Clearing and token transfers execute together in one transaction. Orders do not escrow funds: participants must retain sufficient balances and approvals. If a required transfer fails, the transaction reverts without keeping partial transfers.' },
] as const

export const viewPaths: Record<View, string> = { home: '/', markets: '/markets', auction: '/auction', portfolio: '/portfolio', issuer: '/issuer' }

export const routeSeo: Record<View, { title: string; description: string; heading: string; indexable: boolean }> = {
  home: {
    title: 'Clearing Bell | Tokenized Bond Auctions for Hedera',
    description: 'Explore tokenized bond auctions built for Hedera. Review public limit orders, wallet eligibility, uniform clearing prices, and atomic token settlement.',
    heading: 'Tokenized bond auctions for Hedera', indexable: true,
  },
  markets: {
    title: 'Tokenized Bond Auction Markets | Clearing Bell',
    description: 'Browse Clearing Bell bond auction rounds, review public orders and bidding deadlines, and inspect completed clearing prices from the connected contracts.',
    heading: 'Tokenized bond auction markets', indexable: true,
  },
  auction: {
    title: 'Auction Workspace | Clearing Bell',
    description: 'Review the selected bond auction, inspect the public order book, approve tokens, and submit a limit order with an eligible wallet.',
    heading: 'Bond auction workspace', indexable: false,
  },
  portfolio: {
    title: 'Investor Portfolio | Clearing Bell',
    description: 'Connect your wallet to review token balances, open bond orders, allowances, and settlement records from the connected Clearing Bell contracts.',
    heading: 'Investor portfolio', indexable: false,
  },
  issuer: {
    title: 'Issuer Console | Clearing Bell',
    description: 'Review auction rounds and contract addresses. Authorized issuer wallets can open auction windows and pause or resume the Clearing Bell engine.',
    heading: 'Issuer console', indexable: false,
  },
}

export function resolveView(pathname: string, hash = ''): View | null {
  // Existing shared hash links retain priority until the router normalizes them.
  const legacy = hash.match(/^#\/(home|market|markets|auction|portfolio|issuer)(?:[/?].*)?$/)?.[1]
  if (legacy) return legacy === 'market' ? 'markets' : legacy as View
  const path = pathname.replace(/\/+$/, '') || '/'
  return (Object.keys(viewPaths) as View[]).find((view) => viewPaths[view] === path) || (path === '/index.html' ? 'home' : null)
}

export function publicSiteUrl(value: string | undefined, production: boolean): string | null {
  if (!production || !value?.trim()) return null
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('VITE_SITE_URL must be the HTTPS origin of your public website.') }
  const hostname = url.hostname.toLowerCase()
  const local = !hostname.includes('.') || /(?:^|\.)(?:localhost|local|test|invalid|example)$/.test(hostname) || /^[\d.]+$/.test(hostname) || hostname.includes(':')
  if (url.protocol !== 'https:' || local || url.username || url.password || url.port || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('VITE_SITE_URL must be a public HTTPS origin without a path, credentials, port, query, or fragment.')
  }
  return url.origin
}

export function metadataFor(view: View, siteUrl: string | null) {
  const route = routeSeo[view]
  const indexable = Boolean(siteUrl && route.indexable)
  return { ...route, indexable, canonical: indexable ? `${siteUrl}${viewPaths[view]}` : null, robots: indexable ? 'index, follow, max-image-preview:large' : 'noindex, nofollow' }
}

export function structuredDataFor(view: View, siteUrl: string | null): Record<string, unknown> | null {
  if (!siteUrl || !routeSeo[view].indexable) return null
  if (view === 'markets') return {
    '@context': 'https://schema.org', '@type': 'CollectionPage', '@id': `${siteUrl}/markets#page`,
    name: routeSeo.markets.heading, description: routeSeo.markets.description, url: `${siteUrl}/markets`,
    isPartOf: { '@id': `${siteUrl}/#website` },
  }
  return {
    '@context': 'https://schema.org', '@graph': [
      { '@type': 'WebSite', '@id': `${siteUrl}/#website`, name: 'Clearing Bell', url: `${siteUrl}/`, description: homeOverview },
      { '@type': 'WebApplication', '@id': `${siteUrl}/#application`, name: 'Clearing Bell', url: `${siteUrl}/`, applicationCategory: 'FinanceApplication', operatingSystem: 'Web browser', description: homeOverview },
    ],
  }
}
