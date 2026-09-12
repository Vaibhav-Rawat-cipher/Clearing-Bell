#!/usr/bin/env node
/** Start a loopback-only Anvil chain and deploy a reproducible auction fixture.
 * Uses unlocked Anvil accounts. No signing keys are read, printed, or exported.
 * Run from the repository root: node scripts/local-dev.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, 'frontend/package.json'));
let viem;
try { viem = require('viem'); } catch {
  throw new Error('Install frontend dependencies first: npm --prefix frontend install');
}
const { createPublicClient, createWalletClient, defineChain, http, parseUnits, maxUint256 } = viem;
const rpcUrl = 'http://127.0.0.1:8545';
const chain = defineChain({
  id: 31337, name: 'Clearing Bell Local',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const localDir = join(root, 'contracts/local');
const manifestPath = join(localDir, 'deployment.json');
const publicPath = join(root, 'frontend/public/deployment.json');
const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 1500, retryCount: 0 }) });

function executable(name) {
  const located = spawnSync('which', [name], { encoding: 'utf8' });
  if (located.status !== 0) throw new Error(`${name} is required. Install Foundry: https://getfoundry.sh/`);
  return located.stdout.trim();
}

async function ensureNode() {
  let chainId;
  try { chainId = await client.getChainId(); } catch { /* Start a new local node. */ }
  if (chainId !== undefined) {
    if (chainId !== 31337) throw new Error('Port 8545 is occupied by a different chain; refusing to deploy.');
    const version = await client.request({ method: 'web3_clientVersion' });
    if (!version.toLowerCase().includes('anvil')) throw new Error('Expected Anvil on local port 8545.');
    return;
  }
  const child = spawn(executable('anvil'), ['--host', '127.0.0.1', '--port', '8545', '--chain-id', '31337', '--silent'], {
    cwd: root, detached: true, stdio: 'ignore',
  });
  child.unref();
  await writeFile(join(localDir, 'anvil.pid'), `${child.pid}\n`);
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    try { if (await client.getChainId() === 31337) return; } catch { /* Wait for startup. */ }
  }
  throw new Error('Anvil did not start on 127.0.0.1:8545.');
}

async function artifact(source, name) {
  return JSON.parse(await readFile(join(root, 'contracts/out', source, `${name}.json`), 'utf8'));
}

