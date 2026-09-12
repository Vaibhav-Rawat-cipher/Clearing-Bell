/**
 * deploy-stack.ts
 *
 * Deploys the Clearing Bell auction stack to Hedera Testnet using viem.
 * Uses cast/forge for compilation, viem for broadcasting (forge script has
 * a known RPC incompatibility with Hedera's hashio.io relay).
 *
 * Deploys:
 *   1. MockUSDC       — testnet settlement token (ERC-20, 6 dec)
 *   2. BondConfig     — registry linking bond → compliance → engine
 *   3. ComplianceGate — KYC gate for auction bids
 *   4. AuctionEngine  — Dutch auction / settlement engine
 *
 * Then wires BondConfig.configure() if BOND_TOKEN_ADDRESS is in .env.
 *
 * Usage:
 *   cd scripts && npm run deploy:stack
 *
 * Prerequisites:
 *   - forge build must have been run in /contracts
 *   - .env in repo root with DEPLOYER_PRIVATE_KEY
 */

import { config } from "dotenv";
import { resolve, join } from "path";
import { readFileSync } from "fs";
import {
  createWalletClient,
  createPublicClient,
  http,
  publicActions,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hederaTestnet } from "viem/chains";

// ─── Load env ────────────────────────────────────────────────────────────────

config({ path: resolve(__dirname, "../.env") });

const RPC_URL    = process.env.HEDERA_RPC_URL ?? "https://testnet.hashio.io/api";
const PKEY       = process.env.DEPLOYER_PRIVATE_KEY as Hex;
const BOND_TOKEN = (process.env.BOND_TOKEN_ADDRESS ?? "") as Hex;
const ATS_REG    = (process.env.ATS_IDENTITY_REGISTRY_ADDRESS || "0x0000000000000000000000000000000000000000") as Hex;

if (!PKEY) throw new Error("DEPLOYER_PRIVATE_KEY not set in .env");

// ─── Clients ─────────────────────────────────────────────────────────────────

const account = privateKeyToAccount(PKEY);
const client = createWalletClient({
  account,
  chain: hederaTestnet,
  transport: http(RPC_URL),
}).extend(publicActions);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ARTIFACTS_DIR = resolve(__dirname, "../contracts/out");

function loadArtifact(contractName: string) {
  const path = join(ARTIFACTS_DIR, `${contractName}.sol`, `${contractName}.json`);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return {
    abi: raw.abi,
    bytecode: raw.bytecode.object as Hex,
  };
}

