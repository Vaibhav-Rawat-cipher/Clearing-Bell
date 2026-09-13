/**
 * demo-state-helper.ts — shared helper for all demo scripts
 *
 * Strategy (in order):
 *  1. Read demo-state.json if it exists
 *  2. Verify that saved round is still OPEN on-chain
 *  3. If closed/missing → scan the last 30 rounds for the latest open one
 *  4. Save the found round back to demo-state.json
 *
 * This means: open a round from the web UI or from the script — the
 * bid scripts will ALWAYS find the correct currently-open round.
 */

import { createPublicClient, http, parseAbi, type Address } from "viem";
import { hederaTestnet } from "viem/chains";
import { existsSync, readFileSync, writeFileSync } from "fs";
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

/** Scan the chain backwards for the most recent open round */
async function findOpenRoundOnChain(): Promise<DemoState> {
  const pub = createPublicClient({ chain: hederaTestnet, transport: http(RPC_URL) });
  const nextId = await pub.readContract({ address: ENGINE_ADDRESS, abi: ENGINE_ABI, functionName: "nextRoundId" });

  const lookback = 30n;
  const start = nextId > lookback ? nextId - lookback : 1n;

  console.log(`  🔍  Scanning rounds ${start}–${nextId - 1n} for an open round...`);

  for (let id = nextId - 1n; id >= start; id--) {
    try {
      const r = await pub.readContract({ address: ENGINE_ADDRESS, abi: ENGINE_ABI, functionName: "rounds", args: [id] });
      const phase = r[4]; // 0=Closed, 1=Open, 2=Cleared
      if (phase === 1) {
        const state: DemoState = {
          roundId: id.toString(),
          bondAddress: r[1] as Address,
          registryAddress: "0x0000000000000000000000000000000000000000" as Address,
          deadline: r[3].toString(),
          openedAt: new Date().toISOString(),
        };
        console.log(`  ✅  Found open Round #${id} on-chain — saving to demo-state.json`);
        console.log(`  Bond token : ${state.bondAddress}`);
        console.log(`  Deadline   : ${new Date(Number(r[3]) * 1000).toLocaleString()}`);
        return state;
      }
    } catch {}
  }

  throw new Error(
    "❌ No open auction round found on-chain.\n" +
    "   Open one via the web UI (Issuer page → Open Round)\n" +
    "   or run: npx tsx scripts/demo-open-round.ts"
  );
}

export async function loadDemoState(): Promise<DemoState> {
  const statePath = path.resolve(__dirname, "demo-state.json");

  // Step 1: Try loading saved state
  if (existsSync(statePath)) {
    const saved: DemoState = JSON.parse(readFileSync(statePath, "utf8"));
    console.log(`  📄  Found demo-state.json (Round #${saved.roundId}) — verifying on-chain...`);

    // Step 2: Verify the saved round is still open
    try {
      const pub = createPublicClient({ chain: hederaTestnet, transport: http(RPC_URL) });
      const r = await pub.readContract({
        address: ENGINE_ADDRESS, abi: ENGINE_ABI, functionName: "rounds", args: [BigInt(saved.roundId)],
      });
      const phase = r[4];
      if (phase === 1) {
        // ✅ Still open — use it
        console.log(`  ✅  Round #${saved.roundId} is open (phase=1). Ready to bid.`);
        return saved;
      } else {
        const phaseNames = ["Closed", "Open", "Cleared"];
        console.log(`  ⚠️   Round #${saved.roundId} is ${phaseNames[phase] ?? `phase=${phase}`} — scanning for a newer open round...`);
      }
    } catch (e: any) {
      console.log(`  ⚠️   Could not verify Round #${saved.roundId}: ${e.shortMessage ?? e.message}`);
    }
  } else {
    console.log("  ⚠️   demo-state.json not found — scanning chain for open round...");
  }

  // Step 3: Scan chain for latest open round
  const state = await findOpenRoundOnChain();

  // Step 4: Save updated state
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  return state;
}
