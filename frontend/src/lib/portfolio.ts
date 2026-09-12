import type { LiveBid, LiveRound, TokenHolding } from '../types'

export type PortfolioOrder = { round: LiveRound; bid: LiveBid }

/** Preserve round/order order and references; closed rounds belong to history. */
export function portfolioOrders(rounds: readonly LiveRound[], account: string | null | undefined): PortfolioOrder[] {
  if (!account) return []
  const wallet = account.toLowerCase()
  return rounds.flatMap(round => round.phase === 'open' || round.phase === 'clearing'
    ? round.bids.filter(bid => bid.bidder.toLowerCase() === wallet).map(bid => ({ round, bid }))
    : [])
}

/** Pick a single asset by address, never sum tokens that share a symbol. */
export function preferredHolding(tokens: readonly TokenHolding[], kind: TokenHolding['kind'], preferredAddress?: string | null): TokenHolding | null {
  const candidates = tokens.filter(token => token.kind === kind)
  const preferred = preferredAddress?.toLowerCase()
  return candidates.find(token => preferred && token.address.toLowerCase() === preferred)
    ?? candidates.find(token => token.balanceRaw > 0n)
    ?? candidates[0]
    ?? null
}

/**
 * Exact decimal display with grouping and half-away-from-zero rounding.
 * Rounded values carry ≈; nonzero sub-unit values use an inequality instead of 0.
 * Keep the original decimal string in the UI's title or exact-value disclosure.
 */
export function portfolioAmount(value: string, maxFraction = 4): string {
  if (!Number.isInteger(maxFraction) || maxFraction < 0 || maxFraction > 100) return '—'
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim())
  if (!match) return '—'

  const negative = match[1] === '-'
  const whole = BigInt(match[2])
  const fraction = match[3] ?? ''
  const kept = fraction.slice(0, maxFraction).padEnd(maxFraction, '0')
  const discarded = fraction.slice(maxFraction)
  const rounded = /[1-9]/.test(discarded)
  let scaled = whole * 10n ** BigInt(maxFraction) + BigInt(kept || '0')

  if (scaled === 0n && !/[1-9]/.test(fraction)) return '0'
  if (scaled === 0n) {
    const smallest = maxFraction ? `0.${'0'.repeat(maxFraction - 1)}1` : '1'
    return negative ? `>-${smallest}` : `<${smallest}`
  }
  if (discarded && discarded[0] >= '5') scaled += 1n

  const digits = scaled.toString().padStart(maxFraction + 1, '0')
  const integer = (maxFraction ? digits.slice(0, -maxFraction) : digits).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const decimal = maxFraction ? digits.slice(-maxFraction).replace(/0+$/, '') : ''
  return `${rounded ? '≈ ' : ''}${negative ? '-' : ''}${integer}${decimal ? `.${decimal}` : ''}`
}
