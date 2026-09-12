import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { DeploymentConfig } from '../src/types.ts'

// Vite replaces import.meta.env in the application. This loader supplies that
// environment to the same production modules under Node's TypeScript runner.
// It also resolves Vite's extensionless relative imports; no application logic
// is mocked or copied into the integration test.
const viteEnv: Record<string, string | boolean> = { DEV: true, BASE_URL: '/' }
;(globalThis as unknown as { __clearingBellTestEnv: typeof viteEnv }).__clearingBellTestEnv = viteEnv
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL)
      if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.endsWith('/src/lib/config.ts')) {
      return {
        format: 'module-typescript', shortCircuit: true,
        source: readFileSync(fileURLToPath(url), 'utf8').replaceAll('import.meta.env', 'globalThis.__clearingBellTestEnv'),
      }
    }
    return nextLoad(url, context)
  },
})

const { isLocalDeployment, loadDeployment, publicClientFor, validateDeployment } = await import('../src/lib/config.ts')
const configInput = {
  network: 'local', chainId: 31337, rpcUrl: 'http://127.0.0.1:8545', deploymentBlock: 0,
  contracts: { auctionEngine: '0x0000000000000000000000000000000000000001' },
}

test('configuration rejects invalid addresses, chain IDs, block bounds and RPC schemes', () => {
  for (const chainId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => validateDeployment({ ...configInput, chainId }), /chain ID/)
  for (const deploymentBlock of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => validateDeployment({ ...configInput, deploymentBlock }), /start block/)
  for (const rpcUrl of ['file:///tmp/rpc', 'javascript:alert(1)', 'ws://localhost:8545']) assert.throws(() => validateDeployment({ ...configInput, rpcUrl }), /HTTP or HTTPS/)
  assert.throws(() => validateDeployment({ ...configInput, contracts: { auctionEngine: 'not-an-address' } }), /valid contract address/)
  assert.throws(() => validateDeployment({ ...configInput, accounts: [{ address: 'bad-account' }] }), /valid contract address/)
})

test('unlocked-account access requires development mode, chain 31337 and a literal loopback host', () => {
  const config = validateDeployment(configInput)
  for (const rpcUrl of ['http://localhost:8545', 'http://127.0.0.1:8545', 'http://[::1]:8545']) assert.equal(isLocalDeployment({ ...config, rpcUrl }), true)
  for (const rpcUrl of ['https://testnet.hashio.io/api', 'http://localhost.example.com:8545', 'http://127.0.0.1.attacker.example:8545', 'http://localhost@attacker.example:8545']) assert.equal(isLocalDeployment({ ...config, rpcUrl }), false)
  assert.equal(isLocalDeployment({ ...config, chainId: 296 }), false)
  viteEnv.DEV = false
  try { assert.equal(isLocalDeployment(config), false) } finally { viteEnv.DEV = true }
})

test('partial environment configuration fails without silently falling back to a local manifest', async (t) => {
  viteEnv.VITE_RPC_URL = 'https://testnet.hashio.io/api'
  t.after(() => { delete viteEnv.VITE_RPC_URL })
  await assert.rejects(loadDeployment(), /VITE_RPC_URL, VITE_CHAIN_ID, and VITE_AUCTION_ENGINE_ADDRESS together/)
})

test('complete explicit network settings take precedence over the generated manifest', async (t) => {
  Object.assign(viteEnv, { VITE_RPC_URL: 'https://testnet.hashio.io/api', VITE_CHAIN_ID: '296', VITE_AUCTION_ENGINE_ADDRESS: configInput.contracts.auctionEngine })
  t.after(() => { delete viteEnv.VITE_RPC_URL; delete viteEnv.VITE_CHAIN_ID; delete viteEnv.VITE_AUCTION_ENGINE_ADDRESS })
  const config = await loadDeployment()
  assert.equal(config.chainId, 296)
  assert.equal(config.rpcUrl, 'https://testnet.hashio.io/api')
  assert.equal(config.accounts.length, 0)
})

test('missing or HTML deployment responses fail instead of producing placeholder data', async (t) => {
  const previousFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = previousFetch })
  globalThis.fetch = async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })
  await assert.rejects(loadDeployment(), /No deployment is configured/)
  globalThis.fetch = async () => new Response('missing', { status: 404 })
  await assert.rejects(loadDeployment(), /No deployment is configured/)
})

test('configured JSON manifest is loaded without caching and validated', async (t) => {
  const previousFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = previousFetch })
  globalThis.fetch = async (input, init) => {
    assert.equal(input, '/deployment.json')
    assert.equal(init?.cache, 'no-store')
    return new Response(JSON.stringify(configInput), { headers: { 'content-type': 'application/json' } })
  }
  assert.equal((await loadDeployment()).contracts.auctionEngine, configInput.contracts.auctionEngine)
})

// Opt in with RUN_CHAIN_TESTS=1. These tests only read the existing local stack:
// no signing, faucet, impersonation, reseed, account mutation or block mining.
test('local fixture: real rounds, registry eligibility, token balances and settlement events', { skip: process.env.RUN_CHAIN_TESTS !== '1' }, async () => {
  const manifestPath = process.env.CHAIN_DEPLOYMENT_PATH || fileURLToPath(new URL('../public/deployment.json', import.meta.url))
  const config: DeploymentConfig = validateDeployment(JSON.parse(readFileSync(manifestPath, 'utf8')))
  assert.equal(isLocalDeployment(config), true, 'Integration tests are restricted to local chain 31337')
  const { readSnapshot } = await import('../src/lib/chain.ts')
  const { tokenAbi } = await import('../src/lib/abi.ts')
  const rpc = publicClientFor(config)
  const investor = config.accounts.find((item) => item.label === 'Investor')
  const restricted = config.accounts.find((item) => item.role === 'restricted')
  assert.ok(investor)
  assert.ok(restricted)
  const snapshot = await readSnapshot(rpc, config, investor.address, '1')
  assert.equal(snapshot.eligibility, true)
  assert.equal(snapshot.selectedRound?.id, '1')
  assert.equal(snapshot.selectedRound?.phase, 'closed')
  assert.ok(snapshot.rounds.length >= 2)
  assert.ok(snapshot.rounds.every((round) => round.bidCount === round.bids.length))
  assert.equal(snapshot.historyError, null)
  assert.ok(snapshot.settlements.some((settlement) => settlement.roundId === '1' && settlement.quantity === '40' && settlement.price === '99.25'))
  assert.ok(snapshot.tokens.length >= 2)
  for (const holding of snapshot.tokens) {
    const actualBalance = await rpc.readContract({ address: holding.address, abi: tokenAbi, functionName: 'balanceOf', args: [investor.address] })
    const actualAllowance = await rpc.readContract({ address: holding.address, abi: tokenAbi, functionName: 'allowance', args: [investor.address, config.contracts.auctionEngine] })
    assert.equal(holding.balanceRaw, actualBalance)
    assert.equal(holding.allowanceRaw, actualAllowance)
  }
  const restrictedSnapshot = await readSnapshot(rpc, config, restricted.address, '1')
  assert.equal(restrictedSnapshot.eligibility, false)
  await assert.rejects(readSnapshot(rpc, { ...config, chainId: 296 }, null, null), /RPC returned chain 31337; expected 296/)
  await assert.rejects(readSnapshot(rpc, { ...config, contracts: { auctionEngine: '0x0000000000000000000000000000000000000000' } }, null, null), /No auction engine exists/)
})
