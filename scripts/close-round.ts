/**
 * close-round.ts
 *
 * Closes an open auction round (calls AuctionEngine.closeAndClear),
 * then signals the hook to sync the clearing price (afterEpochClose).
 *
 * Can be called permissionlessly after the bid window expires,
 * or by the issuer at any time to force-close early.
 *
 * Prerequisites (env):
 *   AUCTION_ENGINE_ADDRESS, HOOK_ADDRESS, BOND_TOKEN_ADDRESS
 *   DEPLOYER_PRIVATE_KEY, HEDERA_RPC_URL, ACTIVE_ROUND_ID
 *
 * Usage:
 *   ACTIVE_ROUND_ID=1 npx tsx scripts/close-round.ts
 */

import { config } from "dotenv";
import { createWalletClient, http, publicActions, parseAbi, decodeEventLog } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hederaTestnet } from "viem/chains";

config({ path: "../.env" });

const ENGINE_ADDRESS = process.env.AUCTION_ENGINE_ADDRESS! as `0x${string}`;
const HOOK_ADDRESS   = process.env.HOOK_ADDRESS!            as `0x${string}`;
const BOND_ADDRESS   = process.env.BOND_TOKEN_ADDRESS!      as `0x${string}`;
const RPC_URL        = process.env.HEDERA_RPC_URL!;
const ROUND_ID       = BigInt(process.env.ACTIVE_ROUND_ID ?? "1");

const ENGINE_ABI = parseAbi([
  "function closeAndClear(uint256 roundId) external",
  "function rounds(uint256 roundId) external view returns (uint256 id, address bondToken, address settlementToken, uint256 openDeadline, uint8 phase, uint256 clearingPrice, uint256 clearedQuantity, uint256 bidCount)",
  "event RoundCleared(uint256 indexed roundId, uint256 clearingPrice, uint256 clearedQuantity)",
  "event RoundClosedWithNoCrossing(uint256 indexed roundId)",
]);

const HOOK_ABI = parseAbi([
  "function afterEpochClose(uint256 roundId, address bondToken) external",
]);

async function main() {
  const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`);
  const client = createWalletClient({
    account,
    chain: hederaTestnet,
    transport: http(RPC_URL),
  }).extend(publicActions);

  console.log("=== Closing Auction Round ===");
  console.log(`Caller  : ${account.address}`);
  console.log(`Engine  : ${ENGINE_ADDRESS}`);
  console.log(`Round   : ${ROUND_ID}`);

  // 1. Close and clear
  const hash = await client.writeContract({
    address: ENGINE_ADDRESS,
    abi: ENGINE_ABI,
    functionName: "closeAndClear",
    args: [ROUND_ID],
  });

  const receipt = await client.waitForTransactionReceipt({ hash });
  console.log(`\n✅ closeAndClear tx: https://hashscan.io/testnet/transaction/${hash}`);

  // 2. Parse events to determine outcome
  let cleared = false;
  let clearingPrice = 0n;
  let clearedQty    = 0n;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ENGINE_ADDRESS.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: ENGINE_ABI, ...log });
      if (decoded.eventName === "RoundCleared") {
        cleared       = true;
        clearingPrice = decoded.args.clearingPrice;
        clearedQty    = decoded.args.clearedQuantity;
      } else if (decoded.eventName === "RoundClosedWithNoCrossing") {
        console.log("   ⚠️  No crossing — round closed with no trades.");
      }
    } catch { /* other events */ }
  }

  if (cleared) {
    const priceUSDC = Number(clearingPrice) / 1e6;
    const qtyTokens = Number(clearedQty) / 1e18;
    console.log(`   Clearing price : $${priceUSDC.toFixed(2)} USDC`);
    console.log(`   Cleared qty    : ${qtyTokens.toFixed(4)} CBB28`);
    console.log(`   Settlement     : $${(priceUSDC * qtyTokens).toFixed(2)} USDC total`);

    // 3. Sync hook clearing price
    if (HOOK_ADDRESS && HOOK_ADDRESS !== "0x0000000000000000000000000000000000000000") {
      const hookHash = await client.writeContract({
        address: HOOK_ADDRESS,
        abi: HOOK_ABI,
        functionName: "afterEpochClose",
        args: [ROUND_ID, BOND_ADDRESS],
      });
      await client.waitForTransactionReceipt({ hash: hookHash });
      console.log(`   Hook clearing price synced ✅`);
    }
  }

  // 4. Print final round state
  const [, , , deadline, phase, cp, cq] = await client.readContract({
    address: ENGINE_ADDRESS,
    abi: ENGINE_ABI,
    functionName: "rounds",
    args: [ROUND_ID],
  });

  const phaseNames = ["Closed", "Open", "Cleared"];
  console.log(`\n   Final round state: ${phaseNames[phase] ?? "Unknown"}`);
  console.log(`   HashScan (round): https://hashscan.io/testnet/contract/${ENGINE_ADDRESS}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
