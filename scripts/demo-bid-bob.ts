/**
 * demo-bid-bob.ts — DEMO STEP 3
 * Bob: SELL 100 CBDB bonds @ $95 minimum
 * Usage: npx tsx scripts/demo-bid-bob.ts
 */
import { config } from "dotenv";
import { createWalletClient, createPublicClient, http, parseAbi, decodeEventLog, type Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hederaTestnet } from "viem/chains";
import * as path from "path";
import { loadDemoState } from "./demo-state-helper";

config({ path: path.resolve(__dirname, "../.env") });

const ENGINE_ADDRESS = (process.env.AUCTION_ENGINE_ADDRESS || "0x663d1825f7a1eb323eb531152e23720c7f2ad7a2") as Address;
const BOB_KEY        = process.env.BOB_PRIVATE_KEY as Hex;
if (!BOB_KEY) throw new Error("Missing BOB_PRIVATE_KEY in .env");

const ENGINE_ABI = parseAbi([
  "function submitBid(uint256 roundId, uint256 price, uint256 quantity, bool isBuy) external",
  "function rounds(uint256) view returns (uint256,address,address,uint256,uint8,uint256,uint256,uint256)",
  "event BidSubmitted(uint256 indexed roundId, address indexed bidder, uint256 price, uint256 quantity, bool isBuy, uint256 bidIndex)",
]);
const ERC20_ABI = parseAbi(["function approve(address spender, uint256 amount) external returns (bool)"]);

async function main() {
  const state = await loadDemoState();
  const roundId = BigInt(state.roundId);

  const account = privateKeyToAccount(BOB_KEY);
  const wallet  = createWalletClient({ account, chain: hederaTestnet, transport: http("https://testnet.hashio.io/api") });
  const pub     = createPublicClient({ chain: hederaTestnet, transport: http("https://testnet.hashio.io/api") });

  const round = await pub.readContract({ address: ENGINE_ADDRESS, abi: ENGINE_ABI, functionName: "rounds", args: [roundId] });
  if (round[4] !== 1) throw new Error(`Round #${roundId} is not open (phase=${round[4]})`);
  const bondAddress = round[1] as Address;

  const price    = BigInt(Math.round(95 * 1_000_000));  // $95 minimum
  const quantity = 100n * 10n ** 18n;

  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log(  "║  DEMO STEP 3 — Bob submits SELL bid                 ║");
  console.log(  "╚══════════════════════════════════════════════════════╝\n");
  console.log(`  Round  : #${roundId}`);
  console.log(`  Bob    : ${account.address}`);
  console.log(`  Side   : SELL 100 bonds @ $95.00 minimum\n`);

  // Ensure bond approval
  await pub.waitForTransactionReceipt({
    hash: await wallet.writeContract({ address: bondAddress, abi: ERC20_ABI, functionName: "approve", args: [ENGINE_ADDRESS, 2n ** 256n - 1n] }),
    timeout: 60_000,
  });

  process.stdout.write("  Submitting bid... ");
  const hash = await wallet.writeContract({ address: ENGINE_ADDRESS, abi: ENGINE_ABI, functionName: "submitBid", args: [roundId, price, quantity, false] });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`TX reverted: ${hash}`);

  let bidIndex = 0n;
  for (const log of receipt.logs) {
    try { const d = decodeEventLog({ abi: ENGINE_ABI, ...log }); if (d.eventName === "BidSubmitted") bidIndex = d.args.bidIndex; } catch {}
  }

  console.log("✅\n");
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  ✅  BOB'S BID IS IN — check the frontend!           ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");
  console.log(`  SELL 100 CBDB @ $95.00  |  Order #${bidIndex + 1n}`);
  console.log(`  HashScan: https://hashscan.io/testnet/transaction/${hash}\n`);
  console.log("  ➜  Next: npx tsx scripts/demo-bid-deployer.ts");
}
main().catch(e => { console.error("\n❌", e.shortMessage ?? e.message); if (e.cause) console.error("   Cause:", e.cause?.shortMessage ?? e.cause?.message); process.exit(1); });
