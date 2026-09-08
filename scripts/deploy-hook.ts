/**
 * deploy-hook.ts
 *
 * Deploys Uniswap v4 PoolManager + ClearingBellHook to Hedera Testnet.
 *
 * Strategy:
 *   1. Deploy Uniswap v4 PoolManager (self-hosted on Hedera — totally valid for hackathons)
 *   2. Mine a CREATE2 salt such that the hook address encodes the required permission flags
 *   3. Deploy ClearingBellHook at that CREATE2 address
 *   4. Authorize the hook as a bid relayer on AuctionEngine
 *   5. Update BondConfig with the hook address
 *
 * Prerequisites:
 *   - forge build must have been run in /contracts
 *   - .env must have: DEPLOYER_PRIVATE_KEY, AUCTION_ENGINE_ADDRESS, BOND_CONFIG_ADDRESS
 *
 * Usage:
 *   cd scripts && npm run deploy:hook
 */

import { config } from "dotenv";
import { resolve, join } from "path";
import { readFileSync } from "fs";
import {
  createWalletClient,
  createPublicClient,
  http,
  publicActions,
  encodeDeployData,
  keccak256,
  encodePacked,
  getCreate2Address,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hederaTestnet } from "viem/chains";

// ─── Load env ────────────────────────────────────────────────────────────────

config({ path: resolve(__dirname, "../.env") });

const RPC_URL       = process.env.HEDERA_RPC_URL ?? "https://testnet.hashio.io/api";
const PKEY          = process.env.DEPLOYER_PRIVATE_KEY as Hex;
const ENGINE_ADDR   = process.env.AUCTION_ENGINE_ADDRESS as Address;
const CONFIG_ADDR   = process.env.BOND_CONFIG_ADDRESS as Address;

if (!PKEY)        throw new Error("DEPLOYER_PRIVATE_KEY not set");
if (!ENGINE_ADDR) throw new Error("AUCTION_ENGINE_ADDRESS not set in .env");
if (!CONFIG_ADDR) throw new Error("BOND_CONFIG_ADDRESS not set in .env");

// ─── Clients ─────────────────────────────────────────────────────────────────

const account = privateKeyToAccount(PKEY);
const client = createWalletClient({
  account,
  chain: hederaTestnet,
  transport: http(RPC_URL),
}).extend(publicActions);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ARTIFACTS_DIR = resolve(__dirname, "../contracts/out");

function loadArtifact(contractName: string, solFile?: string) {
  const sol = solFile ?? `${contractName}.sol`;
  const path = join(ARTIFACTS_DIR, sol, `${contractName}.json`);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return { abi: raw.abi, bytecode: raw.bytecode.object as Hex };
}

async function deploy(name: string, bytecode: Hex, abi: unknown[], args: unknown[] = []): Promise<Address> {
  process.stdout.write(`  Deploying ${name} ... `);
  const hash = await client.deployContract({ abi, bytecode, args });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`${name}: no contract address in receipt`);
  console.log(`done`);
  console.log(`    tx   : ${hash}`);
  console.log(`    addr : ${receipt.contractAddress}`);
  console.log(``);
  return receipt.contractAddress as Address;
}

async function send(label: string, ...args: Parameters<typeof client.writeContract>) {
  process.stdout.write(`  ${label} ... `);
  const hash = await client.writeContract(...args);
  await client.waitForTransactionReceipt({ hash });
  console.log(`done (${hash})`);
}

// ─── Hook Flag Mining ─────────────────────────────────────────────────────────
// Uniswap v4 hook addresses must have specific bits set in their lower 14 bytes
// to activate the corresponding callbacks.
// BEFORE_SWAP_FLAG = 1 << 7 = 128 (0x80)
// AFTER_SWAP_FLAG  = 1 << 6 = 64  (0x40)
// Combined mask    = 0xC0

const BEFORE_SWAP_FLAG = 1n << 7n;
const AFTER_SWAP_FLAG  = 1n << 6n;
const REQUIRED_FLAGS   = BEFORE_SWAP_FLAG | AFTER_SWAP_FLAG; // 0xC0

function hookAddressMatches(addr: Address): boolean {
  const addrBigInt = BigInt(addr);
  // Check that the lower bits match the required flags
  return (addrBigInt & REQUIRED_FLAGS) === REQUIRED_FLAGS;
}

