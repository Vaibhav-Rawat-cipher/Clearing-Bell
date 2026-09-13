/**
 * sync-demo-state.ts — Run this any time to sync demo-state.json
 * with whatever round is currently OPEN on-chain.
 *
 * Use this after opening a round from the web UI:
 *   npx tsx scripts/sync-demo-state.ts
 *
 * Then proceed with:
 *   npx tsx scripts/demo-bid-alice.ts
 */

import { config } from "dotenv";
import * as path from "path";

config({ path: path.resolve(__dirname, "../.env") });

// loadDemoState() already does exactly what we need:
// - if demo-state.json has a closed round → scans chain → updates file
// - if no file → scans chain → creates file
import { loadDemoState } from "./demo-state-helper";

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log(  "║  Syncing demo-state.json with current open round    ║");
  console.log(  "╚══════════════════════════════════════════════════════╝\n");

  const state = await loadDemoState();

  console.log(`\n  ✅  demo-state.json is up to date.`);
  console.log(`  Active Round : #${state.roundId}`);
  console.log(`  Bond token   : ${state.bondAddress}`);
  console.log(`  Deadline     : ${new Date(Number(state.deadline) * 1000).toLocaleString()}`);
  console.log(`\n  ➜  Now run: npx tsx scripts/demo-bid-alice.ts`);
}

main().catch(e => {
  console.error("\n❌", e.shortMessage ?? e.message);
  process.exit(1);
});
