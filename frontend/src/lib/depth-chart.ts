import type { LiveRound } from '../types'

export type DepthPoint = {
  priceRaw: bigint
  bidVolume: bigint
  askVolume: bigint
  bidDepth: bigint
  askDepth: bigint
}

export type DepthModel = {
  points: DepthPoint[]
  totalBid: bigint
  totalAsk: bigint
  maxDepth: bigint
  maxVolume: bigint
  priceDomain: [bigint, bigint]
  clearingPrice: bigint | null
  orderCount: number
}

/** Exact aggregation. Only plotRatio converts normalized coordinates to Number. */
export function buildDepthModel(round: LiveRound | null): DepthModel {
  const levels = new Map<string, { priceRaw: bigint; bidVolume: bigint; askVolume: bigint }>()
  let totalBid = 0n
  let totalAsk = 0n
  let orderCount = 0
  for (const bid of round?.bids ?? []) {
    if (bid.priceRaw <= 0n || bid.quantityRaw <= 0n) continue
    orderCount++
    const key = bid.priceRaw.toString()
    const level = levels.get(key) ?? { priceRaw: bid.priceRaw, bidVolume: 0n, askVolume: 0n }
    if (bid.isBuy) { level.bidVolume += bid.quantityRaw; totalBid += bid.quantityRaw }
    else { level.askVolume += bid.quantityRaw; totalAsk += bid.quantityRaw }
    levels.set(key, level)
  }
  const clearingPrice = round?.phase === 'closed' && round.clearingPriceRaw > 0n ? round.clearingPriceRaw : null
  if (clearingPrice !== null && levels.size && !levels.has(clearingPrice.toString())) {
    levels.set(clearingPrice.toString(), { priceRaw: clearingPrice, bidVolume: 0n, askVolume: 0n })
  }
  const sorted = [...levels.values()].sort((a, b) => a.priceRaw < b.priceRaw ? -1 : a.priceRaw > b.priceRaw ? 1 : 0)
  let remainingBid = totalBid
  let accumulatedAsk = 0n
  let maxVolume = 0n
  const points = sorted.map(level => {
    accumulatedAsk += level.askVolume
    const point = { ...level, bidDepth: remainingBid, askDepth: accumulatedAsk }
    remainingBid -= level.bidVolume
    if (level.bidVolume > maxVolume) maxVolume = level.bidVolume
    if (level.askVolume > maxVolume) maxVolume = level.askVolume
    return point
  })
  const minimum = points[0]?.priceRaw ?? 0n
  const maximum = points.at(-1)?.priceRaw ?? 0n
  const spread = maximum - minimum
  const desiredPadding = spread > 0n ? spread / 10n : maximum / 100n
  const padding = desiredPadding > 0n ? desiredPadding : 1n
  return {
    points, totalBid, totalAsk, maxDepth: totalBid > totalAsk ? totalBid : totalAsk,
    maxVolume, priceDomain: [minimum > padding ? minimum - padding : 0n, maximum + padding],
    clearingPrice, orderCount,
  }
}

export function plotRatio(value: bigint, minimum: bigint, maximum: bigint): number {
  if (maximum <= minimum) return .5
  if (value <= minimum) return 0
  if (value >= maximum) return 1
  return Number((value - minimum) * 1_000_000n / (maximum - minimum)) / 1_000_000
}

/** Readable ticks in base units, including sub-token values and enormous books. */
export function quantityTicks(maximum: bigint, intervals = 4): bigint[] {
  const count = Math.max(1, Math.floor(intervals))
  const target = maximum > 0n ? (maximum + BigInt(count) - 1n) / BigInt(count) : 1n
  const magnitude = 10n ** BigInt(target.toString().length - 1)
  const step = [1n, 2n, 5n, 10n].map(multiplier => multiplier * magnitude).find(value => value >= target) ?? magnitude * 10n
  return Array.from({ length: count + 1 }, (_, index) => BigInt(index) * step)
}

export function priceTicks(domain: [bigint, bigint], intervals = 4): bigint[] {
  const count = Math.max(1, Math.floor(intervals))
  return [...new Set(Array.from({ length: count + 1 }, (_, index) => domain[0] + (domain[1] - domain[0]) * BigInt(index) / BigInt(count)))]
}

export function nearestDepthPoint(points: DepthPoint[], ratio: number, domain: [bigint, bigint]): number {
  if (!points.length) return -1
  const normalized = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0))
  let nearest = 0
  let distance = Infinity
  for (let index = 0; index < points.length; index++) {
    const candidateDistance = Math.abs(plotRatio(points[index].priceRaw, ...domain) - normalized)
    if (candidateDistance < distance) { nearest = index; distance = candidateDistance }
  }
  return nearest
}