async function deploy(
  name: string,
  bytecode: Hex,
  abi: unknown[],
  args: unknown[] = []
): Promise<Hex> {
  process.stdout.write(`  Deploying ${name} ... `);
  const hash = await client.deployContract({
    abi,
    bytecode,
    args,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`${name}: no contract address in receipt`);
  console.log(`done`);
  console.log(`    tx   : ${hash}`);
  console.log(`    addr : ${receipt.contractAddress}`);
  console.log(``);
  return receipt.contractAddress as Hex;
}

async function send(label: string, ...args: Parameters<typeof client.writeContract>) {
  process.stdout.write(`  ${label} ... `);
  const hash = await client.writeContract(...args);
  await client.waitForTransactionReceipt({ hash });
  console.log(`done (${hash})`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=================================================================");
  console.log("  Clearing Bell — Contract Deployment (viem / Hedera Testnet)");
  console.log("=================================================================");
  console.log(`  Deployer   : ${account.address}`);
  console.log(`  Bond token : ${BOND_TOKEN || "<not set>"}`);
  console.log(`  RPC        : ${RPC_URL}`);
  console.log(``);

  const usdcArt        = loadArtifact("MockERC20");
  const bondConfigArt  = loadArtifact("BondConfig");
  const gateArt        = loadArtifact("ComplianceGate");
  const engineArt      = loadArtifact("AuctionEngine");

  // 1. MockUSDC
  let usdcAddr = process.env.USDC_ADDRESS as Hex | undefined;
  if (usdcAddr && usdcAddr.startsWith("0x") && usdcAddr.length === 42) {
    console.log(`  MockUSDC    : ${usdcAddr} (existing, skipping)`);
    console.log(``);
  } else {
    usdcAddr = await deploy("MockUSDC", usdcArt.bytecode, usdcArt.abi, ["USD Coin", "USDC", 6]);
    // Mint 100M USDC to deployer for test seeding
    await send(
      "Minting 100M USDC to deployer",
      {
        address: usdcAddr,
        abi: usdcArt.abi,
        functionName: "mint",
        args: [account.address, 100_000_000n * 1_000_000n],
      }
    );
    console.log(``);
  }

  // 2. BondConfig
  const bondConfigAddr = await deploy("BondConfig", bondConfigArt.bytecode, bondConfigArt.abi);

  // 3. ComplianceGate
  const gateAddr = await deploy("ComplianceGate", gateArt.bytecode, gateArt.abi);

  // 4. AuctionEngine (needs ComplianceGate addr + platformAdmin)
  const engineAddr = await deploy("AuctionEngine", engineArt.bytecode, engineArt.abi, [
    gateAddr,
    account.address, // platformAdmin = deployer
  ]);

  // 4b. Wire up ComplianceGate -> AuctionEngine
  await send(
    "ComplianceGate.setAuctionEngine",
    {
      address: gateAddr,
      abi: gateArt.abi,
      functionName: "setAuctionEngine",
      args: [engineAddr],
    }
  );

  // 5. Wire up BondConfig if bond token is set
  if (BOND_TOKEN && BOND_TOKEN.startsWith("0x") && BOND_TOKEN.length === 42) {
    // Auto-register deployer as issuer for this bond (multi-issuer: deployer = first company)
    await send(
      "AuctionEngine.registerBondIssuer (deployer → CBB28)",
      {
        address: engineAddr,
        abi: engineArt.abi,
        functionName: "registerBondIssuer",
        args: [BOND_TOKEN, account.address],
      }
    );

    await send(
      "BondConfig.configure",
      {
        address: bondConfigAddr,
        abi: bondConfigArt.abi,
        functionName: "configure",
        args: [BOND_TOKEN, ATS_REG, gateAddr, engineAddr, usdcAddr],
      }
    );

    if (ATS_REG !== "0x0000000000000000000000000000000000000000") {
      await send(
        "ComplianceGate.registerRegistry",
        {
          address: gateAddr,
          abi: gateArt.abi,
          functionName: "registerRegistry",
          args: [BOND_TOKEN, ATS_REG],
        }
      );
    }
    console.log(``);
  } else {
    console.log(`  [!] BOND_TOKEN_ADDRESS not set — skipping BondConfig.configure()`);
    console.log(``);
  }

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log("=================================================================");
  console.log("  Deployment Complete! Add these to your .env:");
  console.log("=================================================================");
  console.log(`USDC_ADDRESS="${usdcAddr}"`);
  console.log(`BOND_CONFIG_ADDRESS="${bondConfigAddr}"`);
  console.log(`COMPLIANCE_GATE_ADDRESS="${gateAddr}"`);
  console.log(`AUCTION_ENGINE_ADDRESS="${engineAddr}"`);
  console.log(``);
  console.log(`  platformAdmin (deployer): ${account.address}`);
  if (BOND_TOKEN && BOND_TOKEN.startsWith("0x") && BOND_TOKEN.length === 42) {
    console.log(`  bondIssuers[${BOND_TOKEN}] = ${account.address}`);
    console.log(`  → Run 'register-issuer.ts' to grant issuer rights to a company wallet.`);
  }
  console.log("  HashScan:");
  console.log(`  MockUSDC       https://hashscan.io/testnet/contract/${usdcAddr}`);
  console.log(`  BondConfig     https://hashscan.io/testnet/contract/${bondConfigAddr}`);
  console.log(`  ComplianceGate https://hashscan.io/testnet/contract/${gateAddr}`);
  console.log(`  AuctionEngine  https://hashscan.io/testnet/contract/${engineAddr}`);
  console.log("=================================================================");
}

main().catch((e) => {
  console.error("\n❌ Deployment failed:", e.message ?? e);
  process.exit(1);
});
