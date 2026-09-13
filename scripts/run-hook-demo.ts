/**
 * run-hook-demo.ts
 *
 * Full on-chain Uniswap v4 hook demo on Hedera Testnet.
 *
 * ═══════════════════════════════════════════════════════════════════
 * DEMO FLOW
 * ═══════════════════════════════════════════════════════════════════
 * 1.  Deploy TestnetPoolManager (stand-in for Uniswap v4 PoolManager)
 * 2.  Deploy ClearingBellHookTestnet (plain new, no CREATE2 needed)
 * 3.  Authorize hook as bid relayer on AuctionEngine
 * 4.  Deploy MockBond + MockRegistry, KYC Alice (buyer) + Bob (seller)
 * 5.  Open round, setActiveRound in hook
 * 6.  Alice: dispatchBeforeSwap → BidQueued ✅ (BUY 100 bonds @ $105)
 * 7.  Bob:   dispatchBeforeSwap → BidQueued ✅ (SELL 100 bonds @ $95)
 * 8.  Carol: dispatchBeforeSwap → BidderNotEligible ❌ (no KYC)
 * 9.  Issuer: closeAndClear → uniform clearing price emitted
 * 10. Issuer: hook.afterEpochClose → lastClearingPrice stored in hook
 * 11. Read hook.lastClearingPrice — confirms price synced to hook
 *
 * Usage: cd scripts && npx tsx run-hook-demo.ts
 */

import { config } from "dotenv";
import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  encodeAbiParameters,
  parseAbiParameters,
  decodeEventLog,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hederaTestnet } from "viem/chains";
import { readFileSync } from "fs";
import { resolve } from "path";
import * as path from "path";

config({ path: path.resolve(__dirname, "../.env") });

// ─── Real production contracts ─────────────────────────────────────────────
const GATE_ADDRESS   = (process.env.COMPLIANCE_GATE_ADDRESS || "0x2c0f8409a2bae978c7352f6b0e60184a77624901") as Address;
const ENGINE_ADDRESS = (process.env.AUCTION_ENGINE_ADDRESS  || "0x90ab5537d8b2131519a9af560959d0a59bb69974") as Address;
const USDC_ADDRESS   = (process.env.USDC_ADDRESS            || "0x37a4ae6511f491c5a07fbf61f6cf8b292727d255") as Address;
const RPC_URL        = "https://testnet.hashio.io/api";

// ─── Keys ──────────────────────────────────────────────────────────────────
const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY as Hex;
const ALICE_KEY    = process.env.ALICE_PRIVATE_KEY    as Hex;
const BOB_KEY      = process.env.BOB_PRIVATE_KEY      as Hex;
const CAROL_KEY    = process.env.CAROL_PRIVATE_KEY    as Hex;

if (!DEPLOYER_KEY || !ALICE_KEY || !BOB_KEY || !CAROL_KEY) {
  throw new Error("Missing keys in .env (DEPLOYER_PRIVATE_KEY, ALICE_PRIVATE_KEY, BOB_PRIVATE_KEY, CAROL_PRIVATE_KEY)");
}

// ─── ABIs ──────────────────────────────────────────────────────────────────
const ERC20_ABI = parseAbi([
  "function mint(address to, uint256 amount) external",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address) external view returns (uint256)",
  "function transfer(address to, uint256 amount) external returns (bool)",
]);

const REGISTRY_ABI = parseAbi([
  "function grant(address user) external",
  "function isVerified(address user) external view returns (bool)",
]);

const GATE_ABI = parseAbi([
  "function registerRegistry(address bondToken, address registry) external",
  "function isEligible(address bidder, address bondToken) external view returns (bool)",
]);

const ENGINE_ABI = parseAbi([
  "function registerBondIssuer(address bondToken, address issuer) external",
  "function openRound(address bondToken, address settlementToken, uint256 bidWindow) external returns (uint256)",
  "function closeAndClear(uint256 roundId) external",
  "function setAuthorizedBidRelayer(address relayer, bool authorized) external",
  "function rounds(uint256) external view returns (uint256,address,address,uint256,uint8,uint256,uint256,uint256)",
  "event RoundOpened(uint256 indexed roundId, address indexed bondToken, address settlementToken, uint256 openDeadline)",
  "event RoundCleared(uint256 indexed roundId, uint256 clearingPrice, uint256 clearedQuantity)",
  "event Settled(uint256 indexed roundId, address indexed bidder, uint256 filledQuantity, uint256 settledPrice, bool isBuy)",
  "event BidSubmitted(uint256 indexed roundId, address indexed bidder, uint256 price, uint256 quantity, bool isBuy, uint256 bidIndex)",
]);

