import { formatUnits, getAddress, zeroAddress } from 'viem'
import type { Address, DeploymentConfig, LiveBid, LiveRound, Settlement, TokenHolding, TokenMetadata } from '../types'
import { auctionAbi, gateAbi, tokenAbi } from './abi'
import { sameAddress } from './amounts'
import { localAccountsFor, type AuctionPublicClient } from './config'
import { readableError } from './errors'

const roundLimit = 100
const historyBlockLimit = 20_000n

async function batches<T, U>(items: T[], batchSize: number, work: (item: T) => Promise<U>): Promise<U[]> {
  const result: U[] = []
  for (let offset = 0; offset < items.length; offset += batchSize) result.push(...await Promise.all(items.slice(offset, offset + batchSize).map(work)))
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
  /** Clearing Bell platform admin address (controls issuer registration, global pause). */
  platformAdmin: Address
  /** Registered issuer for the currently selected round's bond token (may be null if no round selected). */
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
}

export async function readSnapshot(client: AuctionPublicClient, config: DeploymentConfig, account: Address | null, selectedId: string | null): Promise<ChainSnapshot> {
  const engine = config.contracts.auctionEngine
  const chainId = await client.getChainId()
  if (chainId !== config.chainId) throw new Error(`RPC returned chain ${chainId}; expected ${config.chainId}. Correct the deployment configuration.`)
  const code = await client.getCode({ address: engine })
  if (!code || code === '0x') throw new Error('No auction engine exists at the configured address. Redeploy the local stack or correct the contract address.')
  const [nextRoundId, platformAdmin, gate, paused, block] = await Promise.all([
    client.readContract({ address: engine, abi: auctionAbi, functionName: 'nextRoundId' }),
    client.readContract({ address: engine, abi: auctionAbi, functionName: 'platformAdmin' }),
    client.readContract({ address: engine, abi: auctionAbi, functionName: 'complianceGate' }),
    client.readContract({ address: engine, abi: auctionAbi, functionName: 'paused' }),
    client.getBlock(),
  ])
  if (gate === zeroAddress) throw new Error('The auction engine has no compliance gate.')
  if (config.contracts.complianceGate && !sameAddress(config.contracts.complianceGate, gate)) throw new Error('The configured compliance gate does not match the auction engine.')
  const firstId = nextRoundId > BigInt(roundLimit) ? nextRoundId - BigInt(roundLimit) : 1n
  const roundIds: bigint[] = []
  for (let id = firstId; id < nextRoundId; id++) roundIds.push(id)
  if (selectedId && /^\d+$/.test(selectedId) && BigInt(selectedId) > 0n && BigInt(selectedId) < firstId) roundIds.unshift(BigInt(selectedId))
  const metadata = new Map<string, Promise<TokenMetadata>>()
  const tokenMetadata = (address: Address) => {
    const key = address.toLowerCase()
    if (!metadata.has(key)) metadata.set(key, readToken(client, address))
    return metadata.get(key)!
  }
  const rounds = await batches(roundIds, 6, async (id): Promise<LiveRound> => {
    const [raw, rawBids] = await Promise.all([
      client.readContract({ address: engine, abi: auctionAbi, functionName: 'rounds', args: [id] }),
      client.readContract({ address: engine, abi: auctionAbi, functionName: 'getRoundBids', args: [id] }),
    ])
    const [bond, settlement] = await Promise.all([tokenMetadata(raw[1]), tokenMetadata(raw[2])])
    const bids: LiveBid[] = rawBids.map((bid) => ({
      bidder: getAddress(bid.bidder), price: formatUnits(bid.price, settlement.decimals),
      quantity: formatUnits(bid.quantity, bond.decimals), isBuy: bid.isBuy, index: bid.index.toString(),
      priceRaw: bid.price, quantityRaw: bid.quantity,
    }))
    return {
      id: raw[0].toString(), bondToken: getAddress(raw[1]), settlementToken: getAddress(raw[2]), bond, settlement,
      deadline: Number(raw[3]), phase: raw[4] === 1 ? 'open' : raw[4] === 2 ? 'clearing' : 'closed',
      clearingPrice: formatUnits(raw[5], settlement.decimals), clearedQuantity: formatUnits(raw[6], bond.decimals),
      clearingPriceRaw: raw[5], clearedQuantityRaw: raw[6], bidCount: Number(raw[7]), bids,
    }
  })
  rounds.reverse()
  const selectedRound = rounds.find((round) => round.id === selectedId) || rounds.find((round) => round.phase === 'open') || rounds[0] || null
  // Fetch the registered issuer for the selected round's bond (null if no round)
  let bondIssuer: Address | null = null
  if (selectedRound) {
    try {
      const raw = await client.readContract({ address: engine, abi: auctionAbi, functionName: 'bondIssuers', args: [selectedRound.bondToken] })
      bondIssuer = getAddress(raw)
    } catch { /* bond not registered yet — bondIssuer stays null */ }
  }
  let eligibility: boolean | null = null
  let eligibilityError: string | null = null
  if (account && selectedRound) {
    try {
      eligibility = await client.readContract({ address: gate, abi: gateAbi, functionName: 'isEligible', args: [account, selectedRound.bondToken] })
    } catch (error) { eligibilityError = readableError(error) }
  }
  const uniqueTokens = new Map<string, { token: TokenMetadata; kind: 'bond' | 'settlement' }>()
  for (const round of rounds) {
    uniqueTokens.set(round.bondToken.toLowerCase(), { token: round.bond, kind: 'bond' })
    uniqueTokens.set(round.settlementToken.toLowerCase(), { token: round.settlement, kind: 'settlement' })
  }
  if (config.contracts.bondToken && !uniqueTokens.has(config.contracts.bondToken.toLowerCase())) uniqueTokens.set(config.contracts.bondToken.toLowerCase(), { token: await tokenMetadata(config.contracts.bondToken), kind: 'bond' })
  if (config.contracts.settlementToken && !uniqueTokens.has(config.contracts.settlementToken.toLowerCase())) uniqueTokens.set(config.contracts.settlementToken.toLowerCase(), { token: await tokenMetadata(config.contracts.settlementToken), kind: 'settlement' })
  const tokens: TokenHolding[] = account ? await batches([...uniqueTokens.values()], 6, async ({ token, kind }) => {
    const [balanceRaw, allowanceRaw] = await Promise.all([
      client.readContract({ address: token.address, abi: tokenAbi, functionName: 'balanceOf', args: [account] }),
      client.readContract({ address: token.address, abi: tokenAbi, functionName: 'allowance', args: [account, engine] }),
    ])
    return { ...token, kind, balanceRaw, allowanceRaw, balance: formatUnits(balanceRaw, token.decimals), allowance: formatUnits(allowanceRaw, token.decimals) }
  }) : []
  let historyError: string | null = null
  let historyFromBlock: string | null = null
  const settlements: Settlement[] = []
  if (account) {
    // Bound and disclose log history; public RPCs commonly cap individual ranges.
    const head = block.number
    const deployedAt = BigInt(config.deploymentBlock)
    const boundedStart = head > historyBlockLimit ? head - historyBlockLimit : 0n
    const start = deployedAt > boundedStart ? deployedAt : boundedStart
    historyFromBlock = start.toString()
    try {
      for (let from = start; from <= head; from += 2000n) {
        const to = from + 1999n < head ? from + 1999n : head
        const logs = await client.getContractEvents({ address: engine, abi: auctionAbi, eventName: 'Settled', args: { bidder: account }, fromBlock: from, toBlock: to, strict: true })
        for (const log of logs) {
          const round = rounds.find((item) => item.id === log.args.roundId.toString())
          if (!round) continue
          settlements.push({
            id: `${log.transactionHash}-${log.logIndex}`, roundId: log.args.roundId.toString(), bidder: getAddress(log.args.bidder),
            quantity: formatUnits(log.args.filledQuantity, round.bond.decimals), price: formatUnits(log.args.settledPrice, round.settlement.decimals),
            isBuy: log.args.isBuy, transactionHash: log.transactionHash, blockNumber: log.blockNumber.toString(),
            bondSymbol: round.bond.symbol, settlementSymbol: round.settlement.symbol,
          })
        }
      }
      settlements.reverse()
    } catch (error) { historyError = readableError(error) }
  }
  const localAccounts = await localAccountsFor(config).catch(() => [] as Address[])
  return {
    rounds, selectedRound, platformAdmin: getAddress(platformAdmin), bondIssuer, gate: getAddress(gate), paused, eligibility, eligibilityError,
    tokens, settlements, historyError, historyFromBlock, roundsTruncated: firstId > 1n, localAccounts: localAccounts.map((item) => getAddress(item)),
    blockNumber: block.number.toString(), chainTimestamp: Number(block.timestamp),
  }
}
