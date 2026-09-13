import { formatUnits, getAddress, zeroAddress } from 'viem'
import type { Address, DeploymentConfig, LiveBid, LiveRound, Settlement, TokenHolding, TokenMetadata } from '../types'
import { auctionAbi, gateAbi, tokenAbi } from './abi'
import { sameAddress } from './amounts'
import { localAccountsFor, type AuctionPublicClient } from './config'
import { readableError } from './errors'

// Small delay to avoid RPC rate-limiting on public testnets
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function batches<T, U>(items: T[], batchSize: number, work: (item: T) => Promise<U>): Promise<U[]> {
  const result: U[] = []
  for (let offset = 0; offset < items.length; offset += batchSize) {
    result.push(...await Promise.all(items.slice(offset, offset + batchSize).map(work)))
    if (offset + batchSize < items.length) await sleep(200)
  }
  return result
}

export async function readToken(client: AuctionPublicClient, token: Address): Promise<TokenMetadata> {
  const [name, symbol, decimals] = await Promise.all([
    client.readContract({ address: token, abi: tokenAbi, functionName: 'name' }),
    client.readContract({ address: token, abi: tokenAbi, functionName: 'symbol' }),
    client.readContract({ address: token, abi: tokenAbi, functionName: 'decimals' }),
  ])
  return { address: getAddress(token), name, symbol, decimals }
}

export type ChainSnapshot = {
  rounds: LiveRound[]
  selectedRound: LiveRound | null
  platformAdmin: Address
  bondIssuer: Address | null
  gate: Address
  paused: boolean
  eligibility: boolean | null
  eligibilityError: string | null
  tokens: TokenHolding[]
  settlements: Settlement[]
  historyError: string | null
  historyFromBlock: string | null
  roundsTruncated: boolean
  localAccounts: Address[]
  blockNumber: string
  chainTimestamp: number
  /** The head block scanned — pass back as nextFromBlock on the next call. */
  nextFromBlock: bigint
}

/**
 * readSnapshot — reads the current chain state.
 *
 * Settlement event scanning uses a SLIDING WINDOW:
 * - On first call: starts from deploymentBlock (or last 200 blocks if not set)
 * - On subsequent calls: pass `fromBlock` = previousSnapshot.nextFromBlock
 * - Each call scans forward 10 blocks at a time until the current head
 * - New settlements are appended to `prevSettlements`
 *
 * This means you NEVER re-scan old blocks, and each poll is ~2 cheap RPC calls.
 */