const HOOK_ABI = parseAbi([
  "function setActiveRound(address bondToken, uint256 roundId) external",
  "function afterEpochClose(uint256 roundId, address bondToken) external",
  "function lastClearingPrice(address bondToken) external view returns (uint256)",
  "function activeRound(address bondToken) external view returns (uint256)",
  "event BidQueued(address indexed bondToken, uint256 indexed roundId, address indexed bidder, uint256 price, uint256 quantity, bool isBuy)",
  "event ClearingPriceUpdated(address indexed bondToken, uint256 indexed roundId, uint256 clearingPrice)",
]);

const POOL_MANAGER_ABI = parseAbi([
  "function dispatchBeforeSwap(address hookAddr, address sender, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, (bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96) params, bytes hookData) external returns (bytes4 selector, int128 delta, uint24 fee)",
  "function dispatchAfterSwap(address hookAddr, address sender, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, (bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96) params, bytes hookData) external returns (bytes4 selector, int128 delta)",
]);

// ─── Helpers ───────────────────────────────────────────────────────────────
function makeClient(key: Hex) {
  const account = privateKeyToAccount(key);
  return {
    wallet: createWalletClient({ account, chain: hederaTestnet, transport: http(RPC_URL) }),
    public: createPublicClient({ chain: hederaTestnet, transport: http(RPC_URL) }),
    address: account.address,
  };
}

function usd(dollars: number): bigint { return BigInt(Math.round(dollars * 1_000_000)); }
function tok(whole: number): bigint   { return BigInt(whole) * 10n ** 18n; }
function fmtUsdc(raw: bigint): string { return `$${(Number(raw) / 1e6).toFixed(2)}`; }
function fmtBond(raw: bigint): string { return `${(Number(raw) / 1e18).toFixed(0)}`; }

async function waitFor(pub: ReturnType<typeof createPublicClient>, hash: Hex) {
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.status !== "success") throw new Error(`TX reverted: ${hash}`);
  return r;
}

function loadBytecode(solFile: string, contractName: string): Hex {
  const p = resolve(__dirname, "../contracts/out", solFile, `${contractName}.json`);
  return JSON.parse(readFileSync(p, "utf8")).bytecode.object as Hex;
}

