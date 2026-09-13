/**
 * demo-close-and-clear.ts — DEMO STEP 5
 * Issuer closes the round. Reveals uniform clearing price + settlements.
 * Works with or without demo-state.json (auto-detects open round).
 * Usage: npx tsx scripts/demo-close-and-clear.ts
 */
import { config } from "dotenv";
import { createWalletClient, createPublicClient, http, parseAbi, decodeEventLog, type Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hederaTestnet } from "viem/chains";
import * as path from "path";
import { loadDemoState } from "./demo-state-helper";

config({ path: path.resolve(__dirname, "../.env") });

const ENGINE_ADDRESS = (process.env.AUCTION_ENGINE_ADDRESS || "0x663d1825f7a1eb323eb531152e23720c7f2ad7a2") as Address;
const DEPLOYER_KEY   = process.env.DEPLOYER_PRIVATE_KEY as Hex;
if (!DEPLOYER_KEY) throw new Error("Missing DEPLOYER_PRIVATE_KEY in .env");

const ENGINE_ABI = parseAbi([
  "function closeAndClear(uint256 roundId) external",
  "function rounds(uint256) view returns (uint256,address,address,uint256,uint8,uint256,uint256,uint256)",
  "event RoundCleared(uint256 indexed roundId, uint256 clearingPrice, uint256 clearedQuantity)",
  "event RoundClosedWithNoCrossing(uint256 indexed roundId)",
  "event Settled(uint256 indexed roundId, address indexed bidder, uint256 filledQuantity, uint256 settledPrice, bool isBuy)",
]);

function usd(raw: bigint)  { return `$${(Number(raw) / 1e6).toFixed(2)}`; }
function bond(raw: bigint) { return (Number(raw) / 1e18).toFixed(1); }

async function main() {
  const state = await loadDemoState();
  const roundId = BigInt(state.roundId);

  const account = privateKeyToAccount(DEPLOYER_KEY);
  const wallet  = createWalletClient({ account, chain: hederaTestnet, transport: http("https://testnet.hashio.io/api") });
  const pub     = createPublicClient({ chain: hederaTestnet, transport: http("https://testnet.hashio.io/api") });

  // Check round state
  const round = await pub.readContract({ address: ENGINE_ADDRESS, abi: ENGINE_ABI, functionName: "rounds", args: [roundId] });
  const phase = round[4];
  if (phase === 0n || phase === 2n) {
    console.log(`\n  Round #${roundId} is already closed (phase=${phase}).`);
    if (round[5] > 0n) {
      console.log(`  Clearing price was: ${usd(round[5])}  |  Matched: ${bond(round[6])} bonds`);
    }
    return;
  }

  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log(  "║  DEMO STEP 5 — Close & Clear (THE REVEAL)           ║");
  console.log(  "╚══════════════════════════════════════════════════════╝\n");
  console.log(`  Round    : #${roundId}`);
  console.log(`  Caller   : Issuer — ${account.address}`);
  console.log(`  Bids in  : ${round[7]}\n`);
  console.log("  Sealed order book (about to be revealed):");
  console.log("    BUY  Alice    : 100 bonds @ ????");
  console.log("    BUY  Deployer :  50 bonds @ ????");
  console.log("    SELL Bob      : 100 bonds @ ????\n");
  process.stdout.write("  Calling closeAndClear()... ");

  const hash = await wallet.writeContract({ address: ENGINE_ADDRESS, abi: ENGINE_ABI, functionName: "closeAndClear", args: [roundId], gas: 600_000n });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`TX reverted: ${hash}`);
  console.log("✅\n");

  let clearingPrice = 0n, clearedQty = 0n, noCrossing = false;
  const settlements: Array<{ bidder: string; qty: bigint; price: bigint; isBuy: boolean }> = [];
  for (const log of receipt.logs) {
    try {
      const d = decodeEventLog({ abi: ENGINE_ABI, ...log });
      if (d.eventName === "RoundCleared")           { clearingPrice = d.args.clearingPrice; clearedQty = d.args.clearedQuantity; }
      else if (d.eventName === "Settled")            { settlements.push({ bidder: d.args.bidder, qty: d.args.filledQuantity, price: d.args.settledPrice, isBuy: d.args.isBuy }); }
      else if (d.eventName === "RoundClosedWithNoCrossing") { noCrossing = true; }
    } catch {}
  }

  if (noCrossing) {
    console.log("  ⚠️  No crossing found — round closed with zero trades.\n");
    return;
  }

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  ✅  CLEARING PRICE REVEALED — check the frontend!   ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");
  console.log(`  UNIFORM CLEARING PRICE : ${usd(clearingPrice)} / bond`);
  console.log(`  MATCHED QUANTITY       : ${bond(clearedQty)} bonds\n`);
  console.log("  DvP Settlement (atomic — on-chain):");
  for (const s of settlements) {
    const usdAmt  = s.qty * s.price / 10n ** 18n;
    if (s.isBuy) console.log(`    🟢 BUY  ${s.bidder.slice(0,10)}...  paid ${usd(usdAmt)} USDC  →  received ${bond(s.qty)} CBDB bonds`);
    else         console.log(`    🔵 SELL ${s.bidder.slice(0,10)}...  sold ${bond(s.qty)} CBDB bonds  →  received ${usd(usdAmt)} USDC`);
  }
  console.log(`\n  Note: ALL trades clear at ${usd(clearingPrice)} regardless of limit price.`);
  console.log(`        Alice bid $105 — she pays only $95. Price improvement! ✨\n`);
  console.log(`  HashScan: https://hashscan.io/testnet/transaction/${hash}`);
  console.log(`  Engine  : https://hashscan.io/testnet/contract/${ENGINE_ADDRESS}\n`);
  console.log("  ➜  Next: npx tsx scripts/demo-hook-swap.ts");
}
main().catch(e => { console.error("\n❌", e.shortMessage ?? e.message); if (e.cause) console.error("   Cause:", e.cause?.shortMessage ?? e.cause?.message); process.exit(1); });
