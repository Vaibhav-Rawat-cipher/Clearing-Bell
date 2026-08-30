/**
 * open-round.ts
 *
 * Opens a new auction round on the deployed AuctionEngine and registers it
 * as the active round in the ClearingBellHook. Run this before each
 * demo auction.
 *
 * Prerequisites (env):
 *   AUCTION_ENGINE_ADDRESS, HOOK_ADDRESS, BOND_TOKEN_ADDRESS, USDC_ADDRESS
 *   DEPLOYER_PRIVATE_KEY (must be the issuer account)
 *   HEDERA_RPC_URL
 *
 * Usage:
 *   BID_WINDOW_SECONDS=3600 npx tsx scripts/open-round.ts
 */

import { config } from "dotenv";
import { createWalletClient, http, publicActions, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hederaTestnet } from "viem/chains";

config({ path: "../.env" });

const ENGINE_ADDRESS = process.env.AUCTION_ENGINE_ADDRESS! as `0x${string}`;
const HOOK_ADDRESS   = process.env.HOOK_ADDRESS!            as `0x${string}`;
const BOND_ADDRESS   = process.env.BOND_TOKEN_ADDRESS!      as `0x${string}`;
const USDC_ADDRESS   = process.env.USDC_ADDRESS!            as `0x${string}`;
const RPC_URL        = process.env.HEDERA_RPC_URL!;
const BID_WINDOW     = BigInt(process.env.BID_WINDOW_SECONDS ?? "3600");

const ENGINE_ABI = parseAbi([
  "function openRound(address bondToken, address settlementToken, uint256 bidWindow) returns (uint256)",
  "event RoundOpened(uint256 indexed roundId, address indexed bondToken, address settlementToken, uint256 openDeadline)",
]);

const HOOK_ABI = parseAbi([
  "function setActiveRound(address bondToken, uint256 roundId) external",
]);

async function main() {
  const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`);
  const client = createWalletClient({
    account,
    chain: hederaTestnet,
    transport: http(RPC_URL),
  }).extend(publicActions);

  console.log("=== Opening Auction Round ===");
  console.log(`Issuer  : ${account.address}`);
  console.log(`Engine  : ${ENGINE_ADDRESS}`);
  console.log(`Bond    : ${BOND_ADDRESS}`);
  console.log(`Window  : ${BID_WINDOW}s (${Number(BID_WINDOW) / 3600}h)`);

  // 1. Open round on engine
  const hash = await client.writeContract({
    address: ENGINE_ADDRESS,
    abi: ENGINE_ABI,
    functionName: "openRound",
    args: [BOND_ADDRESS, USDC_ADDRESS, BID_WINDOW],
  });

  const receipt = await client.waitForTransactionReceipt({ hash });

  // Parse RoundOpened event to get roundId
  const log = receipt.logs.find(
    (l) => l.address.toLowerCase() === ENGINE_ADDRESS.toLowerCase()
  );
  if (!log) throw new Error("RoundOpened event not found in receipt");

  // roundId is the first indexed topic (after the event signature)
  const roundId = BigInt(log.topics[1]!);
  const deadline = new Date(
    (Number(BigInt(log.data.slice(0, 66)) || 0)) * 1000
  ).toISOString();

  console.log(`\n✅ Round ${roundId} opened`);
  console.log(`   Deadline: ${deadline}`);
  console.log(`   Tx: https://hashscan.io/testnet/transaction/${hash}`);

  // 2. Register as active round in hook
  if (HOOK_ADDRESS && HOOK_ADDRESS !== "0x0000000000000000000000000000000000000000") {
    const hookHash = await client.writeContract({
      address: HOOK_ADDRESS,
      abi: HOOK_ABI,
      functionName: "setActiveRound",
      args: [BOND_ADDRESS, roundId],
    });
    await client.waitForTransactionReceipt({ hash: hookHash });
    console.log(`   Hook active round set ✅`);
  }

  console.log(`\nAdd to your .env: ACTIVE_ROUND_ID=${roundId}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
