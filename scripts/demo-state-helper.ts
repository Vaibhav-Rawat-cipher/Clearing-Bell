/**
 * demo-state.ts — shared helper for all demo scripts
 *
 * Reads demo-state.json if it exists.
 * If it doesn't exist (or is stale), queries the chain for the
 * most recent open auction round automatically.
 */

import { createPublicClient, http, parseAbi, type Address } from "viem";
import { hederaTestnet } from "viem/chains";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import * as path from "path";

const ENGINE_ADDRESS = (process.env.AUCTION_ENGINE_ADDRESS || "0x663d1825f7a1eb323eb531152e23720c7f2ad7a2") as Address;
const RPC_URL = "https://testnet.hashio.io/api";

export type DemoState = {
  roundId: string;
  bondAddress: Address;
  registryAddress: Address;
  deadline: string;
  openedAt: string;
};

const ENGINE_ABI = parseAbi([
  "function nextRoundId() view returns (uint256)",
  "function rounds(uint256) view returns (uint256 id, address bondToken, address settlementToken, uint256 openDeadline, uint8 phase, uint256 clearingPrice, uint256 clearedQuantity, uint256 bidCount)",
]);

export async function loadDemoState(): Promise<DemoState> {
  const statePath = path.resolve(__dirname, "demo-state.json");

  // Try reading from file first
  if (existsSync(statePath)) {
    const state: DemoState = JSON.parse(readFileSync(statePath, "utf8"));
    console.log(`  📄  Loaded state from demo-state.json (Round #${state.roundId})`);
    return state;
  }

  // Fall back: scan chain for latest open round
  console.log("  ⚠️   demo-state.json not found — scanning chain for open rounds...");
  const pub = createPublicClient({ chain: hederaTestnet, transport: http(RPC_URL) });
  const nextId = await pub.readContract({ address: ENGINE_ADDRESS, abi: ENGINE_ABI, functionName: "nextRoundId" });

  // Scan last 20 rounds
  const start = nextId > 20n ? nextId - 20n : 1n;
  let latestOpen: DemoState | null = null;

  for (let id = nextId - 1n; id >= start; id--) {
    try {
      const r = await pub.readContract({ address: ENGINE_ADDRESS, abi: ENGINE_ABI, functionName: "rounds", args: [id] });
      const phase = r[4]; // 0=Closed, 1=Open, 2=Cleared
      if (phase === 1) {
        // Found an open round
        const state: DemoState = {
          roundId: id.toString(),
          bondAddress: r[1] as Address,
          registryAddress: "0x0000000000000000000000000000000000000000" as Address,
          deadline: r[3].toString(),
          openedAt: new Date().toISOString(),
        };
        latestOpen = state;
        break; // Take the most recent open round
      }
    } catch {}
  }

  if (!latestOpen) {
    throw new Error(
      "No open auction round found on-chain and demo-state.json missing.\n" +
      "Run 'npx tsx scripts/demo-open-round.ts' first."
    );
  }

  // Save it so subsequent scripts can reuse
  writeFileSync(statePath, JSON.stringify(latestOpen, null, 2));
  console.log(`  ✅  Found open Round #${latestOpen.roundId} on-chain — saved to demo-state.json`);
  console.log(`  Bond token: ${latestOpen.bondAddress}`);
  return latestOpen;
}
