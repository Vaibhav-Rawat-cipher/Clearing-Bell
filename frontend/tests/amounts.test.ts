import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatUnits } from 'viem'
import { parseOrder, parsePositiveAmount, requiredOrderFunds } from '../src/lib/amounts.ts'
import type { Address, LiveBid, LiveRound } from '../src/types.ts'

const investor: Address = '0x00000000000000000000000000000000000000aa'
const otherInvestor: Address = '0x00000000000000000000000000000000000000bb'
const bond: Address = '0x0000000000000000000000000000000000000001'
const cash: Address = '0x0000000000000000000000000000000000000002'
const otherCash: Address = '0x0000000000000000000000000000000000000003'
const unit = 10n ** 18n
const maxUint256 = 2n ** 256n - 1n

function bid(priceRaw: bigint, quantityRaw: bigint, options: Partial<LiveBid> = {}): LiveBid {
  return { bidder: investor, priceRaw, quantityRaw, price: formatUnits(priceRaw, 6), quantity: formatUnits(quantityRaw, 18), isBuy: true, index: '0', ...options }
}

function round(options: Partial<LiveRound> = {}): LiveRound {
  return {
    id: '1', bondToken: bond, settlementToken: cash,
    bond: { address: bond, name: 'Test bond', symbol: 'BOND', decimals: 18 },
    settlement: { address: cash, name: 'Test dollar', symbol: 'USDC', decimals: 6 },
    deadline: 1_900_000_000, phase: 'open', clearingPrice: '0', clearedQuantity: '0',
    clearingPriceRaw: 0n, clearedQuantityRaw: 0n, bidCount: options.bids?.length || 0, bids: [], ...options,
  }
}

describe('parsePositiveAmount', () => {
  it('parses base units exactly and accepts surrounding whitespace', () => {
    assert.equal(parsePositiveAmount(' 99.380001 ', 6, 'Price'), 99_380_001n)
    assert.equal(parsePositiveAmount('0.000000000000000001', 18, 'Quantity'), 1n)
    assert.equal(parsePositiveAmount('00012.50', 6, 'Price'), 12_500_000n)
  })

  it('preserves integers beyond JavaScript number precision', () => {
    assert.equal(parsePositiveAmount('9007199254740993', 0, 'Quantity'), 9_007_199_254_740_993n)
  })

  it('rejects excess decimal places without silently rounding', () => {
    assert.throws(() => parsePositiveAmount('1.0000001', 6, 'Price'), /at most 6 decimal places/)
    assert.throws(() => parsePositiveAmount('1.0', 0, 'Quantity'), /at most 0 decimal places/)
  })

  it('rejects negative, exponent, signed, non-finite and incomplete inputs', () => {
    for (const input of ['-1', '1e18', '1E3', '+1', 'Infinity', 'NaN', '', ' ', '.', '.5', '1.', '1,000', '0x10']) {
      assert.throws(() => parsePositiveAmount(input, 18, 'Quantity'), /positive decimal number/, input)
    }
  })

  it('rejects zero', () => {
    for (const input of ['0', '0.000000', '000']) assert.throws(() => parsePositiveAmount(input, 6, 'Price'), /greater than zero/)
  })

  it('accepts the uint256 maximum and rejects the next value', () => {
    assert.equal(parsePositiveAmount(maxUint256.toString(), 0, 'Amount'), maxUint256)
    assert.throws(() => parsePositiveAmount((maxUint256 + 1n).toString(), 0, 'Amount'), /too large/)
    assert.equal(parsePositiveAmount(formatUnits(maxUint256, 18), 18, 'Amount'), maxUint256)
  })
})

