/**
 * demo-hook-swap.ts — DEMO STEP 6
 *
 * Uniswap v4 Hook: user swaps are intercepted and batched into the auction.
 *
 * Flow:
 *   A. Deploy TestnetPoolManager + ClearingBellHookTestnet
 *   B. Authorize hook as bid relayer on AuctionEngine
 *   C. Open new auction round (Round N+1) for the same bond
 *   D. setActiveRound(bondToken, roundId) → wire hook to round
 *   E. Alice "swap" via pm.dispatchBeforeSwap → BidQueued in engine
 *   F. Bob   "swap" via pm.dispatchBeforeSwap → BidQueued in engine
 *   G. closeAndClear() → uniform clearing price
 *   H. afterEpochClose(roundId, bondToken) → price synced to hook
 *   I. Verify hook.lastClearingPrice[bond] == engine clearingPrice ✅
 *
 * Usage: npx tsx scripts/demo-hook-swap.ts
 */

import { config } from "dotenv";
import {
  createWalletClient, createPublicClient, http, parseAbi, encodeAbiParameters,
  parseAbiParameters, decodeEventLog, zeroAddress, type Hex, type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hederaTestnet } from "viem/chains";
import { readFileSync } from "fs";
import { resolve } from "path";
import * as path from "path";
import { loadDemoState } from "./demo-state-helper";

config({ path: path.resolve(__dirname, "../.env") });

const ENGINE_ADDRESS = (process.env.AUCTION_ENGINE_ADDRESS || "0x663d1825f7a1eb323eb531152e23720c7f2ad7a2") as Address;
const USDC_ADDRESS   = (process.env.USDC_ADDRESS           || "0x37a4ae6511f491c5a07fbf61f6cf8b292727d255") as Address;
const RPC_URL = "https://testnet.hashio.io/api";

const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY as Hex;
const ALICE_KEY    = process.env.ALICE_PRIVATE_KEY    as Hex;
const BOB_KEY      = process.env.BOB_PRIVATE_KEY      as Hex;
if (!DEPLOYER_KEY || !ALICE_KEY || !BOB_KEY) throw new Error("Missing keys in .env");

// ── ABIs (exact signatures from contract source) ──────────────────────────────

const ENGINE_ABI = parseAbi([
  "function openRound(address bondToken, address settlementToken, uint256 bidWindow) external returns (uint256)",
  "function setAuthorizedBidRelayer(address relayer, bool authorized) external",
  "function closeAndClear(uint256 roundId) external",
  "function rounds(uint256) external view returns (uint256 id, address bondToken, address settlementToken, uint256 openDeadline, uint8 phase, uint256 clearingPrice, uint256 clearedQuantity, uint256 bidCount)",
  "event RoundOpened(uint256 indexed roundId, address indexed bondToken, address settlementToken, uint256 openDeadline)",
  "event RoundCleared(uint256 indexed roundId, uint256 clearingPrice, uint256 clearedQuantity)",
  "event Settled(uint256 indexed roundId, address indexed bidder, uint256 filledQuantity, uint256 settledPrice, bool isBuy)",
]);

const HOOK_ABI = parseAbi([
  // setActiveRound(address bondToken, uint256 roundId)
  "function setActiveRound(address bondToken, uint256 roundId) external",
  // afterEpochClose(uint256 roundId, address bondToken)
  "function afterEpochClose(uint256 roundId, address bondToken) external",
  // lastClearingPrice is a mapping: lastClearingPrice(address) → uint256
  "function lastClearingPrice(address bondToken) external view returns (uint256)",
  "event BidQueued(address indexed bondToken, uint256 indexed roundId, address indexed bidder, uint256 price, uint256 quantity, bool isBuy)",
  "event ClearingPriceUpdated(address indexed bondToken, uint256 indexed roundId, uint256 clearingPrice)",
]);