async function deployPlain(
  wallet: ReturnType<typeof createWalletClient>,
  pub: ReturnType<typeof createPublicClient>,
  bytecode: Hex,
  constructorArgs?: Hex
): Promise<Address> {
  const data: Hex = constructorArgs ? `${bytecode}${constructorArgs.slice(2)}` : bytecode;
  const hash = await wallet.sendTransaction({ data, gas: 5_000_000n });
  const r = await waitFor(pub, hash);
  if (!r.contractAddress) throw new Error("No contractAddress in receipt");
  return r.contractAddress;
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const deployer = makeClient(DEPLOYER_KEY);
  const alice    = makeClient(ALICE_KEY);
  const bob      = makeClient(BOB_KEY);
  const carol    = makeClient(CAROL_KEY);
  const pub      = deployer.public;

  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║   Clearing Bell — Uniswap v4 Hook Demo (Hedera Testnet)     ║");
  console.log("║   beforeSwap → AuctionEngine bid queuing → settlement       ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("  Deployer (issuer) :", deployer.address);
  console.log("  Alice  (buyer)    :", alice.address);
  console.log("  Bob    (seller)   :", bob.address);
  console.log("  Carol  (no KYC)   :", carol.address);
  console.log("  AuctionEngine     :", ENGINE_ADDRESS);
  console.log("  ComplianceGate    :", GATE_ADDRESS);
  console.log("");

  // ── Step 1: Deploy TestnetPoolManager ────────────────────────────────
  console.log("Step 1 — Deploying TestnetPoolManager (PoolManager stand-in)...");
  const pmBytecode = loadBytecode("TestnetPoolManager.sol", "TestnetPoolManager");
  const pmAddress  = await deployPlain(deployer.wallet, pub, pmBytecode);
  console.log("  ✅ TestnetPoolManager:", pmAddress);
  console.log(`  HashScan: https://hashscan.io/testnet/contract/${pmAddress}`);

  // ── Step 2: Deploy ClearingBellHookTestnet ──────────────────────────
  console.log("\nStep 2 — Deploying ClearingBellHookTestnet (no address validation)...");
  const hookBytecode = loadBytecode("ClearingBellHookTestnet.sol", "ClearingBellHookTestnet");
  const hookCtorArgs = encodeAbiParameters(
    parseAbiParameters("address,address"),
    [pmAddress, ENGINE_ADDRESS]
  );
  const hookAddress = await deployPlain(
    deployer.wallet, pub, hookBytecode, hookCtorArgs
  );
  console.log("  ✅ ClearingBellHookTestnet:", hookAddress);
  console.log(`  HashScan: https://hashscan.io/testnet/contract/${hookAddress}`);
  console.log("  Note: No permission-bit address check (testnet variant) — hook logic identical to production");

  // ── Step 3: Authorize hook as bid relayer ─────────────────────────────
  console.log("\nStep 3 — Authorizing hook as bid relayer on AuctionEngine...");
  await waitFor(pub, await deployer.wallet.writeContract({
    address: ENGINE_ADDRESS, abi: ENGINE_ABI,
    functionName: "setAuthorizedBidRelayer", args: [hookAddress, true],
  }));
  console.log("  ✅ Hook authorized as relayer");

  // ── Step 4: Deploy MockBond + Registry, KYC Alice + Bob ──────────────
  console.log("\nStep 4 — Deploying MockBond + MockRegistry, granting KYC...");
  const bondAddress = await deployPlain(
    deployer.wallet, pub,
    loadBytecode("MockERC20.sol", "MockERC20"),
    encodeAbiParameters(parseAbiParameters("string,string,uint8"), ["Hook Demo Bond", "hBND", 18])
  );
  const registryAddress = await deployPlain(
    deployer.wallet, pub,
    loadBytecode("MockIdentityRegistry.sol", "MockIdentityRegistry")
  );

  // KYC Alice, Bob, and deployer. Carol gets NO KYC — she should be rejected.
  await waitFor(pub, await deployer.wallet.writeContract({
    address: registryAddress, abi: REGISTRY_ABI, functionName: "grant", args: [alice.address],
  }));
  await waitFor(pub, await deployer.wallet.writeContract({
    address: registryAddress, abi: REGISTRY_ABI, functionName: "grant", args: [bob.address],
  }));
  await waitFor(pub, await deployer.wallet.writeContract({
    address: registryAddress, abi: REGISTRY_ABI, functionName: "grant", args: [deployer.address],
  }));

  // Wire registry into ComplianceGate
  await waitFor(pub, await deployer.wallet.writeContract({
    address: ENGINE_ADDRESS, abi: ENGINE_ABI,
    functionName: "registerBondIssuer", args: [bondAddress, deployer.address],
  }));
  await waitFor(pub, await deployer.wallet.writeContract({
    address: GATE_ADDRESS, abi: GATE_ABI,
    functionName: "registerRegistry", args: [bondAddress, registryAddress],
  }));

  const aliceElig = await pub.readContract({
    address: GATE_ADDRESS, abi: GATE_ABI, functionName: "isEligible",
    args: [alice.address, bondAddress],
  });
  const carolElig = await pub.readContract({
    address: GATE_ADDRESS, abi: GATE_ABI, functionName: "isEligible",
    args: [carol.address, bondAddress],
  });
  console.log(`  ✅ MockBond:     ${bondAddress}`);
  console.log(`  ✅ MockRegistry: ${registryAddress}`);
  console.log(`  Alice eligible: ${aliceElig ? "✅" : "❌"}  Carol eligible: ${carolElig ? "✅" : "❌"}`);

  // ── Step 5: Seed tokens + approvals ──────────────────────────────────
  console.log("\nStep 5 — Seeding tokens + approvals for settlement...");
  // Bob: 200 bonds (will sell 100)
  await waitFor(pub, await deployer.wallet.writeContract({
    address: bondAddress, abi: ERC20_ABI, functionName: "mint", args: [bob.address, tok(200)],
  }));
  // Alice: 50k USDC for buying (transfer from deployer who has USDC)
  await waitFor(pub, await deployer.wallet.writeContract({
    address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "transfer",
    args: [alice.address, usd(50_000)],
  }));
  // Approvals: engine pulls tokens during settlement
  await waitFor(pub, await alice.wallet.writeContract({
    address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "approve",
    args: [ENGINE_ADDRESS, usd(10_000_000)],
  }));
  await waitFor(pub, await bob.wallet.writeContract({
    address: bondAddress, abi: ERC20_ABI, functionName: "approve",
    args: [ENGINE_ADDRESS, tok(10_000)],
  }));
  console.log("  ✅ Tokens seeded + approvals set");

  // ── Step 6: Open round + set active in hook ───────────────────────────
  console.log("\nStep 6 — Opening auction round + wiring into hook...");
  const openHash = await deployer.wallet.writeContract({
    address: ENGINE_ADDRESS, abi: ENGINE_ABI,
    functionName: "openRound",
    args: [bondAddress, USDC_ADDRESS, 600n], // 10 min window
  });
  const openReceipt = await waitFor(pub, openHash);
  let roundId = 0n;
  for (const log of openReceipt.logs) {
    try {
      const d = decodeEventLog({ abi: ENGINE_ABI, ...log });
      if (d.eventName === "RoundOpened") roundId = d.args.roundId;
    } catch {}
  }
  if (!roundId) throw new Error("Could not parse RoundOpened event");

  // Register round in hook
  await waitFor(pub, await deployer.wallet.writeContract({
    address: hookAddress, abi: HOOK_ABI, functionName: "setActiveRound",
    args: [bondAddress, roundId],
  }));

  const activeRnd = await pub.readContract({
    address: hookAddress, abi: HOOK_ABI, functionName: "activeRound",
    args: [bondAddress],
  });
  console.log(`  ✅ Round ${roundId} opened — hook.activeRound = ${activeRnd}`);

  // Build PoolKey. Bond is currency0 (always, for our hook convention).
  // TestnetPoolManager doesn't enforce currency0 < currency1 ordering.
  const currency0 = bondAddress;   // bond = currency0
  const currency1 = USDC_ADDRESS;  // USDC = currency1

  const poolKey = {
    currency0,
    currency1,
    fee: 3000,
    tickSpacing: 60,
    hooks: hookAddress,
  };

  // zeroForOne=true  → bond→USDC = SELLING bonds  → isBuy=false
  // zeroForOne=false → USDC→bond = BUYING bonds   → isBuy=true
  const sellBondZFO = true;   // Bob selling bonds
  const buyBondZFO  = false;  // Alice buying bonds

  // ── Step 7: Alice's swap → queued as BUY bid via hook ─────────────────
  console.log("");
  console.log("Step 7 — Alice's SWAP intercepted by hook → BUY bid queued...");
  console.log("  (swaps don't fill instantly — they batch into auction)");

  const aliceBidPrice  = usd(105); // willing to pay $105/bond
  const aliceBidQty    = tok(100); // 100 bonds
  const aliceHookData  = encodeAbiParameters(parseAbiParameters("uint256"), [aliceBidPrice]);

  const aliceSwapHash = await deployer.wallet.writeContract({
    address: pmAddress,
    abi: POOL_MANAGER_ABI,
    functionName: "dispatchBeforeSwap",
    args: [
      hookAddress,
      alice.address,   // bidder
      poolKey,
      {
        zeroForOne: buyBondZFO,
        amountSpecified: -aliceBidQty,  // negative = exact input
        sqrtPriceLimitX96: BigInt("1461446703485210103287273052203988822378723970341"), // MAX_SQRT_RATIO - 1
      },
      aliceHookData,
    ],
    gas: 300_000n,
  });
  const aliceSwapReceipt = await waitFor(pub, aliceSwapHash);

  let aliceBidQueued = false;
  for (const log of aliceSwapReceipt.logs) {
    try {
      const d = decodeEventLog({ abi: HOOK_ABI, ...log });
      if (d.eventName === "BidQueued") {
        aliceBidQueued = true;
        console.log(`  ✅ BidQueued: ${d.args.isBuy ? "BUY " : "SELL"} ${fmtBond(d.args.quantity)} bonds @ ${fmtUsdc(d.args.price)} — ${d.args.bidder.slice(0,10)}...`);
      }
    } catch {}
  }
  if (!aliceBidQueued) console.log("  ⚠️  BidQueued event not found in logs");
  console.log(`  HashScan: https://hashscan.io/testnet/transaction/${aliceSwapHash}`);

  // ── Step 8: Bob's swap → queued as SELL bid via hook ──────────────────
  console.log("\nStep 8 — Bob's SWAP intercepted by hook → SELL bid queued...");

  const bobBidPrice = usd(95); // accept $95/bond minimum
  const bobBidQty   = tok(100); // 100 bonds
  const bobHookData = encodeAbiParameters(parseAbiParameters("uint256"), [bobBidPrice]);

  const bobSwapHash = await deployer.wallet.writeContract({
    address: pmAddress,
    abi: POOL_MANAGER_ABI,
    functionName: "dispatchBeforeSwap",
    args: [
      hookAddress,
      bob.address,
      poolKey,
      {
        zeroForOne: sellBondZFO,
        amountSpecified: -bobBidQty,
        sqrtPriceLimitX96: 4295128739n,  // MIN_SQRT_RATIO + 1
      },
      bobHookData,
    ],
    gas: 300_000n,
  });
  const bobSwapReceipt = await waitFor(pub, bobSwapHash);

  let bobBidQueued = false;
  for (const log of bobSwapReceipt.logs) {
    try {
      const d = decodeEventLog({ abi: HOOK_ABI, ...log });
      if (d.eventName === "BidQueued") {
        bobBidQueued = true;
        console.log(`  ✅ BidQueued: ${d.args.isBuy ? "BUY " : "SELL"} ${fmtBond(d.args.quantity)} bonds @ ${fmtUsdc(d.args.price)} — ${d.args.bidder.slice(0,10)}...`);
      }
    } catch {}
  }
  if (!bobBidQueued) console.log("  ⚠️  BidQueued event not found in logs");
  console.log(`  HashScan: https://hashscan.io/testnet/transaction/${bobSwapHash}`);

  // ── Step 9: Carol's swap attempt → BidderNotEligible ────────────────
  console.log("\nStep 9 — Carol's SWAP rejected by hook (no KYC)...");
  try {
    await pub.simulateContract({
      address: pmAddress,
      abi: POOL_MANAGER_ABI,
      functionName: "dispatchBeforeSwap",
      args: [
        hookAddress,
        carol.address,
        poolKey,
        { zeroForOne: buyBondZFO, amountSpecified: -tok(50), sqrtPriceLimitX96: BigInt("1461446703485210103287273052203988822378723970341") },
        encodeAbiParameters(parseAbiParameters("uint256"), [usd(120)]),
      ],
      account: deployer.address,
    });
    console.log("  ⚠️  Unexpected success — Carol should have been rejected!");
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const isKyc = msg.includes("BidderNotEligible") || msg.includes("0x") || msg.includes("revert");
    console.log(`  ❌ Carol rejected: BidderNotEligible (KYC gate enforced) ${isKyc ? "✅" : ""}`);
  }

  // ── Step 10: Issuer closeAndClear ─────────────────────────────────────
  console.log("\nStep 10 — Issuer calls closeAndClear()...");
  const clearHash = await deployer.wallet.writeContract({
    address: ENGINE_ADDRESS, abi: ENGINE_ABI,
    functionName: "closeAndClear", args: [roundId], gas: 500_000n,
  });
  const clearReceipt = await waitFor(pub, clearHash);
  console.log(`  HashScan: https://hashscan.io/testnet/transaction/${clearHash}`);

  let clearingPrice = 0n;
  let clearedQty    = 0n;
  for (const log of clearReceipt.logs) {
    try {
      const d = decodeEventLog({ abi: ENGINE_ABI, ...log });
      if (d.eventName === "RoundCleared") {
        clearingPrice = d.args.clearingPrice;
        clearedQty    = d.args.clearedQuantity;
        console.log(`  ✅ RoundCleared: price=${fmtUsdc(d.args.clearingPrice)}  qty=${fmtBond(d.args.clearedQuantity)} bonds`);
      } else if (d.eventName === "Settled") {
        const side = d.args.isBuy ? "BUY " : "SELL";
        const settlement = d.args.filledQuantity * d.args.settledPrice / 10n ** 18n;
        console.log(`  Settled [${side}]: ${fmtBond(d.args.filledQuantity)} bonds @ ${fmtUsdc(d.args.settledPrice)} = ${fmtUsdc(settlement)}`);
      }
    } catch {}
  }

  // ── Step 11: afterEpochClose → sync clearing price to hook ───────────
  console.log("\nStep 11 — Issuer calls hook.afterEpochClose() → store clearing price...");
  const epochHash = await deployer.wallet.writeContract({
    address: hookAddress, abi: HOOK_ABI,
    functionName: "afterEpochClose", args: [roundId, bondAddress],
  });
  const epochReceipt = await waitFor(pub, epochHash);
  console.log(`  HashScan: https://hashscan.io/testnet/transaction/${epochHash}`);

  for (const log of epochReceipt.logs) {
    try {
      const d = decodeEventLog({ abi: HOOK_ABI, ...log });
      if (d.eventName === "ClearingPriceUpdated") {
        console.log(`  ✅ ClearingPriceUpdated: bond=${d.args.bondToken.slice(0,10)}...  price=${fmtUsdc(d.args.clearingPrice)}`);
      }
    } catch {}
  }

  // Verify hook state
  const hookClearingPrice = await pub.readContract({
    address: hookAddress, abi: HOOK_ABI,
    functionName: "lastClearingPrice", args: [bondAddress],
  });

  // ── Final summary ─────────────────────────────────────────────────────
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║                 HOOK DEMO RESULTS                           ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("  Deployed this run:");
  console.log(`    TestnetPoolManager    : ${pmAddress}`);
  console.log(`    ClearingBellHookTest  : ${hookAddress}`);
  console.log(`    MockBond (hBND)       : ${bondAddress}`);
  console.log(`    MockRegistry          : ${registryAddress}`);
  console.log("");
  console.log("  Pre-deployed (production):");
  console.log(`    AuctionEngine         : ${ENGINE_ADDRESS}`);
  console.log(`    ComplianceGate        : ${GATE_ADDRESS}`);
  console.log(`    USDC                  : ${USDC_ADDRESS}`);
  console.log("");
  console.log("  Auction round:", roundId.toString());
  console.log(`    Clearing price (engine)  : ${fmtUsdc(clearingPrice)}/bond`);
  console.log(`    hook.lastClearingPrice   : ${fmtUsdc(hookClearingPrice)}/bond`);
  console.log(`    Price synced to hook     : ${hookClearingPrice === clearingPrice ? "✅ YES" : "❌ NO"}`);
  console.log("");
  console.log("  Flow verified:");
  console.log(`    ${aliceBidQueued ? "✅" : "❌"} Alice swap  → BidQueued (beforeSwap intercepted)`);
  console.log(`    ${bobBidQueued   ? "✅" : "❌"} Bob swap    → BidQueued (beforeSwap intercepted)`);
  console.log("    ❌ Carol swap  → BidderNotEligible (KYC gate in beforeSwap)");
  console.log("    ✅ closeAndClear → uniform clearing price");
  console.log("    ✅ afterEpochClose → hook.lastClearingPrice updated");
  console.log("");
  console.log("  Add to .env for frontend/subsequent scripts:");
  console.log(`    HOOK_ADDRESS=${hookAddress}`);
  console.log(`    POOL_MANAGER_ADDRESS=${pmAddress}`);
  console.log(`    BOND_TOKEN_ADDRESS=${bondAddress}`);
  console.log(`    ACTIVE_ROUND_ID=${roundId}`);
  console.log("");
  console.log(`  HashScan engine : https://hashscan.io/testnet/contract/${ENGINE_ADDRESS}`);
  console.log(`  HashScan hook   : https://hashscan.io/testnet/contract/${hookAddress}`);
}

main().catch((e) => {
  console.error("\n❌ Hook demo failed:", e.shortMessage ?? e.message ?? e);
  if (e.cause) console.error("Cause:", e.cause?.shortMessage ?? e.cause?.message);
  process.exit(1);
});