describe('parseOrder', () => {
  it('uses settlement-token decimals for price and 18 decimals for quantity', () => {
    assert.deepEqual(parseOrder({ side: 'BUY', price: '99.38', quantity: '10.5' }, round()), {
      price: 99_380_000n, quantity: 10_500_000_000_000_000_000n, cost: 1_043_490_000n, isBuy: true,
    })
    const eightDecimals = round({ settlement: { address: cash, name: 'Eight decimal token', symbol: 'EIGHT', decimals: 8 } })
    assert.equal(parseOrder({ side: 'BUY', price: '1.00000001', quantity: '1' }, eightDecimals).cost, 100_000_001n)
  })

  it('rounds a fractional buy quote upward to cover settlement allocation', () => {
    assert.equal(parseOrder({ side: 'BUY', price: '0.000001', quantity: '0.5' }, round()).cost, 1n)
    assert.equal(parseOrder({ side: 'BUY', price: '99.380001', quantity: '0.000000000000000001' }, round()).cost, 1n)
    assert.equal(parseOrder({ side: 'BUY', price: '0.000003', quantity: '0.5' }, round()).cost, 2n)
  })

  it('does not add a base unit to an exact quote and recognizes sell side', () => {
    const parsed = parseOrder({ side: 'SELL', price: '100', quantity: '2' }, round())
    assert.equal(parsed.cost, 200_000_000n)
    assert.equal(parsed.isBuy, false)
  })

  it('rejects non-18-decimal bonds', () => {
    assert.throws(() => parseOrder({ side: 'BUY', price: '1', quantity: '1' }, round({ bond: { address: bond, name: 'Unsupported', symbol: 'BAD', decimals: 6 } })), /18-decimal bond token/)
  })

  it('rejects a multiplication overflow even when both operands fit uint256', () => {
    const settlementZeroDecimals = round({ settlement: { address: cash, name: 'Whole token', symbol: 'WHOLE', decimals: 0 } })
    assert.equal(parseOrder({ side: 'BUY', price: maxUint256.toString(), quantity: '0.000000000000000001' }, settlementZeroDecimals).price, maxUint256)
    assert.throws(() => parseOrder({ side: 'BUY', price: maxUint256.toString(), quantity: '0.000000000000000002' }, settlementZeroDecimals), /arithmetic limit/)
  })
})

describe('requiredOrderFunds', () => {
  it('includes every own open buy across rounds sharing the settlement token', () => {
    const selected = round({ bids: [bid(99_000_000n, 2n * unit), bid(100_000_000n, unit)] })
    const later = round({ id: '2', bids: [bid(101_000_000n, 3n * unit)] })
    const result = requiredOrderFunds({ side: 'BUY', price: '100', quantity: '5' }, selected, [selected, later], investor)
    assert.equal(result.required, 1_101_000_000n)
    assert.equal(result.requiredFormatted, '1101')
    assert.equal(result.token.address, cash)
  })

  it('ceil-rounds each outstanding fractional order separately', () => {
    const selected = round({ bids: [bid(1n, unit / 2n), bid(1n, unit / 2n)] })
    const result = requiredOrderFunds({ side: 'BUY', price: '0.000001', quantity: '0.5' }, selected, [selected], investor)
    assert.equal(result.required, 3n)
    assert.equal(result.requiredFormatted, '0.000003')
  })

  it('ignores other investors, closed rounds and a different settlement token', () => {
    const selected = round({ bids: [bid(100_000_000n, 100n * unit, { bidder: otherInvestor })] })
    const closed = round({ id: '2', phase: 'closed', bids: [bid(100_000_000n, 100n * unit)] })
    const differentCurrency = round({ id: '3', settlementToken: otherCash, settlement: { address: otherCash, name: 'Other dollar', symbol: 'OTHER', decimals: 6 }, bids: [bid(100_000_000n, 100n * unit)] })
    assert.equal(requiredOrderFunds({ side: 'BUY', price: '100', quantity: '1' }, selected, [selected, closed, differentCurrency], investor).required, 100_000_000n)
  })

  it('requires bond quantities for sells, including own outstanding sell orders', () => {
    const selected = round({ bids: [bid(99_000_000n, 3n * unit, { isBuy: false }), bid(100_000_000n, 20n * unit)] })
    const later = round({ id: '2', bids: [bid(100_000_000n, unit / 2n, { isBuy: false })] })
    const result = requiredOrderFunds({ side: 'SELL', price: '100', quantity: '2.25' }, selected, [selected, later], investor)
    assert.equal(result.required, 5_750_000_000_000_000_000n)
    assert.equal(result.requiredFormatted, '5.75')
    assert.equal(result.token.address, bond)
  })

  it('matches wallet addresses case-insensitively', () => {
    const selected = round({ bids: [bid(100_000_000n, unit, { bidder: '0x00000000000000000000000000000000000000AA' })] })
    assert.equal(requiredOrderFunds({ side: 'BUY', price: '100', quantity: '1' }, selected, [selected], investor).required, 200_000_000n)
  })

  it('also covers liabilities when the same token is used in the other leg of another round', () => {
    const selected = round()
    const swappedLeg = round({ id: '2', bondToken: cash, bond: { address: cash, name: 'Same token as bond', symbol: 'CASHBOND', decimals: 18 }, bids: [bid(1n, 7n, { isBuy: false })] })
    assert.equal(requiredOrderFunds({ side: 'BUY', price: '1', quantity: '1' }, selected, [selected, swappedLeg], investor).required, 1_000_007n)
  })
})