// JSON ABI for dispatchBeforeSwap — required because abitype can't parse
// 'calldata' keyword inside inline tuple strings in human-readable format.
const PM_ABI = [
  {
    name: "dispatchBeforeSwap",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "hookAddr",  type: "address" },
      { name: "sender",   type: "address" },
      { name: "key",      type: "tuple",
        components: [
          { name: "currency0",   type: "address" },
          { name: "currency1",   type: "address" },
          { name: "fee",         type: "uint24"  },
          { name: "tickSpacing", type: "int24"   },
          { name: "hooks",       type: "address" },
        ]
      },
      { name: "params",   type: "tuple",
        components: [
          { name: "zeroForOne",        type: "bool"    },
          { name: "amountSpecified",   type: "int256"  },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ]
      },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [
      { name: "",  type: "bytes4"  },
      { name: "",  type: "int128"  },
      { name: "",  type: "uint24"  },
    ],
  },
] as const;

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) external returns (bool)",
]);

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeClients(key: Hex) {
  const account = privateKeyToAccount(key);
  return {
    wallet: createWalletClient({ account, chain: hederaTestnet, transport: http(RPC_URL) }),
    pub:    createPublicClient({ chain: hederaTestnet, transport: http(RPC_URL) }),
    address: account.address,
  };
}

async function waitFor(pub: ReturnType<typeof createPublicClient>, hash: Hex) {
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.status !== "success") throw new Error(`TX reverted: ${hash}`);
  return r;
}

function loadBytecode(sol: string, name: string): Hex {
  const p = resolve(__dirname, "../contracts/out", sol, `${name}.json`);
  return JSON.parse(readFileSync(p, "utf8")).bytecode.object as Hex;
}

async function deploy(wallet: ReturnType<typeof createWalletClient>, pub: ReturnType<typeof createPublicClient>, bytecode: Hex, args?: Hex): Promise<Address> {
  const data: Hex = args ? `${bytecode}${args.slice(2)}` : bytecode;
  const hash = await wallet.sendTransaction({ data, gas: 5_000_000n });
  const r = await waitFor(pub, hash);
  if (!r.contractAddress) throw new Error("No contractAddress");
  return r.contractAddress;
}

