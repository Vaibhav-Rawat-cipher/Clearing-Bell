/**
 * demo-bid-deployer.ts — DEMO STEP 4
 * Deployer: BUY 50 CBDB bonds @ $100 limit
 * Usage: npx tsx scripts/demo-bid-deployer.ts
 */
import { config } from "dotenv";
import { createWalletClient, createPublicClient, http, parseAbi, decodeEventLog, type Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hederaTestnet } from "viem/chains";
import * as path from "path";
import { loadDemoState } from "./demo-state-helper";

config({ path: path.resolve(__dirname, "../.env") });

const ENGINE_ADDRESS = (process.env.AUCTION_ENGINE_ADDRESS || "0x663d1825f7a1eb323eb531152e23720c7f2ad7a2") as Address;
const USDC_ADDRESS   = (process.env.USDC_ADDRESS           || "0x37a4ae6511f491c5a07fbf61f6cf8b292727d255") as Address;
const DEPLOYER_KEY   = process.env.DEPLOYER_PRIVATE_KEY as Hex;
if (!DEPLOYER_KEY) throw new Error("Missing DEPLOYER_PRIVATE_KEY in .env");

const ENGINE_ABI = parseAbi([
  "function submitBid(uint256 roundId, uint256 price, uint256 quantity, bool isBuy) external",
  "function rounds(uint256) view returns (uint256,address,address,uint256,uint8,uint256,uint256,uint256)",
  "event BidSubmitted(uint256 indexed roundId, address indexed bidder, uint256 price, uint256 quantity, bool isBuy, uint256 bidIndex)",
]);
const ERC20_ABI = parseAbi(["function approve(address spender, uint256 amount) external returns (bool)"]);

async function main() {
  const state = await loadDemoState();
  const roundId = BigInt(state.roundId);

  const account = privateKeyToAccount(DEPLOYER_KEY);
  const wallet  = createWalletClient({ account, chain: hederaTestnet, transport: http("https://testnet.hashio.io/api") });
  const pub     = createPublicClient({ chain: hederaTestnet, transport: http("https://testnet.hashio.io/api") });

  const round = await pub.readContract({ address: ENGINE_ADDRESS, abi: ENGINE_ABI, functionName: "rounds", args: [roundId] });
  if (round[4] !== 1) throw new Error(`Round #${roundId} is not open (phase=${round[4]})`);

  const price    = BigInt(Math.round(100 * 1_000_000));  // $100 limit
  const quantity = 50n * 10n ** 18n;                     // 50 bonds

  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log(  "║  DEMO STEP 4 — Deployer submits BUY bid             ║");
  console.log(  "╚══════════════════════════════════════════════════════╝\n");
  console.log(`  Round    : #${roundId}`);
  console.log(`  Deployer : ${account.address}`);
  console.log(`  Side     : BUY 50 bonds @ $100.00 limit\n`);

  await pub.waitForTransactionReceipt({
    hash: await wallet.writeContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "approve", args: [ENGINE_ADDRESS, 2n ** 256n - 1n] }),
    timeout: 60_000,
  });

  process.stdout.write("  Submitting bid... ");
  const hash = await wallet.writeContract({ address: ENGINE_ADDRESS, abi: ENGINE_ABI, functionName: "submitBid", args: [roundId, price, quantity, true] });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`TX reverted: ${hash}`);

  let bidIndex = 0n;
  for (const log of receipt.logs) {
    try { const d = decodeEventLog({ abi: ENGINE_ABI, ...log }); if (d.eventName === "BidSubmitted") bidIndex = d.args.bidIndex; } catch {}
  }

  console.log("✅\n");
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  ✅  3 BIDS IN — order book is sealed! Check UI!     ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");
  console.log("  Live order book (sealed — prices hidden from UI):");
  console.log("    BUY  Alice    : 100 bonds @ $105");
  console.log("    BUY  Deployer :  50 bonds @ $100");
  console.log("    SELL Bob      : 100 bonds @  $95\n");
  console.log("  Clearing preview: expected price = $95 (lowest crossing)");
  console.log(`  Order #${bidIndex + 1n}  |  HashScan: https://hashscan.io/testnet/transaction/${hash}\n`);
  console.log("  ➜  Next: npx tsx scripts/demo-close-and-clear.ts");
}
main().catch(e => { console.error("\n❌", e.shortMessage ?? e.message); if (e.cause) console.error("   Cause:", e.cause?.shortMessage ?? e.cause?.message); process.exit(1); });
