import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LiveBid, LiveRound } from '../src/types.ts'
import { buildDepthModel, nearestDepthPoint, plotRatio, priceTicks, quantityTicks } from '../src/lib/depth-chart.ts'

const bond = '0x0000000000000000000000000000000000000001'
const cash = '0x0000000000000000000000000000000000000002'
const unit = 10n ** 18n
function bid(priceRaw: bigint, quantityRaw: bigint, isBuy: boolean, index = '0'): LiveBid {
  return { bidder: bond, priceRaw, quantityRaw, price: '', quantity: '', isBuy, index }
}
function round(bids: LiveBid[], options: Partial<LiveRound> = {}): LiveRound {
  return { id:'1', bondToken:bond, settlementToken:cash, bond:{address:bond,name:'Bond',symbol:'BOND',decimals:18}, settlement:{address:cash,name:'USDC',symbol:'USDC',decimals:6}, deadline:1_900_000_000, phase:'open', clearingPrice:'0', clearedQuantity:'0', clearingPriceRaw:0n, clearedQuantityRaw:0n, bidCount:bids.length, bids, ...options }
}

describe('exact auction depth', () => {
  it('shows actual two-sided seeded depth without interpolating orders', () => {
    const model = buildDepthModel(round([bid(100_000_000n,20n*unit,true),bid(99_380_000n,150n*unit,false,'1')]))
    assert.deepEqual(model.points, [
      {priceRaw:99_380_000n,bidVolume:0n,askVolume:150n*unit,bidDepth:20n*unit,askDepth:150n*unit},
      {priceRaw:100_000_000n,bidVolume:20n*unit,askVolume:0n,bidDepth:20n*unit,askDepth:150n*unit},
    ])
    assert.equal(model.totalBid,20n*unit)
    assert.equal(model.totalAsk,150n*unit)
    assert.equal(model.clearingPrice,null)
  })
  it('aggregates equal prices and applies inclusive limit-price semantics', () => {
    const model = buildDepthModel(round([bid(100n,2n,true),bid(100n,3n,true),bid(100n,7n,false),bid(101n,11n,true),bid(101n,13n,false)]))
    assert.equal(model.points[0].bidVolume,5n)
    assert.equal(model.points[0].bidDepth,16n)
    assert.equal(model.points[0].askDepth,7n)
    assert.equal(model.points[1].bidDepth,11n)
    assert.equal(model.points[1].askDepth,20n)
  })
  it('returns empty states safely and discards zero quantities', () => {
    assert.equal(buildDepthModel(null).points.length,0)
    const model = buildDepthModel(round([bid(1n,0n,true),bid(0n,10n,false)]))
    assert.equal(model.points.length,0)
    assert.equal(model.orderCount,0)
    assert.equal(model.totalBid,0n)
    assert.deepEqual(quantityTicks(0n),[0n,1n,2n,3n,4n])
    assert.equal(nearestDepthPoint([],0,[0n,1n]),-1)
  })
  it('pads a single price and keeps tiny fractional tokens nonzero', () => {
    const model = buildDepthModel(round([bid(1n,1n,true),bid(1n,2n,false)]))
    assert.deepEqual(model.priceDomain,[0n,2n])
    assert.equal(model.points.length,1)
    assert.equal(model.maxDepth,2n)
    assert.equal(plotRatio(1n,...model.priceDomain),.5)
    assert.equal(plotRatio(1n,0n,2n),.5)
    assert.equal(nearestDepthPoint(model.points,1,model.priceDomain),0)
  })
  it('retains precision above Number.MAX_SAFE_INTEGER', () => {
    const enormous = 10n**70n
    const model = buildDepthModel(round([bid(enormous, enormous+1n,true),bid(enormous+1n,enormous+3n,false)]))
    assert.equal(model.points.length,2)
    assert.equal(model.totalBid,enormous+1n)
    assert.equal(model.totalAsk,enormous+3n)
    assert.equal(plotRatio(enormous+1n,enormous,enormous+2n),.5)
    assert.ok(quantityTicks(model.maxDepth).at(-1)! >= model.maxDepth)
  })
  it('includes a recorded clearing guide only for a closed round', () => {
    const bids = [bid(90n,unit,false),bid(100n,unit,true)]
    assert.equal(buildDepthModel(round(bids,{clearingPriceRaw:95n})).clearingPrice,null)
    assert.equal(buildDepthModel(round(bids,{phase:'clearing',clearingPriceRaw:95n})).clearingPrice,null)
    const closed = buildDepthModel(round(bids,{phase:'closed',clearingPriceRaw:95n}))
    assert.equal(closed.clearingPrice,95n)
    assert.deepEqual(closed.points.map(point=>point.priceRaw),[90n,95n,100n])
    assert.equal(closed.points[1].bidDepth,unit)
    assert.equal(closed.points[1].askDepth,unit)
    assert.equal(buildDepthModel(round(bids,{phase:'closed'})).clearingPrice,null)
  })
  it('generates finite normalized axes and exact unique price ticks', () => {
    assert.equal(plotRatio(1n,1n,1n),.5)
    assert.equal(plotRatio(-1n,0n,10n),0)
    assert.equal(plotRatio(20n,0n,10n),1)
    assert.deepEqual(priceTicks([0n,2n]),[0n,1n,2n])
    assert.deepEqual(quantityTicks(150n*unit),[0n,50n*unit,100n*unit,150n*unit,200n*unit])
  })
})
