import { createPublicClient, createWalletClient, defineChain, getAddress, http, isAddress } from 'viem'
import type { Address, DeploymentConfig } from '../types'

function address(value: unknown, label: string): Address {
  if (typeof value !== 'string' || !isAddress(value)) throw new Error(`${label} must be a valid contract address.`)
  return getAddress(value)
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Deployment configuration is invalid.')
  return value as Record<string, unknown>
}

export function validateDeployment(value: unknown): DeploymentConfig {
  const input = object(value)
  const contracts = object(input.contracts)
  const chainId = Number(input.chainId)
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('Deployment chain ID is invalid.')
  const rpcUrl = String(input.rpcUrl || '')
  const url = new URL(rpcUrl)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('RPC URL must use HTTP or HTTPS.')
  const deploymentBlock = Number(input.deploymentBlock ?? 0)
  if (!Number.isSafeInteger(deploymentBlock) || deploymentBlock < 0) throw new Error('Deployment start block is invalid.')
  const optionalAddress = (key: string) => contracts[key] ? address(contracts[key], key) : undefined
  return {
    version: 1,
    network: typeof input.network === 'string' ? input.network : `Chain ${chainId}`,
    chainId,
    rpcUrl,
    deploymentBlock,
    explorerUrl: typeof input.explorerUrl === 'string' && /^https:\/\//.test(input.explorerUrl) ? input.explorerUrl.replace(/\/$/, '') : undefined,
    contracts: {
      auctionEngine: address(contracts.auctionEngine, 'Auction engine'),
      complianceGate: optionalAddress('complianceGate'),
      identityRegistry: optionalAddress('identityRegistry'),
      bondToken: optionalAddress('bondToken'),
      settlementToken: optionalAddress('settlementToken'),
    },
    accounts: Array.isArray(input.accounts) ? input.accounts.map((entry) => {
      const account = object(entry)
      return { address: address(account.address, 'Local account'), label: String(account.label || 'Local account'), role: String(account.role || 'investor') }
    }) : [],
    bond: input.bond as DeploymentConfig['bond'],
    settlement: input.settlement as DeploymentConfig['settlement'],
  }
}

export async function loadDeployment(): Promise<DeploymentConfig> {
  // An explicitly configured network takes precedence over a generated local manifest.
  if (import.meta.env.VITE_AUCTION_ENGINE_ADDRESS || import.meta.env.VITE_RPC_URL || import.meta.env.VITE_CHAIN_ID) {
    if (!import.meta.env.VITE_RPC_URL || !import.meta.env.VITE_CHAIN_ID || !import.meta.env.VITE_AUCTION_ENGINE_ADDRESS) {
      throw new Error('Set VITE_RPC_URL, VITE_CHAIN_ID, and VITE_AUCTION_ENGINE_ADDRESS together.')
    }
    return validateDeployment({
      network: import.meta.env.VITE_NETWORK_NAME || 'Configured network',
      rpcUrl: import.meta.env.VITE_RPC_URL,
      chainId: import.meta.env.VITE_CHAIN_ID,
      deploymentBlock: import.meta.env.VITE_DEPLOYMENT_BLOCK || 0,
      explorerUrl: import.meta.env.VITE_EXPLORER_URL,
      contracts: { auctionEngine: import.meta.env.VITE_AUCTION_ENGINE_ADDRESS },
    })
  }
  const response = await fetch(`${import.meta.env.BASE_URL}deployment.json`, { cache: 'no-store' })
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('No deployment is configured. Start the local stack or supply the network and auction engine environment settings.')
  }
  return validateDeployment(await response.json())
}

export function isLocalDeployment(config: DeploymentConfig): boolean {
  const host = new URL(config.rpcUrl).hostname
  return import.meta.env.DEV && config.chainId === 31337 && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)
}

export function chainFor(config: DeploymentConfig) {
  return defineChain({
    id: config.chainId,
    name: config.network,
    nativeCurrency: { name: config.chainId === 296 ? 'HBAR' : 'Ether', symbol: config.chainId === 296 ? 'HBAR' : 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
    ...(config.explorerUrl ? { blockExplorers: { default: { name: 'Explorer', url: config.explorerUrl } } } : {}),
  })
}

export function publicClientFor(config: DeploymentConfig) {
  return createPublicClient({ chain: chainFor(config), transport: http(config.rpcUrl, { timeout: 12_000, retryCount: 1 }), batch: { multicall: false } })
}

export type AuctionPublicClient = ReturnType<typeof publicClientFor>

export async function localAccountsFor(config: DeploymentConfig): Promise<Address[]> {
  if (!isLocalDeployment(config)) return []
  const wallet = createWalletClient({ chain: chainFor(config), transport: http(config.rpcUrl, { retryCount: 0, timeout: 12_000 }) })
  return wallet.getAddresses()
}