export async function readSnapshot(
  client: AuctionPublicClient,
  config: DeploymentConfig,
  account: Address | null,
  selectedId: string | null,
  /** Block to start scanning events from (sliding window cursor). Pass 0n on first load. */
  fromBlock: bigint = 0n,
  /** Accumulated settlements from previous calls — new ones are appended. */
  prevSettlements: Settlement[] = [],
): Promise<ChainSnapshot> {
  const engine = config.contracts.auctionEngine
  const roundLimit = 10  // Last 10 rounds — covers recent history without being slow

  // ── 1. Core state reads (parallel — proxy handles CORS, no rate limit) ────
  const [nextRoundId, issuer, gate, paused, block] = await Promise.all([
    client.readContract({ address: engine, abi: auctionAbi, functionName: 'nextRoundId' }),
    client.readContract({ address: engine, abi: auctionAbi, functionName: 'issuer' }),
    client.readContract({ address: engine, abi: auctionAbi, functionName: 'complianceGate' }),
    client.readContract({ address: engine, abi: auctionAbi, functionName: 'paused' }),
    client.getBlock(),
  ])

  if (gate === zeroAddress) throw new Error('The auction engine has no compliance gate.')
  if (config.contracts.complianceGate && !sameAddress(config.contracts.complianceGate, gate))
    throw new Error('The configured compliance gate does not match the auction engine.')

  const head = block.number

  // ── 2. Load rounds (most recent 20) ───────────────────────────────────────
  const firstId = nextRoundId > BigInt(roundLimit) ? nextRoundId - BigInt(roundLimit) : 1n
  const roundIds: bigint[] = []
  for (let id = firstId; id < nextRoundId; id++) roundIds.push(id)
  if (selectedId && /^\d+$/.test(selectedId) && BigInt(selectedId) > 0n && BigInt(selectedId) < firstId)
    roundIds.unshift(BigInt(selectedId))

  const metadata = new Map<string, Promise<TokenMetadata>>()
  const tokenMetadata = (address: Address) => {
    const key = address.toLowerCase()
    if (!metadata.has(key)) metadata.set(key, readToken(client, address))
    return metadata.get(key)!
  }

  // Fetch all rounds in parallel batches (3 at a time) — proxy handles CORS
  const rounds = await batches(roundIds, 3, async (id): Promise<LiveRound> => {
    const [raw, rawBids] = await Promise.all([
      client.readContract({ address: engine, abi: auctionAbi, functionName: 'rounds', args: [id] }),
      client.readContract({ address: engine, abi: auctionAbi, functionName: 'getRoundBids', args: [id] })
        .catch(() => [] as Awaited<ReturnType<AuctionPublicClient['readContract']>>),
    ])
    const [bond, settlement] = await Promise.all([tokenMetadata(raw[1]), tokenMetadata(raw[2])])
    const bids: LiveBid[] = (Array.isArray(rawBids) ? rawBids : []).map((bid: {
      bidder: Address; price: bigint; quantity: bigint; isBuy: boolean; index: bigint
    }) => ({
      bidder: getAddress(bid.bidder), price: formatUnits(bid.price, settlement.decimals),
      quantity: formatUnits(bid.quantity, bond.decimals), isBuy: bid.isBuy, index: bid.index.toString(),
      priceRaw: bid.price, quantityRaw: bid.quantity,
    }))
    return {
      id: raw[0].toString(), bondToken: getAddress(raw[1]), settlementToken: getAddress(raw[2]),
      bond, settlement,
      deadline: Number(raw[3]),
      // Phase enum: 0=Closed (default/settled), 1=Open, 2=Cleared (price set, settlements done)
      // Both 0 and 2 are "done" states — map both to 'closed' so UI shows settled state correctly
      phase: raw[4] === 1 ? 'open' : raw[4] === 2 ? 'closed' : 'closed',
      clearingPrice: formatUnits(raw[5], settlement.decimals),
      clearedQuantity: formatUnits(raw[6], bond.decimals),
      clearingPriceRaw: raw[5], clearedQuantityRaw: raw[6], bidCount: Number(raw[7]), bids,
    }
  })

  rounds.reverse()

  const selectedRound = rounds.find((r) => r.id === selectedId)
    || rounds.find((r) => r.phase === 'open')
    || rounds[0] || null

  // ── 3. Eligibility (only when wallet connected) ───────────────────────────
  let eligibility: boolean | null = null
  let eligibilityError: string | null = null
  if (account && selectedRound) {
    try {
      eligibility = await client.readContract({
        address: gate, abi: gateAbi, functionName: 'isEligible',
        args: [account, selectedRound.bondToken],
      })
    } catch (error) { eligibilityError = readableError(error) }
  }

  // ── 4. Token balances (only when wallet connected) ────────────────────────
  const uniqueTokens = new Map<string, { token: TokenMetadata; kind: 'bond' | 'settlement' }>()
  for (const round of rounds) {
    uniqueTokens.set(round.bondToken.toLowerCase(), { token: round.bond, kind: 'bond' })
    uniqueTokens.set(round.settlementToken.toLowerCase(), { token: round.settlement, kind: 'settlement' })
  }
  if (config.contracts.bondToken && !uniqueTokens.has(config.contracts.bondToken.toLowerCase()))
    uniqueTokens.set(config.contracts.bondToken.toLowerCase(), { token: await tokenMetadata(config.contracts.bondToken), kind: 'bond' })
  if (config.contracts.settlementToken && !uniqueTokens.has(config.contracts.settlementToken.toLowerCase()))
    uniqueTokens.set(config.contracts.settlementToken.toLowerCase(), { token: await tokenMetadata(config.contracts.settlementToken), kind: 'settlement' })

  const tokens: TokenHolding[] = []
  if (account) {
    // Parallel reads — CORS handled by Vite proxy, no rate limit issues
    const entries = [...uniqueTokens.values()]
    const results = await Promise.all(entries.map(async ({ token, kind }) => {
      const [balanceRaw, allowanceRaw] = await Promise.all([
        client.readContract({ address: token.address, abi: tokenAbi, functionName: 'balanceOf', args: [account] }),
        client.readContract({ address: token.address, abi: tokenAbi, functionName: 'allowance', args: [account, engine] }),
      ])
      return { ...token, kind, balanceRaw, allowanceRaw, balance: formatUnits(balanceRaw, token.decimals), allowance: formatUnits(allowanceRaw, token.decimals) }
    }))
    tokens.push(...results)
  }

  // ── 5. Sliding-window event scan ─────────────────────────────────────────
  //
  // Strategy: scan FORWARD from `fromBlock` up to current `head`, in
  // windows of 10 blocks at a time. New events are merged with
  // `prevSettlements`. On the first call (fromBlock=0n), anchor to the
  // deployment block (or last 200 blocks if not configured).
  //
  // Each subsequent call only scans the NEW blocks since the last refresh —
  // typically 1–3 blocks on Hedera testnet (3s block time).
  let historyError: string | null = null
  let historyFromBlock: string | null = null
  const newSettlements: Settlement[] = []
  let nextFromBlock = head + 1n  // advance cursor to just past head

  if (account) {
    const deployedAt = BigInt(config.deploymentBlock)
    // On first call (fromBlock === 0n), determine start anchor
    const scanFrom = fromBlock === 0n
      ? (deployedAt > 0n ? deployedAt : (head > 200n ? head - 200n : 0n))
      : fromBlock

    historyFromBlock = scanFrom.toString()

    if (scanFrom <= head) {
      try {
        // Scan in 2000-block windows from scanFrom → head
        const windowSize = 2000n
        for (let from = scanFrom; from <= head; from += windowSize) {
          const to = from + windowSize - 1n < head ? from + windowSize - 1n : head
          const logs = await client.getContractEvents({
            address: engine, abi: auctionAbi, eventName: 'Settled',
            args: { bidder: account },
            fromBlock: from, toBlock: to, strict: true,
          })
          await sleep(100)
          for (const log of logs) {
            const round = rounds.find((item) => item.id === log.args.roundId.toString())
            if (!round) continue
            newSettlements.push({
              id: `${log.transactionHash}-${log.logIndex}`,
              roundId: log.args.roundId.toString(),
              bidder: getAddress(log.args.bidder),
              quantity: formatUnits(log.args.filledQuantity, round.bond.decimals),
              price: formatUnits(log.args.settledPrice, round.settlement.decimals),
              isBuy: log.args.isBuy,
              transactionHash: log.transactionHash,
              blockNumber: log.blockNumber.toString(),
              bondSymbol: round.bond.symbol,
              settlementSymbol: round.settlement.symbol,
            })
          }
        }
      } catch (error) { historyError = readableError(error) }
    }
  }

  // Merge: new events at top (most recent first), deduplicated by id
  const existingIds = new Set(prevSettlements.map(s => s.id))
  const deduped = newSettlements.filter(s => !existingIds.has(s.id))
  const settlements = [...deduped.reverse(), ...prevSettlements]

  const localAccounts = await localAccountsFor(config).catch(() => [] as Address[])
  return {
    rounds, selectedRound, platformAdmin: getAddress(issuer), bondIssuer: getAddress(issuer),
    gate: getAddress(gate), paused, eligibility, eligibilityError,
    tokens, settlements, historyError, historyFromBlock,
    roundsTruncated: firstId > 1n,
    localAccounts: localAccounts.map((item) => getAddress(item)),
    blockNumber: block.number.toString(), chainTimestamp: Number(block.timestamp),
    nextFromBlock,
  }
}
