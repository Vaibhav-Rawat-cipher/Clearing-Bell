/**
 * submit-bid.ts
 *
 * Submits a bid to the active auction round from a buyer wallet.
 *
 * Usage (from scripts/):
 *   BIDDER=alice PRICE=98 QTY=10000  npm run bid
 *   BIDDER=bob   PRICE=97 QTY=5000   npm run bid
 *
 * BIDDER = alice | bob | carol (maps to *_PRIVATE_KEY in .env)
 * PRICE  = limit price in USDC per bond token (e.g. 98 = $98.00)
 * QTY    = bond quantity to bid for (whole tokens)
 */

import { config } from "dotenv";
import { createWalletClient, http, publicActions, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hederaTestnet } from "viem/chains";

config({ path: "../.env" });

// ─── Args ─────────────────────────────────────────────────────────────────────

const BIDDER_NAME = (process.env.BIDDER ?? "alice").toLowerCase();
const PRICE_USD   = parseFloat(process.env.PRICE ?? "98");   // e.g. 98 = $98
const QTY_TOKENS  = parseFloat(process.env.QTY   ?? "10000"); // whole bond tokens
const IS_LIMIT    = (process.env.LIMIT ?? "true") === "true";

const BIDDER_KEY_MAP: Record<string, string | undefined> = {
  alice: process.env.ALICE_PRIVATE_KEY,
  bob:   process.env.BOB_PRIVATE_KEY,
  carol: process.env.CAROL_PRIVATE_KEY,
};

const BIDDER_KEY = BIDDER_KEY_MAP[BIDDER_NAME];
if (!BIDDER_KEY) throw new Error(`Unknown bidder "${BIDDER_NAME}" or key not in .env`);

const ENGINE_ADDRESS = process.env.AUCTION_ENGINE_ADDRESS! as `0x${string}`;
const ROUND_ID       = BigInt(process.env.ACTIVE_ROUND_ID ?? "1");
const RPC_URL        = process.env.HEDERA_RPC_URL ?? "https://testnet.hashio.io/api";

// ─── ABI ──────────────────────────────────────────────────────────────────────

const ENGINE_ABI = parseAbi([
  "function submitBid(uint256 roundId, uint256 limitPrice, uint256 quantity, bool isLimit) external",
  "event BidSubmitted(uint256 indexed roundId, address indexed bidder, uint256 limitPrice, uint256 quantity, bool isLimit)",
]);

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const account = privateKeyToAccount(BIDDER_KEY as Hex);
  const client  = createWalletClient({
    account,
    chain: hederaTestnet,
    transport: http(RPC_URL),
  }).extend(publicActions);

  // Convert to contract units:
  //   limitPrice → USDC with 6 decimals (e.g. $98.00 → 98_000_000)
  //   quantity   → bond token with 18 decimals (e.g. 10000 → 10000 * 1e18)
  const limitPrice = BigInt(Math.round(PRICE_USD * 1_000_000));
  const quantity   = BigInt(Math.round(QTY_TOKENS)) * BigInt(1e18);

  console.log("=================================================================");
  console.log("  Clearing Bell — Submit Bid");
  console.log("=================================================================");
  console.log(`  Bidder   : ${BIDDER_NAME} (${account.address})`);
  console.log(`  Round    : ${ROUND_ID}`);
  console.log(`  Price    : $${PRICE_USD.toFixed(2)} USDC per bond`);
  console.log(`  Qty      : ${QTY_TOKENS.toLocaleString()} CBB28`);
  console.log(`  Type     : ${IS_LIMIT ? "Limit" : "Market"}`);
  console.log(`  Engine   : ${ENGINE_ADDRESS}`);
  console.log("");

  const hash = await client.writeContract({
    address: ENGINE_ADDRESS,
    abi: ENGINE_ABI,
    functionName: "submitBid",
    args: [ROUND_ID, limitPrice, quantity, IS_LIMIT],
  });

  const receipt = await client.waitForTransactionReceipt({ hash });

  if (receipt.status !== "success") {
    throw new Error(`Bid tx reverted: ${hash}`);
  }

  console.log(`  ✅ Bid submitted!`);
  console.log(`  Tx : https://hashscan.io/testnet/tx/${hash}`);
  console.log("=================================================================");
}

main().catch((e) => {
  console.error("\n❌ Bid failed:", e.shortMessage ?? e.message ?? e);
  process.exit(1);
});
