import type { AuctionPhase } from '../types'

export const mechanismStages: Array<{ id: string; phase: AuctionPhase; label: string; title: string; body: string; proof: string }> = [
  { id: '01', phase: 'commit', label: 'Approve', title: 'Approve your tokens', body: 'Connect an eligible wallet. Authorize the tokens for your order.', proof: 'Wallet approval' },
  { id: '02', phase: 'reveal', label: 'Place your order', title: 'Place your order', body: 'Choose a side, set your limit price and submit to the public book.', proof: 'Public limit orders' },
  { id: '03', phase: 'clear', label: 'Find the clearing price', title: 'Find the clearing price', body: 'Eligible orders meet at the price that matches the most bonds.', proof: 'Uniform price' },
  { id: '04', phase: 'settle', label: 'Receive your assets', title: 'Receive your assets', body: 'Bonds and payment exchange together. Your receipt is recorded on-chain.', proof: 'Atomic settlement' },
]
