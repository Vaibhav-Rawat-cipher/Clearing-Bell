/**
 * register-issuer.ts
 *
 * Registers a company wallet as the authorized issuer for a bond token on
 * the multi-issuer AuctionEngine. Only the platformAdmin can call this.
 *
 * Prerequisites (.env):
 *   DEPLOYER_PRIVATE_KEY   — platform admin private key
 *   AUCTION_ENGINE_ADDRESS — deployed AuctionEngine address
 *   HEDERA_RPC_URL         — Hedera JSON-RPC relay URL
 *
 * Usage:
 *   BOND_TOKEN=0x...    ISSUER_WALLET=0x...   npx tsx register-issuer.ts
 *
 *   # Register deployer as issuer for CBB28 (demo convenience):
 *   BOND_TOKEN=$BOND_TOKEN_ADDRESS ISSUER_WALLET=$DEPLOYER_ADDRESS npx tsx register-issuer.ts
 *
 * References: PLAN.md §Vision-2 / multi-issuer platform
 */

import { config } from "dotenv";
import { resolve } from "path";
import { createWalletClient, http, publicActions, parseAbi, type Hex, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hederaTestnet } from "viem/chains";

config({ path: resolve(__dirname, "../.env") });

// ─── Config ──────────────────────────────────────────────────────────────────

const PKEY           = process.env.DEPLOYER_PRIVATE_KEY as Hex;
const ENGINE_ADDRESS = process.env.AUCTION_ENGINE_ADDRESS as Hex;
const RPC_URL        = process.env.HEDERA_RPC_URL ?? "https://testnet.hashio.io/api";
const BOND_TOKEN     = (process.env.BOND_TOKEN  ?? process.env.BOND_TOKEN_ADDRESS ?? "") as Hex;
const ISSUER_WALLET  = (process.env.ISSUER_WALLET ?? "") as Hex;

if (!PKEY)           throw new Error("DEPLOYER_PRIVATE_KEY not set in .env");
if (!ENGINE_ADDRESS) throw new Error("AUCTION_ENGINE_ADDRESS not set in .env");
if (!BOND_TOKEN || !BOND_TOKEN.startsWith("0x") || BOND_TOKEN.length !== 42)
  throw new Error("BOND_TOKEN env var missing or invalid (must be 0x-prefixed 42-char address)");
if (!ISSUER_WALLET || !ISSUER_WALLET.startsWith("0x") || ISSUER_WALLET.length !== 42)
  throw new Error("ISSUER_WALLET env var missing or invalid (must be 0x-prefixed 42-char address)");

// ─── ABI ─────────────────────────────────────────────────────────────────────

const ENGINE_ABI = parseAbi([
  "function platformAdmin() view returns (address)",
  "function bondIssuers(address bondToken) view returns (address)",
  "function registerBondIssuer(address bondToken, address company)",
  "event BondIssuerRegistered(address indexed bondToken, address indexed issuer)",
]);

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const account = privateKeyToAccount(PKEY);
  const client = createWalletClient({
    account,
    chain: hederaTestnet,
    transport: http(RPC_URL),
  }).extend(publicActions);

  console.log("=== Clearing Bell — Register Bond Issuer ===");
  console.log(`Caller (platformAdmin): ${account.address}`);
  console.log(`AuctionEngine         : ${ENGINE_ADDRESS}`);
  console.log(`Bond token            : ${BOND_TOKEN}`);
  console.log(`Issuer wallet         : ${ISSUER_WALLET}`);
  console.log("");

  // Verify caller is the platform admin
  const onChainAdmin = await client.readContract({
    address: ENGINE_ADDRESS,
    abi: ENGINE_ABI,
    functionName: "platformAdmin",
  });

  if (getAddress(onChainAdmin) !== getAddress(account.address)) {
    throw new Error(
      `Caller ${account.address} is not the platform admin.\n` +
      `On-chain platformAdmin: ${onChainAdmin}\n` +
      `Use the DEPLOYER_PRIVATE_KEY that matches the platform admin.`
    );
  }

  // Check current registration
  const currentIssuer = await client.readContract({
    address: ENGINE_ADDRESS,
    abi: ENGINE_ABI,
    functionName: "bondIssuers",
    args: [BOND_TOKEN],
  });

  if (currentIssuer !== "0x0000000000000000000000000000000000000000") {
    console.log(`⚠️  Bond already has issuer: ${currentIssuer}`);
    console.log(`   Proceeding to overwrite with: ${ISSUER_WALLET}`);
    console.log("");
  }

  // Register
  process.stdout.write("Sending registerBondIssuer() ... ");
  const hash = await client.writeContract({
    address: ENGINE_ADDRESS,
    abi: ENGINE_ABI,
    functionName: "registerBondIssuer",
    args: [BOND_TOKEN, ISSUER_WALLET],
  });
  await client.waitForTransactionReceipt({ hash });
  console.log("done ✅");
  console.log(`  Tx: ${hash}`);
  console.log(`  HashScan: https://hashscan.io/testnet/transaction/${hash}`);

  // Verify
  const confirmed = await client.readContract({
    address: ENGINE_ADDRESS,
    abi: ENGINE_ABI,
    functionName: "bondIssuers",
    args: [BOND_TOKEN],
  });
  console.log("");
  console.log(`Verified bondIssuers[${BOND_TOKEN}] = ${confirmed}`);

  if (getAddress(confirmed) !== getAddress(ISSUER_WALLET)) {
    throw new Error("Verification failed — on-chain value does not match expected issuer wallet");
  }

  console.log("");
  console.log("=== Done ===");
  console.log(`The wallet ${ISSUER_WALLET} can now call openRound() for bond ${BOND_TOKEN}`);
}

main().catch((e) => { console.error("❌", e.message ?? e); process.exit(1); });