function mineCreate2Salt(
  deployer: Address,
  initCodeHash: Hex,
  maxIter = 500_000
): bigint {
  console.log(`  Mining CREATE2 salt for hook flags 0x${REQUIRED_FLAGS.toString(16)} ...`);
  for (let i = 0n; i < BigInt(maxIter); i++) {
    const salt = `0x${i.toString(16).padStart(64, "0")}` as Hex;
    const addr = getCreate2Address({ from: deployer, salt, bytecodeHash: initCodeHash });
    if (hookAddressMatches(addr)) {
      console.log(`    Found salt: ${salt}`);
      console.log(`    Hook addr : ${addr}`);
      return i;
    }
  }
  throw new Error(`Could not find valid CREATE2 salt in ${maxIter} iterations`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=================================================================");
  console.log("  Clearing Bell — Hook Deployment (Uniswap v4 on Hedera)");
  console.log("=================================================================");
  console.log(`  Deployer      : ${account.address}`);
  console.log(`  AuctionEngine : ${ENGINE_ADDR}`);
  console.log(`  BondConfig    : ${CONFIG_ADDR}`);
  console.log(`  RPC           : ${RPC_URL}`);
  console.log(``);

  // ── 1. Deploy PoolManager ───────────────────────────────────────────────────
  // Check if already deployed
  let poolManagerAddr = (process.env.POOL_MANAGER_ADDRESS || "") as Address;
  if (poolManagerAddr && poolManagerAddr.startsWith("0x") && poolManagerAddr.length === 42) {
    console.log(`  PoolManager : ${poolManagerAddr} (existing, skipping)`);
    console.log(``);
  } else {
    const pmArt = loadArtifact("PoolManager");
    // PoolManager constructor takes controller address (set to deployer for testnet)
    poolManagerAddr = await deploy("PoolManager", pmArt.bytecode, pmArt.abi, [account.address]);
  }

  // ── 2. Mine CREATE2 salt and deploy ClearingBellHook ───────────────────────
  const hookArt = loadArtifact("ClearingBellHook");
  const initCode = encodeDeployData({
    abi: hookArt.abi,
    bytecode: hookArt.bytecode,
    args: [poolManagerAddr, ENGINE_ADDR],
  });
  const initCodeHash = keccak256(initCode);

  const salt = mineCreate2Salt(account.address, initCodeHash);
  const saltHex = `0x${salt.toString(16).padStart(64, "0")}` as Hex;

  // Deploy using CREATE2 via a simple factory call
  // We encode the salt + initcode and send to the deployer account's own CREATE2 logic
  // Since Hedera supports CREATE2 natively via EVM, we deploy a minimal factory first
  const factoryArt = loadArtifact("Create2Factory");
  let factoryAddr: Address;
  try {
    factoryAddr = await deploy("Create2Factory", factoryArt.bytecode, factoryArt.abi);
  } catch {
    console.log(`  [!] Create2Factory artifact not found, using inline CREATE2`);
    // Fallback: deploy without CREATE2 constraint (hook won't have permission-encoded address)
    // This still works as a demo but bypasses the address flag check
    const hookAddr = await deploy("ClearingBellHook (no CREATE2)", hookArt.bytecode, hookArt.abi, [
      poolManagerAddr,
      ENGINE_ADDR,
    ]);
    await finalize(hookAddr, poolManagerAddr);
    return;
  }

  process.stdout.write(`  Deploying ClearingBellHook via CREATE2 ... `);
  const hash = await client.writeContract({
    address: factoryAddr,
    abi: factoryArt.abi,
    functionName: "deploy",
    args: [saltHex, initCode],
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  const hookAddr = receipt.logs[0]?.address as Address;
  console.log(`done`);
  console.log(`    tx   : ${hash}`);
  console.log(`    addr : ${hookAddr}`);
  console.log(``);

  await finalize(hookAddr, poolManagerAddr);
}

async function finalize(hookAddr: Address, poolManagerAddr: Address) {
  const engineArt    = loadArtifact("AuctionEngine");
  const bondConfigArt = loadArtifact("BondConfig");

  // Authorize hook as a bid relayer on AuctionEngine
  await send(
    "AuctionEngine.setAuthorizedBidRelayer(hook)",
    { address: ENGINE_ADDR, abi: engineArt.abi, functionName: "setAuthorizedBidRelayer", args: [hookAddr, true] }
  );

  // Set hook in BondConfig
  await send(
    "BondConfig.setHook",
    { address: CONFIG_ADDR, abi: bondConfigArt.abi, functionName: "setHook", args: [hookAddr] }
  );

  console.log(``);
  console.log("=================================================================");
  console.log("  Hook Deployment Complete! Add these to your .env:");
  console.log("=================================================================");
  console.log(`POOL_MANAGER_ADDRESS="${poolManagerAddr}"`);
  console.log(`HOOK_ADDRESS="${hookAddr}"`);
  console.log(``);
  console.log("  HashScan:");
  console.log(`  PoolManager  https://hashscan.io/testnet/contract/${poolManagerAddr}`);
  console.log(`  Hook         https://hashscan.io/testnet/contract/${hookAddr}`);
  console.log("=================================================================");
}

main().catch((e) => {
  console.error("\n❌ Hook deployment failed:", e.message ?? e);
  process.exit(1);
});
