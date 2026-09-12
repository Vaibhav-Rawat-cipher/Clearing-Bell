import { formatUnits, parseUnits } from 'viem'
import type { Address, DemoOrder, LiveRound } from '../types'

export function sameAddress(a: string | null | undefined, b: string | null | undefined) {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase())
}

export function parsePositiveAmount(value: string, decimals: number, label: string): bigint {
  const trimmed = value.trim()
  if (!/^(?:\d+)(?:\.\d+)?$/.test(trimmed)) throw new Error(`${label} must be a positive decimal number.`)
  const fractional = trimmed.split('.')[1] || ''
  if (fractional.length > decimals) throw new Error(`${label} supports at most ${decimals} decimal places.`)
  const result = parseUnits(trimmed, decimals)
  if (result <= 0n) throw new Error(`${label} must be greater than zero.`)
  if (result >= 2n ** 256n) throw new Error(`${label} is too large.`)
  return result
}

export function parseOrder(order: DemoOrder, round: LiveRound) {
  if (round.bond.decimals !== 18) throw new Error('This engine requires an 18-decimal bond token. The selected token is not supported.')
  const price = parsePositiveAmount(order.price, round.settlement.decimals, 'Limit price')
  const quantity = parsePositiveAmount(order.quantity, 18, 'Quantity')
  if (price * quantity >= 2n ** 256n) throw new Error('The order value exceeds the contract arithmetic limit.')
  const cost = (price * quantity + 10n ** 18n - 1n) / 10n ** 18n
  if (cost <= 0n) throw new Error('The order value is below one settlement-token base unit. Increase the price or quantity.')
  return { price, quantity, cost, isBuy: order.side === 'BUY' }
}

// Balances are not escrowed by submitBid. Include this wallet's other still-open
// orders when suggesting approval, so the next order does not reduce their cover.
export function requiredOrderFunds(order: DemoOrder, round: LiveRound, rounds: LiveRound[], account: Address) {
  const parsed = parseOrder(order, round)
  const token = parsed.isBuy ? round.settlement : round.bond
  let required = parsed.isBuy ? parsed.cost : parsed.quantity
  for (const other of rounds) {
    if (other.phase !== 'open') continue
    for (const bid of other.bids) {
      if (!sameAddress(bid.bidder, account)) continue
      if (bid.isBuy && sameAddress(other.settlementToken, token.address)) required += (bid.priceRaw * bid.quantityRaw + 10n ** 18n - 1n) / 10n ** 18n
      if (!bid.isBuy && sameAddress(other.bondToken, token.address)) required += bid.quantityRaw
    }
  }
  return { ...parsed, token, required, requiredFormatted: formatUnits(required, token.decimals) }
}
