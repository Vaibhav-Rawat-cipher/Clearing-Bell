import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { portfolioAmount, portfolioOrders, preferredHolding } from '../src/lib/portfolio.ts'
import type { Address, LiveBid, LiveRound, TokenHolding } from '../src/types.ts'

const wallet: Address = '0x00000000000000000000000000000000000000aa'
const otherWallet: Address = '0x00000000000000000000000000000000000000bb'
const bondAddress: Address = '0x0000000000000000000000000000000000000011'
const cashAddress: Address = '0x00000000000000000000000000000000000000cc'
const otherCashAddress: Address = '0x00000000000000000000000000000000000000dd'

function holding(overrides: Partial<TokenHolding> = {}): TokenHolding {
  return { address: cashAddress, name: 'Payment token', symbol: 'USD', decimals: 6, balance: '10', balanceRaw: 10_000_000n, allowance: '0', allowanceRaw: 0n, kind: 'settlement', ...overrides }
}

function bid(overrides: Partial<LiveBid> = {}): LiveBid {
  return { bidder: wallet, price: '100', quantity: '2', isBuy: true, index: '0', priceRaw: 100_000_000n, quantityRaw: 2n * 10n ** 18n, ...overrides }
}

function round(overrides: Partial<LiveRound> = {}): LiveRound {
  return {
    id: '1', bondToken: bondAddress, settlementToken: cashAddress,
    bond: { address: bondAddress, name: 'Bond', symbol: 'BOND', decimals: 18 },
    settlement: { address: cashAddress, name: 'Payment token', symbol: 'USD', decimals: 6 },
    deadline: 1_900_000_000, phase: 'open', clearingPrice: '0', clearedQuantity: '0',
    clearingPriceRaw: 0n, clearedQuantityRaw: 0n, bidCount: overrides.bids?.length ?? 0, bids: [], ...overrides,
  }
}

describe('portfolioOrders', () => {
  it('returns only this wallet’s open and clearing orders, including both sides', () => {
    const buy = bid()
    const sell = bid({ isBuy: false, index: '1' })
    const open = round({ bids: [buy, bid({ bidder: otherWallet }), sell] })
    const clearingBid = bid({ bidder: '0x00000000000000000000000000000000000000AA' })
    const clearing = round({ id: '2', phase: 'clearing', bids: [clearingBid] })
    const closed = round({ id: '3', phase: 'closed', bids: [bid()] })
    assert.deepEqual(portfolioOrders([open, closed, clearing], wallet), [
      { round: open, bid: buy }, { round: open, bid: sell }, { round: clearing, bid: clearingBid },
    ])
  })

  it('matches a differently cased connected account without changing source data', () => {
    const order = Object.freeze(bid())
    const source = round({ bids: [order] })
    const result = portfolioOrders(Object.freeze([source]), wallet.toUpperCase())
    assert.equal(result[0].round, source)
    assert.equal(result[0].bid, order)
    assert.equal(source.bids.length, 1)
  })

  it('returns no orders for a disconnected or unrelated wallet', () => {
    const rounds = [round({ bids: [bid()] })]
    assert.deepEqual(portfolioOrders(rounds, null), [])
    assert.deepEqual(portfolioOrders(rounds, undefined), [])
    assert.deepEqual(portfolioOrders(rounds, ''), [])
    assert.deepEqual(portfolioOrders(rounds, otherWallet), [])
    assert.deepEqual(portfolioOrders([], wallet), [])
  })

  it('keeps expired open orders pending until the contract actually closes', () => {
    const expired = round({ deadline: 1, bids: [bid()] })
    assert.equal(portfolioOrders([expired], wallet).length, 1)
  })
})

describe('preferredHolding', () => {
  it('prefers the configured address case-insensitively even when its balance is zero', () => {
    const configured = holding({ balance: '0', balanceRaw: 0n })
    const funded = holding({ address: otherCashAddress })
    assert.equal(preferredHolding([funded, configured], 'settlement', cashAddress.toUpperCase()), configured)
  })

  it('does not aggregate distinct addresses with identical symbols', () => {
    const first = holding()
    const second = holding({ address: otherCashAddress, balance: '25', balanceRaw: 25_000_000n })
    const result = preferredHolding([first, second], 'settlement')
    assert.equal(result, first)
    assert.equal(result?.balance, '10')
    assert.equal(preferredHolding([first, second], 'settlement', otherCashAddress), second)
  })

  it('falls back to the first positive balance of the requested kind, then the first token', () => {
    const empty = holding({ balance: '0', balanceRaw: 0n })
    const positive = holding({ address: otherCashAddress, balance: '0.000001', balanceRaw: 1n })
    const bond = holding({ address: bondAddress, kind: 'bond', symbol: 'BOND' })
    assert.equal(preferredHolding([bond, empty, positive], 'settlement', bondAddress), positive)
    assert.equal(preferredHolding([bond, empty], 'settlement'), empty)
    assert.equal(preferredHolding([empty, bond], 'bond', cashAddress), bond)
  })

  it('returns null if no token of the requested kind is available', () => {
    assert.equal(preferredHolding([], 'bond'), null)
    assert.equal(preferredHolding([holding()], 'bond'), null)
  })
})

describe('portfolioAmount', () => {
  it('normalizes zero, leading zeros, whitespace and insignificant trailing zeros', () => {
    for (const input of ['0', '00.000000', '-0.000', ' 0 ']) assert.equal(portfolioAmount(input), '0')
    assert.equal(portfolioAmount(' 00001234.500000 '), '1,234.5')
    assert.equal(portfolioAmount('1.23450000'), '1.2345')
    assert.equal(portfolioAmount('12', 8), '12')
  })

  it('preserves integers and decimals beyond the safe-integer limit', () => {
    assert.equal(portfolioAmount('9007199254740993.1234'), '9,007,199,254,740,993.1234')
    assert.equal(portfolioAmount('123456789012345678901234567890.0001'), '123,456,789,012,345,678,901,234,567,890.0001')
    assert.equal(portfolioAmount('9007199254740993.000000000000000001', 18), '9,007,199,254,740,993.000000000000000001')
  })

  it('marks exact half-up rounding and handles carry into a huge integer', () => {
    assert.equal(portfolioAmount('1.23454'), '≈ 1.2345')
    assert.equal(portfolioAmount('1.23455'), '≈ 1.2346')
    assert.equal(portfolioAmount('1.00000001'), '≈ 1')
    assert.equal(portfolioAmount('999999999999999999.99995'), '≈ 1,000,000,000,000,000,000')
    assert.equal(portfolioAmount('-12.345', 2), '≈ -12.35')
    assert.equal(portfolioAmount('199.5', 0), '≈ 200')
  })

  it('never displays a tiny nonzero balance as zero', () => {
    assert.equal(portfolioAmount('0.000000000000000001'), '<0.0001')
    assert.equal(portfolioAmount('0.00009999'), '<0.0001')
    assert.equal(portfolioAmount('0.0001'), '0.0001')
    assert.equal(portfolioAmount('0.009', 2), '<0.01')
    assert.equal(portfolioAmount('0.0000001', 6), '<0.000001')
    assert.equal(portfolioAmount('-0.000001'), '>-0.0001')
    assert.equal(portfolioAmount('0.5', 0), '<1')
  })

  it('rejects malformed values or invalid precision without inventing a balance', () => {
    for (const input of ['', ' ', 'NaN', 'Infinity', '1e18', '1,000', '0x10', '.5', '1.', '+1', '--1']) assert.equal(portfolioAmount(input), '—', input)
    for (const precision of [-1, 1.5, 101, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(portfolioAmount('123', precision), '—')
  })
})
