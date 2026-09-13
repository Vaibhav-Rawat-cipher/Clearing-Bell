/**
 * demo-bid-alice.ts — DEMO STEP 2
 * Alice: BUY 100 CBDB bonds @ $105 limit
 * Usage: npx tsx scripts/demo-bid-alice.ts
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
const ALICE_KEY      = process.env.ALICE_PRIVATE_KEY as Hex;
if (!ALICE_KEY) throw new Error("Missing ALICE_PRIVATE_KEY in .env");

const ENGINE_ABI = parseAbi([
  "function submitBid(uint256 roundId, uint256 price, uint256 quantity, bool isBuy) external",
  "function rounds(uint256) view returns (uint256,address,address,uint256,uint8,uint256,uint256,uint256)",
  "event BidSubmitted(uint256 indexed roundId, address indexed bidder, uint256 price, uint256 quantity, bool isBuy, uint256 bidIndex)",
]);
const ERC20_ABI = parseAbi(["function approve(address spender, uint256 amount) external returns (bool)"]);

async function main() {
  const state = await loadDemoState();
  const roundId = BigInt(state.roundId);

  const account = privateKeyToAccount(ALICE_KEY);
  const wallet  = createWalletClient({ account, chain: hederaTestnet, transport: http("https://testnet.hashio.io/api") });
  const pub     = createPublicClient({ chain: hederaTestnet, transport: http("https://testnet.hashio.io/api") });

  // Verify round is still open
  const round = await pub.readContract({ address: ENGINE_ADDRESS, abi: ENGINE_ABI, functionName: "rounds", args: [roundId] });
  if (round[4] !== 1) throw new Error(`Round #${roundId} is not open (phase=${round[4]}). Run demo-open-round.ts first.`);

  const bondAddress = round[1] as Address;
  const price    = BigInt(Math.round(105 * 1_000_000));  // $105 USDC
  const quantity = 100n * 10n ** 18n;                    // 100 bonds

  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log(  "║  DEMO STEP 2 — Alice submits BUY bid                ║");
  console.log(  "╚══════════════════════════════════════════════════════╝\n");
  console.log(`  Round   : #${roundId}`);
  console.log(`  Alice   : ${account.address}`);
  console.log(`  Side    : BUY 100 bonds @ $105.00 limit\n`);

  // Ensure approval
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
  console.log("║  ✅  ALICE'S BID IS IN — check the frontend!         ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");
  console.log(`  BUY 100 CBDB @ $105.00  |  Order #${bidIndex + 1n}`);
  console.log(`  HashScan: https://hashscan.io/testnet/transaction/${hash}\n`);
  console.log("  ➜  Next: npx tsx scripts/demo-bid-bob.ts");
}
main().catch(e => { console.error("\n❌", e.shortMessage ?? e.message); if (e.cause) console.error("   Cause:", e.cause?.shortMessage ?? e.cause?.message); process.exit(1); });