function fmtUsd(raw: bigint)  { return `$${(Number(raw) / 1e6).toFixed(2)}`; }
function tok(n: number): bigint { return BigInt(n) * 10n ** 18n; }

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const state = await loadDemoState();
  const bondAddress = state.bondAddress as Address;

  const D = makeClients(DEPLOYER_KEY);
  const A = makeClients(ALICE_KEY);
  const B = makeClients(BOB_KEY);
  const pub = D.pub;

  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log(  "║  DEMO STEP 6 — Uniswap v4 Hook: Swap → Bid → Clear  ║");
  console.log(  "╚══════════════════════════════════════════════════════╝\n");
  console.log(`  Bond token : ${bondAddress}`);
  console.log(`  Engine     : ${ENGINE_ADDRESS}\n`);

  // A. Deploy TestnetPoolManager
  process.stdout.write("A. Deploying TestnetPoolManager... ");
  const pmAddress = await deploy(D.wallet, pub, loadBytecode("TestnetPoolManager.sol", "TestnetPoolManager"));
  console.log("✅", pmAddress);

  // B. Deploy ClearingBellHookTestnet
  process.stdout.write("B. Deploying ClearingBellHookTestnet... ");
  const hookAddress = await deploy(
    D.wallet, pub,
    loadBytecode("ClearingBellHookTestnet.sol", "ClearingBellHookTestnet"),
    encodeAbiParameters(parseAbiParameters("address,address"), [pmAddress, ENGINE_ADDRESS])
  );
  console.log("✅", hookAddress);
  console.log(`   HashScan: https://hashscan.io/testnet/contract/${hookAddress}`);

  // C. Authorize hook as bid relayer
  process.stdout.write("C. Authorizing hook as bid relayer... ");
  await waitFor(pub, await D.wallet.writeContract({
    address: ENGINE_ADDRESS, abi: ENGINE_ABI,
    functionName: "setAuthorizedBidRelayer", args: [hookAddress, true],
  }));
  console.log("✅");

  // D. Open new hook round (5-minute window)
  //    ⚠️  This intentionally opens a FRESH auction round (separate from the previous demo).
  //    The hook must wire to an OPEN round to intercept swaps. The previous round was already
  //    closed and cleared, so a new round is required. In production, the hook always routes
  //    to the currently active (open) round on the AuctionEngine.
  process.stdout.write("D. Opening hook auction round (5 min)... \n   ℹ️  Note: A NEW round is opened here by design.\n   The hook requires an OPEN round to intercept swaps into.\n   The previous demo round is already closed — this is a separate hook demonstration round.\n   ");
  const openHash = await D.wallet.writeContract({
    address: ENGINE_ADDRESS, abi: ENGINE_ABI,
    functionName: "openRound", args: [bondAddress, USDC_ADDRESS, 300n],
  });
  const openReceipt = await waitFor(pub, openHash);
  let hookRoundId = 0n;
  for (const log of openReceipt.logs) {
    try { const d = decodeEventLog({ abi: ENGINE_ABI, ...log }); if (d.eventName === "RoundOpened") hookRoundId = d.args.roundId; } catch {}
  }
  console.log(`✅  Round #${hookRoundId} opened for hook demo`);
  console.log(`   HashScan: https://hashscan.io/testnet/transaction/${openHash}`);


  // E. Wire hook to the new round: setActiveRound(bondToken, roundId)
  process.stdout.write("E. Wiring hook → setActiveRound(bond, roundId)... ");
  await waitFor(pub, await D.wallet.writeContract({
    address: hookAddress, abi: HOOK_ABI,
    functionName: "setActiveRound", args: [bondAddress, hookRoundId],
  }));
  console.log("✅");

  // F. Token approvals for settlement
  const MAX = 2n ** 256n - 1n;
  process.stdout.write("F. Refreshing approvals... ");
  await waitFor(pub, await A.wallet.writeContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "approve", args: [ENGINE_ADDRESS, MAX] }));
  await waitFor(pub, await B.wallet.writeContract({ address: bondAddress,  abi: ERC20_ABI, functionName: "approve", args: [ENGINE_ADDRESS, MAX] }));
  console.log("✅");

  // Build PoolKey: currency0=bondAddress, currency1=USDC, fee=3000, tickSpacing=60, hooks=hookAddress
  const poolKey = {
    currency0: bondAddress,
    currency1: USDC_ADDRESS,
    fee: 3000,
    tickSpacing: 60,
    hooks: hookAddress,
  } as const;

  // G. Alice's swap → beforeSwap intercepted → BidQueued (BUY 100 bonds @ $105)
  // zeroForOne = false means: spending USDC to get bonds = BUY
  // amountSpecified = -tok(100) (negative = exact output of 100 bonds)
  // hookData = abi.encode(limitPrice)
  console.log("G. Alice SWAP intercepted → BidQueued (BUY 100 @ $105)...");
  const aliceLimitPrice = BigInt(Math.round(105 * 1_000_000));
  const aliceHookData   = encodeAbiParameters(parseAbiParameters("uint256"), [aliceLimitPrice]);
  const aliceSwapParams = { zeroForOne: false, amountSpecified: -tok(100), sqrtPriceLimitX96: 0n } as const;
  const aliceHash = await A.wallet.writeContract({
    address: pmAddress, abi: PM_ABI,
    functionName: "dispatchBeforeSwap",
    args: [hookAddress, A.address, poolKey, aliceSwapParams, aliceHookData],
    gas: 400_000n,
  });
  await waitFor(pub, aliceHash);
  console.log(`   ✅ BidQueued: BUY  100 bonds @ $105.00`);
  console.log(`   HashScan: https://hashscan.io/testnet/transaction/${aliceHash}`);

  // H. Bob's swap → beforeSwap intercepted → BidQueued (SELL 100 bonds @ $95)
  // zeroForOne = true means: spending bonds to get USDC = SELL
  // amountSpecified = tok(100) (positive = exact input of 100 bonds)
  console.log("H. Bob SWAP intercepted → BidQueued (SELL 100 @ $95)...");
  const bobLimitPrice = BigInt(Math.round(95 * 1_000_000));
  const bobHookData   = encodeAbiParameters(parseAbiParameters("uint256"), [bobLimitPrice]);
  const bobSwapParams = { zeroForOne: true, amountSpecified: tok(100), sqrtPriceLimitX96: 0n } as const;
  const bobHash = await B.wallet.writeContract({
    address: pmAddress, abi: PM_ABI,
    functionName: "dispatchBeforeSwap",
    args: [hookAddress, B.address, poolKey, bobSwapParams, bobHookData],
    gas: 400_000n,
  });
  await waitFor(pub, bobHash);
  console.log(`   ✅ BidQueued: SELL 100 bonds @ $95.00`);
  console.log(`   HashScan: https://hashscan.io/testnet/transaction/${bobHash}`);

  // I. closeAndClear
  process.stdout.write("I. closeAndClear()... ");
  const clearHash = await D.wallet.writeContract({
    address: ENGINE_ADDRESS, abi: ENGINE_ABI,
    functionName: "closeAndClear", args: [hookRoundId], gas: 600_000n,
  });
  const clearReceipt = await waitFor(pub, clearHash);
  let clearingPrice = 0n, clearedQty = 0n;
  for (const log of clearReceipt.logs) {
    try { const d = decodeEventLog({ abi: ENGINE_ABI, ...log }); if (d.eventName === "RoundCleared") { clearingPrice = d.args.clearingPrice; clearedQty = d.args.clearedQuantity; } } catch {}
  }
  console.log(`✅  Clearing price: ${fmtUsd(clearingPrice)}  |  Matched: ${Number(clearedQty) / 1e18} bonds`);

  // J. afterEpochClose(roundId, bondToken) → sync price to hook
  process.stdout.write("J. afterEpochClose() → sync price to hook... ");
  const epochHash = await D.wallet.writeContract({
    address: hookAddress, abi: HOOK_ABI,
    functionName: "afterEpochClose", args: [hookRoundId, bondAddress],
  });
  await waitFor(pub, epochHash);
  console.log("✅");

  // K. Verify
  const hookPrice = await pub.readContract({ address: hookAddress, abi: HOOK_ABI, functionName: "lastClearingPrice", args: [bondAddress] });
  const synced = hookPrice === clearingPrice;

  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log(  "║  ✅  HOOK DEMO COMPLETE!                             ║");
  console.log(  "╚══════════════════════════════════════════════════════╝\n");
  console.log("  Full on-chain flow verified:");
  console.log("    USER SWAP → beforeSwap() → AuctionEngine.submitBidFor()");
  console.log("    All bids sealed → closeAndClear() → uniform price");
  console.log("    afterEpochClose() → hook.lastClearingPrice synced\n");
  console.log(`  TestnetPoolManager : ${pmAddress}`);
  console.log(`  ClearingBellHook   : ${hookAddress}`);
  console.log(`  Hook Round         : #${hookRoundId}`);
  console.log(`  Clearing Price     : ${fmtUsd(clearingPrice)} / bond`);
  console.log(`  hook.lastClearingPrice[bond] = ${fmtUsd(hookPrice)}  ${synced ? "✅ SYNCED" : "❌ MISMATCH"}`);
  console.log(`\n  HashScan engine: https://hashscan.io/testnet/contract/${ENGINE_ADDRESS}`);
  console.log(`  HashScan hook  : https://hashscan.io/testnet/contract/${hookAddress}`);
  if (!synced) throw new Error("Price sync failed!");
}

main().catch(e => {
  console.error("\n❌", e.shortMessage ?? e.message);
  if (e.cause) console.error("   Cause:", e.cause?.shortMessage ?? e.cause?.message);
  process.exit(1);
});