async function main() {
  await mkdir(localDir, { recursive: true });
  await mkdir(dirname(publicPath), { recursive: true });
  await ensureNode();
  let previous;
  try { previous = JSON.parse(await readFile(manifestPath, 'utf8')); } catch { /* First deployment. */ }
  if (previous?.chainId === chain.id && !process.argv.includes('--reseed')) {
    const code = await client.getCode({ address: previous.contracts.auctionEngine });
    if (code && code !== '0x') {
      await copyFile(manifestPath, publicPath);
      console.log(`Local auction already deployed at ${previous.contracts.auctionEngine}.`);
      console.log('RPC: http://127.0.0.1:8545 · chain 31337. Use --reseed to deploy a fresh fixture.');
      return;
    }
  }

  console.log('Building contracts…');
  const build = spawnSync(executable('forge'), ['build', '--quiet'], { cwd: join(root, 'contracts'), stdio: 'inherit' });
  if (build.status !== 0) throw new Error('Contract build failed. Run git submodule update --init --recursive if dependencies are missing.');
  const addresses = await client.request({ method: 'eth_accounts' });
  if (addresses.length < 5) throw new Error('Anvil must provide at least five unlocked development accounts.');
  const [issuer, investor, seller, restricted, maker] = addresses;
  const wallets = new Map(addresses.map(account => [account.toLowerCase(), createWalletClient({ account, chain, transport: http(rpcUrl) })]));
  const deploymentBlock = Number(await client.getBlockNumber());
  const engineArtifact = await artifact('AuctionEngine.sol', 'AuctionEngine');
  const gateArtifact = await artifact('ComplianceGate.sol', 'ComplianceGate');
  const tokenArtifact = await artifact('MockERC20.sol', 'MockERC20');
  const registryArtifact = await artifact('MockIdentityRegistry.sol', 'MockIdentityRegistry');

  async function receipt(hash) {
    const result = await client.waitForTransactionReceipt({ hash });
    if (result.status !== 'success') throw new Error(`Local transaction reverted: ${hash}`);
    return result;
  }
  async function deploy(compiled, args = []) {
    const hash = await wallets.get(issuer.toLowerCase()).deployContract({ abi: compiled.abi, bytecode: compiled.bytecode.object, args });
    const result = await receipt(hash);
    if (!result.contractAddress) throw new Error('Deployment did not return an address.');
    return result.contractAddress;
  }
  async function write(account, address, compiled, functionName, args = []) {
    const hash = await wallets.get(account.toLowerCase()).writeContract({ address, abi: compiled.abi, functionName, args });
    return receipt(hash);
  }

  const bondToken = await deploy(tokenArtifact, ['Clearing Bell Bond 2028', 'CBB28', 18]);
  const settlementToken = await deploy(tokenArtifact, ['Local USD Coin', 'USDC', 6]);
  const identityRegistry = await deploy(registryArtifact);
  const complianceGate = await deploy(gateArtifact);
  const auctionEngine = await deploy(engineArtifact, [complianceGate, issuer]);
  await write(issuer, complianceGate, gateArtifact, 'registerRegistry', [bondToken, identityRegistry]);
  for (const account of [issuer, investor, seller, maker]) {
    await write(issuer, identityRegistry, registryArtifact, 'grant', [account]);
    await write(issuer, settlementToken, tokenArtifact, 'mint', [account, parseUnits('250000', 6)]);
    await write(issuer, bondToken, tokenArtifact, 'mint', [account, parseUnits('1000', 18)]);
  }
  // Historical buyer and liquidity providers approve settlement. The primary
  // investor's allowances are reset afterward so the UI can exercise approvals.
  for (const account of [investor, seller, maker]) {
    await write(account, settlementToken, tokenArtifact, 'approve', [auctionEngine, maxUint256]);
    await write(account, bondToken, tokenArtifact, 'approve', [auctionEngine, maxUint256]);
  }
  await write(issuer, auctionEngine, engineArtifact, 'openRound', [bondToken, settlementToken, 3600n]);
  await write(investor, auctionEngine, engineArtifact, 'submitBid', [1n, parseUnits('100', 6), parseUnits('40', 18), true]);
  await write(seller, auctionEngine, engineArtifact, 'submitBid', [1n, parseUnits('99.25', 6), parseUnits('40', 18), false]);
  await write(issuer, auctionEngine, engineArtifact, 'closeAndClear', [1n]);
  await write(investor, settlementToken, tokenArtifact, 'approve', [auctionEngine, 0n]);
  await write(investor, bondToken, tokenArtifact, 'approve', [auctionEngine, 0n]);

  await write(issuer, auctionEngine, engineArtifact, 'openRound', [bondToken, settlementToken, 86400n]);
  await write(maker, auctionEngine, engineArtifact, 'submitBid', [2n, parseUnits('100', 6), parseUnits('20', 18), true]);
  await write(seller, auctionEngine, engineArtifact, 'submitBid', [2n, parseUnits('99.38', 6), parseUnits('150', 18), false]);

  const manifest = {
    version: 1, network: 'local', chainId: 31337, rpcUrl, deploymentBlock,
    contracts: { auctionEngine, complianceGate, identityRegistry, bondToken, settlementToken },
    bond: { name: 'Clearing Bell Bond 2028', symbol: 'CBB28', decimals: 18, couponBps: 550, maturity: '2028-12-31' },
    settlement: { symbol: 'USDC', decimals: 6 }, roundIds: [1, 2],
    accounts: [
      { address: issuer, label: 'Issuer', role: 'issuer' },
      { address: investor, label: 'Investor', role: 'investor' },
      { address: seller, label: 'Bond seller', role: 'seller' },
      { address: restricted, label: 'Unverified account', role: 'restricted' },
      { address: maker, label: 'Liquidity provider', role: 'investor' },
    ],
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await copyFile(manifestPath, publicPath);
  for (const [name, compiled] of Object.entries({ AuctionEngine: engineArtifact, ComplianceGate: gateArtifact, ERC20: tokenArtifact, IdentityRegistry: registryArtifact })) {
    await writeFile(join(localDir, `${name}.abi.json`), `${JSON.stringify(compiled.abi, null, 2)}\n`);
  }
  const historicalRound = await client.readContract({ address: auctionEngine, abi: engineArtifact.abi, functionName: 'rounds', args: [1n] });
  if (historicalRound[4] !== 0 || historicalRound[6] !== parseUnits('40', 18)) throw new Error('Seeded historical settlement verification failed.');
  console.log(`Local auction deployed: ${auctionEngine}`);
  console.log('Round 1 settled 40 bonds at 99.25 USDC. Round 2 is open with two-sided liquidity.');
  console.log('Public configuration: frontend/public/deployment.json. No signing keys exported.');
}

main().catch(error => { console.error(error.shortMessage ?? error.message); process.exitCode = 1; });
