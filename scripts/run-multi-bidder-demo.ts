/**
 * run-multi-bidder-demo.ts
 *
 * ═══════════════════════════════════════════════════════════
 * WHY NOT THE REAL ATS BOND (0x9126...)?
 * ═══════════════════════════════════════════════════════════
 * The real bond has 6 decimals. AuctionEngine settlement math is:
 *
 *   settlementAmount = bid.quantity * clearingPrice / 1e18
 *
 * With an 18-decimal MockBond, for 100 bonds @ $96:
 *   qty = 100 * 1e18 = 1e20
 *   price = 96 * 1e6 = 96_000_000  (USDC raw, 6 dec)
 *   settlement = 1e20 * 96_000_000 / 1e18 = 9_600_000_000 = $9,600 USDC ✅
 *
 * With the 6-decimal ATS bond, for 100 bonds @ $96:
 *   qty = 100 * 1e6 = 1e8
 *   settlement = 1e8 * 96_000_000 / 1e18 = 0.0096 USDC ≈ 0 ❌  (BROKEN)
 *
 * Also: the real bond has totalSupply=0 and the deployer has 0 balance
 * (it was never actually minted — `issue()` needs the correct amount).
 *
 * The MockBond (18-dec ERC-20) IS the correct test fixture for AuctionEngine.
 * The real ATS bond is for on-chain issuance proofs, not exchange mechanics.
 * ═══════════════════════════════════════════════════════════
 *
 * AUCTION SCENARIO — 4 bidders + 1 KYC-rejected:
 *
 *   BUYERS:
 *     Alice:   $110/bond × 100 bonds  ← KYC'd, willing to pay most
 *     Dave:    $103/bond × 100 bonds  ← KYC'd (deployer wallet)
 *     Charlie: $120/bond × 50  bonds  ← NOT KYC'd → BidderNotEligible ❌
 *
 *   SELLERS:
 *     Bob:     $93/bond  × 100 bonds  ← KYC'd, accepts least
 *     Carol:   $96/bond  × 100 bonds  ← KYC'd
 *
 *   CUMULATIVE DEMAND/SUPPLY CURVES:
 *     Price   | Cum.Buy | Cum.Sell | Crosses?
 *     ─────────────────────────────────────────
 *     $93     | 200     | 100      | Yes (buy > sell, keep going)
 *     $96     | 200     | 200      | Yes ← LAST CROSSING = clearing price ✅
 *
 *   RESULT: Clearing price = $96/bond
 *           Alice pays $9,600 USDC, gets 100 bonds
 *           Dave  pays $9,600 USDC, gets 100 bonds
 *           Bob   gets $9,300 USDC... wait:
 *           Actually ALL trades at the UNIFORM clearing price of $96:
 *           Bob   gets $9,600 USDC (not $93 — that was just his minimum)
 *           Carol gets $9,600 USDC
 *
 * Usage: cd scripts && npx tsx run-multi-bidder-demo.ts
 */

import { config } from "dotenv";
import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  decodeEventLog,
  encodeAbiParameters,
  parseAbiParameters,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hederaTestnet } from "viem/chains";
import { readFileSync } from "fs";
import { resolve } from "path";
import * as path from "path";

config({ path: path.resolve(__dirname, "../.env") });

// ─── Real production contracts ─────────────────────────────────────────────
const GATE_ADDRESS   = "0x59acE2042088Dc40790a456f6af24feBdbB4Dfc7" as const;
const ENGINE_ADDRESS = "0x663d1825f7a1eb323EB531152e23720C7f2AD7a2" as const;
const USDC_ADDRESS   = "0x37A4ae6511f491C5a07fbf61F6cF8b292727D255" as const;
const RPC_URL        = "https://testnet.hashio.io/api";

// ─── Keys (from .env) ─────────────────────────────────────────────────────
const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY as Hex;
const ALICE_KEY    = process.env.ALICE_PRIVATE_KEY    as Hex;
const BOB_KEY      = process.env.BOB_PRIVATE_KEY      as Hex;
const CAROL_KEY    = process.env.CAROL_PRIVATE_KEY    as Hex;

// Charlie — deliberately NOT KYC'd (Foundry well-known account #2 — no HBAR needed, sim only)
const CHARLIE_ADDRESS = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;

if (!DEPLOYER_KEY || !ALICE_KEY || !BOB_KEY || !CAROL_KEY) {
  throw new Error("Missing private keys in .env (need DEPLOYER, ALICE, BOB, CAROL)");
}

// ─── Bid parameters ───────────────────────────────────────────────────────
const BIDS = {
  alice:   { price: 110, qty: 100, isBuy: true,  label: "BUYER  " },
  dave:    { price: 103, qty: 100, isBuy: true,  label: "BUYER  " }, // deployer
  charlie: { price: 120, qty: 50,  isBuy: true,  label: "BUYER  " }, // NO KYC
  bob:     { price: 93,  qty: 100, isBuy: false, label: "SELLER " },
  carol:   { price: 96,  qty: 100, isBuy: false, label: "SELLER " },
};

// ─── ABIs ─────────────────────────────────────────────────────────────────
const ERC20_ABI = parseAbi([
  "function mint(address to, uint256 amount) external",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
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
  "function openRound(address bondToken, address settlementToken, uint256 bidWindow) external returns (uint256)",
  "function submitBid(uint256 roundId, uint256 price, uint256 quantity, bool isBuy) external",
  "function closeAndClear(uint256 roundId) external",
  "function rounds(uint256 roundId) external view returns (uint256 id, address bondToken, address settlementToken, uint256 openDeadline, uint8 phase, uint256 clearingPrice, uint256 clearedQuantity, uint256 bidCount)",
  "event RoundOpened(uint256 indexed roundId, address indexed bondToken, address settlementToken, uint256 openDeadline)",
  "event RoundCleared(uint256 indexed roundId, uint256 clearingPrice, uint256 clearedQuantity)",
  "event RoundClosedWithNoCrossing(uint256 indexed roundId)",
  "event Settled(uint256 indexed roundId, address indexed bidder, uint256 filledQuantity, uint256 settledPrice, bool isBuy)",
  "event BidSubmitted(uint256 indexed roundId, address indexed bidder, uint256 price, uint256 quantity, bool isBuy, uint256 bidIndex)",
]);

const GET_BIDS_ABI = [
  {
    name: "getRoundBids", type: "function", stateMutability: "view",
    inputs: [{ name: "roundId", type: "uint256" }],
    outputs: [{ type: "tuple[]", components: [
      { name: "bidder",   type: "address" },
      { name: "price",    type: "uint256" },
      { name: "quantity", type: "uint256" },
      { name: "isBuy",    type: "bool"    },
      { name: "index",    type: "uint256" },
    ]}],
  },
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────
function makeClient(key: Hex) {
  const account = privateKeyToAccount(key);
  return {
    wallet: createWalletClient({ account, chain: hederaTestnet, transport: http(RPC_URL) }),
    public: createPublicClient({ chain: hederaTestnet, transport: http(RPC_URL) }),
    address: account.address,
    label: "",
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

async function deployContract(
  wallet: ReturnType<typeof createWalletClient>,
  pub: ReturnType<typeof createPublicClient>,
  bytecode: Hex,
  constructorArgs?: Hex
): Promise<Hex> {
  const data: Hex = constructorArgs ? `${bytecode}${constructorArgs.slice(2)}` : bytecode;
  const hash = await wallet.sendTransaction({ data, gas: 3_000_000n });
  const r = await waitFor(pub, hash);
  if (!r.contractAddress) throw new Error("No contract address in receipt");
  return r.contractAddress;
}

async function tryGrant(
  deployerWallet: ReturnType<typeof createWalletClient>,
  pub: ReturnType<typeof createPublicClient>,
  registryAddress: Hex,
  user: Hex,
  name: string
) {
  const already = await pub.readContract({
    address: registryAddress, abi: REGISTRY_ABI,
    functionName: "isVerified", args: [user],
  });
  if (already) {
    console.log(`  ${name}: already KYC'd ✅`);
    return;
  }
  await waitFor(pub, await deployerWallet.writeContract({
    address: registryAddress, abi: REGISTRY_ABI,
    functionName: "grant", args: [user],
  }));
  console.log(`  ${name}: KYC granted ✅`);
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const deployer = makeClient(DEPLOYER_KEY);
  const alice    = makeClient(ALICE_KEY);
  const bob      = makeClient(BOB_KEY);
  const carol    = makeClient(CAROL_KEY);
  const pub      = deployer.public;

  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║      Clearing Bell — Multi-Bidder Auction Demo               ║");
  console.log("║      4 bidders + 1 KYC-rejected | Uniform clearing price     ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("  Deployer (Dave/Issuer) :", deployer.address);
  console.log("  Alice (buyer  @ $110)  :", alice.address);
  console.log("  Bob   (seller @ $93)   :", bob.address);
  console.log("  Carol (seller @ $96)   :", carol.address);
  console.log("  Charlie (NO KYC, sim)  :", CHARLIE_ADDRESS);
  console.log("");
  console.log("  Demand/Supply curves:");
  console.log("  ┌───────┬──────────┬──────────┬─────────────────────┐");
  console.log("  │ Price │ Cum.Buy  │ Cum.Sell │ Status              │");
  console.log("  ├───────┼──────────┼──────────┼─────────────────────┤");
  console.log("  │  $93  │  200     │  100     │ Demand > Supply     │");
  console.log("  │  $96  │  200     │  200     │ ← CLEARING PRICE ✅  │");
  console.log("  └───────┴──────────┴──────────┴─────────────────────┘");
  console.log("  Expected: Clearing price = $96 | Settled qty = 200 bonds");
  console.log("");

  // ── Step 1: Deploy fresh MockBond + Registry ─────────────────────────
  console.log("Step 1 — Deploying MockBond (18 dec) + MockIdentityRegistry...");
  const bondAddr = await deployContract(
    deployer.wallet, pub,
    loadBytecode("MockERC20.sol", "MockERC20"),
    encodeAbiParameters(parseAbiParameters("string,string,uint8"),
      ["CBB28 Demo Bond", "dCBB28", 18])
  );
  const registryAddr = await deployContract(
    deployer.wallet, pub,
    loadBytecode("MockIdentityRegistry.sol", "MockIdentityRegistry")
  );
  console.log("  MockBond     :", bondAddr);
  console.log("  MockRegistry :", registryAddr);

  // ── Step 2: KYC — grant Alice, Bob, Carol, Dave(deployer). NOT Charlie ──
  console.log("Step 2 — KYC approvals (Charlie intentionally excluded)...");
  await tryGrant(deployer.wallet, pub, registryAddr, alice.address,    "Alice  ");
  await tryGrant(deployer.wallet, pub, registryAddr, bob.address,      "Bob    ");
  await tryGrant(deployer.wallet, pub, registryAddr, carol.address,    "Carol  ");
  await tryGrant(deployer.wallet, pub, registryAddr, deployer.address, "Dave   ");
  // Charlie NOT granted — will be rejected at submitBid

  // ── Step 3: Wire registry into real ComplianceGate ────────────────────
  console.log("Step 3 — Wiring registry into ComplianceGate...");
  await waitFor(pub, await deployer.wallet.writeContract({
    address: GATE_ADDRESS, abi: GATE_ABI,
    functionName: "registerRegistry", args: [bondAddr, registryAddr],
  }));
  const aliceOk = await pub.readContract({
    address: GATE_ADDRESS, abi: GATE_ABI,
    functionName: "isEligible", args: [alice.address, bondAddr],
  });
  const charlieOk = await pub.readContract({
    address: GATE_ADDRESS, abi: GATE_ABI,
    functionName: "isEligible", args: [CHARLIE_ADDRESS, bondAddr],
  });
  console.log(`  Alice eligible: ${aliceOk ? "✅" : "❌"}  Charlie eligible: ${charlieOk ? "✅" : "❌"}`);

  // ── Step 4: Seed tokens ───────────────────────────────────────────────
  console.log("Step 4 — Seeding balances...");
  // Bob gets 200 bonds (will sell 100), Carol gets 200 bonds (will sell 100)
  await waitFor(pub, await deployer.wallet.writeContract({
    address: bondAddr, abi: ERC20_ABI, functionName: "mint",
    args: [bob.address, tok(200)],
  }));
  await waitFor(pub, await deployer.wallet.writeContract({
    address: bondAddr, abi: ERC20_ABI, functionName: "mint",
    args: [carol.address, tok(200)],
  }));
  // Alice and Dave get 50k USDC each for buying
  await waitFor(pub, await deployer.wallet.writeContract({
    address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "transfer",
    args: [alice.address, usd(50_000)],
  }));
  // Dave (deployer) already has plenty of USDC

  const bobBonds    = await pub.readContract({ address: bondAddr,    abi: ERC20_ABI, functionName: "balanceOf", args: [bob.address] });
  const carolBonds  = await pub.readContract({ address: bondAddr,    abi: ERC20_ABI, functionName: "balanceOf", args: [carol.address] });
  const aliceUsdc   = await pub.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [alice.address] });
  const deployerUsd = await pub.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [deployer.address] });

  console.log(`  Bob   bonds : ${fmtBond(bobBonds)} | Carol bonds  : ${fmtBond(carolBonds)}`);
  console.log(`  Alice USDC  : ${fmtUsdc(aliceUsdc)} | Dave USDC   : ${fmtUsdc(deployerUsd)}`);

  // ── Step 5: Approve AuctionEngine ────────────────────────────────────
  console.log("Step 5 — Approving AuctionEngine...");
  await waitFor(pub, await bob.wallet.writeContract({
    address: bondAddr, abi: ERC20_ABI, functionName: "approve",
    args: [ENGINE_ADDRESS, tok(10_000)],
  }));
  await waitFor(pub, await carol.wallet.writeContract({
    address: bondAddr, abi: ERC20_ABI, functionName: "approve",
    args: [ENGINE_ADDRESS, tok(10_000)],
  }));
  await waitFor(pub, await alice.wallet.writeContract({
    address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "approve",
    args: [ENGINE_ADDRESS, usd(10_000_000)],
  }));
  await waitFor(pub, await deployer.wallet.writeContract({
    address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "approve",
    args: [ENGINE_ADDRESS, usd(10_000_000)],
  }));
  console.log("  All approvals set ✅");

  // ── Step 6: Open auction round ────────────────────────────────────────
  console.log("Step 6 — Opening auction round (10 min window)...");
  const openHash = await deployer.wallet.writeContract({
    address: ENGINE_ADDRESS, abi: ENGINE_ABI,
    functionName: "openRound",
    args: [bondAddr, USDC_ADDRESS, 600n],
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
  console.log(`  Round ${roundId} opened ✅`);
  console.log(`  HashScan: https://hashscan.io/testnet/transaction/${openHash}`);

  // ── Step 7: Submit bids ───────────────────────────────────────────────
  console.log("");
  console.log("Step 7 — Submitting bids...");
  console.log("┌────────────┬──────────┬─────────────┬──────────────────┐");
  console.log("│ Bidder     │ Side     │ Price/Bond  │ Qty              │");
  console.log("├────────────┼──────────┼─────────────┼──────────────────┤");

  // Bob SELL $93 × 100
  const bobSellHash = await bob.wallet.writeContract({
    address: ENGINE_ADDRESS, abi: ENGINE_ABI, functionName: "submitBid",
    args: [roundId, usd(93), tok(100), false],
  });
  await waitFor(pub, bobSellHash);
  console.log("│ Bob        │ SELL     │ $93.00      │ 100 bonds        │");

  // Carol SELL $96 × 100
  const carolSellHash = await carol.wallet.writeContract({
    address: ENGINE_ADDRESS, abi: ENGINE_ABI, functionName: "submitBid",
    args: [roundId, usd(96), tok(100), false],
  });
  await waitFor(pub, carolSellHash);
  console.log("│ Carol      │ SELL     │ $96.00      │ 100 bonds        │");

  // Alice BUY $110 × 100
  const aliceBuyHash = await alice.wallet.writeContract({
    address: ENGINE_ADDRESS, abi: ENGINE_ABI, functionName: "submitBid",
    args: [roundId, usd(110), tok(100), true],
  });
  await waitFor(pub, aliceBuyHash);
  console.log("│ Alice      │ BUY      │ $110.00     │ 100 bonds        │");

  // Dave (deployer) BUY $103 × 100
  const daveBuyHash = await deployer.wallet.writeContract({
    address: ENGINE_ADDRESS, abi: ENGINE_ABI, functionName: "submitBid",
    args: [roundId, usd(103), tok(100), true],
  });
  await waitFor(pub, daveBuyHash);
  console.log("│ Dave       │ BUY      │ $103.00     │ 100 bonds        │");

  // Charlie BUY $120 × 50 — SIMULATE ONLY (no KYC, no HBAR)
  console.log("│ Charlie    │ BUY      │ $120.00     │ 50 bonds         │");
  try {
    await pub.simulateContract({
      address: ENGINE_ADDRESS, abi: ENGINE_ABI, functionName: "submitBid",
      args: [roundId, usd(120), tok(50), true],
      account: CHARLIE_ADDRESS,
    });
    console.log("│            │          │ [unexpected success!]            │");
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const isKyc = msg.includes("BidderNotEligible") || msg.includes("0x1b3da");
    console.log(`│            │ ❌ REJECTED: BidderNotEligible (KYC)        │`);
  }
  console.log("└────────────┴──────────┴─────────────┴──────────────────┘");

  // ── Step 8: Show bid book ────────────────────────────────────────────
  const bids = await pub.readContract({
    address: ENGINE_ADDRESS, abi: GET_BIDS_ABI,
    functionName: "getRoundBids", args: [roundId],
  });
  console.log(`\n  Bid book (${bids.length} accepted bids in round ${roundId}):`);
  for (const b of bids) {
    const side = b.isBuy ? "BUY " : "SELL";
    const name = b.bidder.toLowerCase() === alice.address.toLowerCase()   ? "Alice" :
                 b.bidder.toLowerCase() === bob.address.toLowerCase()     ? "Bob  " :
                 b.bidder.toLowerCase() === carol.address.toLowerCase()   ? "Carol" :
                 b.bidder.toLowerCase() === deployer.address.toLowerCase()? "Dave " : b.bidder;
    console.log(`    [${b.index}] ${side} ${fmtBond(b.quantity).padStart(4)} bonds @ ${fmtUsdc(b.price).padStart(7)} — ${name}`);
  }

  // ── Step 9: closeAndClear ────────────────────────────────────────────
  console.log("\nStep 8 — Issuer calls closeAndClear()...");
  const clearHash = await deployer.wallet.writeContract({
    address: ENGINE_ADDRESS, abi: ENGINE_ABI,
    functionName: "closeAndClear", args: [roundId], gas: 500_000n,
  });
  const clearReceipt = await waitFor(pub, clearHash);
  console.log(`  TX: https://hashscan.io/testnet/transaction/${clearHash}`);

  let clearingPrice = 0n;
  let clearedQty    = 0n;
  let hasCrossing   = false;
  const settlements: string[] = [];

  for (const log of clearReceipt.logs) {
    try {
      const d = decodeEventLog({ abi: ENGINE_ABI, ...log });
      if (d.eventName === "RoundCleared") {
        clearingPrice = d.args.clearingPrice;
        clearedQty    = d.args.clearedQuantity;
        hasCrossing   = true;
      } else if (d.eventName === "Settled") {
        const side = d.args.isBuy ? "BUY " : "SELL";
        const name = d.args.bidder.toLowerCase() === alice.address.toLowerCase()    ? "Alice" :
                     d.args.bidder.toLowerCase() === bob.address.toLowerCase()      ? "Bob  " :
                     d.args.bidder.toLowerCase() === carol.address.toLowerCase()    ? "Carol" :
                     d.args.bidder.toLowerCase() === deployer.address.toLowerCase() ? "Dave " : "????";
        const settlement = d.args.filledQuantity * d.args.settledPrice / 10n ** 18n;
        settlements.push(
          `  [${side}] ${name}: ${fmtBond(d.args.filledQuantity)} bonds × ${fmtUsdc(d.args.settledPrice)} = ${fmtUsdc(settlement)}`
        );
      }
    } catch {}
  }

  // ── Final report ──────────────────────────────────────────────────────
  const aliceBondFinal   = await pub.readContract({ address: bondAddr,    abi: ERC20_ABI, functionName: "balanceOf", args: [alice.address] });
  const aliceUsdcFinal   = await pub.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [alice.address] });
  const bobBondFinal     = await pub.readContract({ address: bondAddr,    abi: ERC20_ABI, functionName: "balanceOf", args: [bob.address] });
  const bobUsdcFinal     = await pub.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [bob.address] });
  const carolBondFinal   = await pub.readContract({ address: bondAddr,    abi: ERC20_ABI, functionName: "balanceOf", args: [carol.address] });
  const carolUsdcFinal   = await pub.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [carol.address] });
  const daveBondFinal    = await pub.readContract({ address: bondAddr,    abi: ERC20_ABI, functionName: "balanceOf", args: [deployer.address] });
  const daveUsdcFinal    = await pub.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [deployer.address] });

  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║               AUCTION RESULTS                               ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("");

  if (hasCrossing) {
    const totalSettlement = clearedQty * clearingPrice / 10n ** 18n;
    console.log(`  ● Clearing price   : ${fmtUsdc(clearingPrice)}/bond`);
    console.log(`  ● Cleared quantity : ${fmtBond(clearedQty)} bonds`);
    console.log(`  ● Total USDC flow  : ${fmtUsdc(totalSettlement)}`);
    console.log(`  ● Note: uniform price — ALL buyers pay $96, ALL sellers receive $96`);
    console.log(`           regardless of their original bid prices`);
    console.log("");
    console.log("  Settlement events:");
    for (const s of settlements) console.log(s);
    console.log("");
    console.log("  Final balances:");
    console.log("  ┌─────────┬───────────────┬────────────────┐");
    console.log("  │ Wallet  │ Bond balance  │ USDC balance   │");
    console.log("  ├─────────┼───────────────┼────────────────┤");
    console.log(`  │ Alice   │ ${fmtBond(aliceBondFinal).padEnd(14)}│ ${fmtUsdc(aliceUsdcFinal).padEnd(15)}│`);
    console.log(`  │ Dave    │ ${fmtBond(daveBondFinal).padEnd(14)}│ ${fmtUsdc(daveUsdcFinal).padEnd(15)}│`);
    console.log(`  │ Bob     │ ${fmtBond(bobBondFinal).padEnd(14)}│ ${fmtUsdc(bobUsdcFinal).padEnd(15)}│`);
    console.log(`  │ Carol   │ ${fmtBond(carolBondFinal).padEnd(14)}│ ${fmtUsdc(carolUsdcFinal).padEnd(15)}│`);
    console.log(`  │ Charlie │ 0 (rejected)  │ unchanged       │`);
    console.log("  └─────────┴───────────────┴────────────────┘");
  } else {
    console.log("  ⚠️  No crossing — round closed with no trades");
  }

  console.log("");
  console.log("  HashScan links:");
  console.log(`  Engine  : https://hashscan.io/testnet/contract/${ENGINE_ADDRESS}`);
  console.log(`  MockBond: https://hashscan.io/testnet/contract/${bondAddr}`);
  console.log(`  Round ${roundId} clear TX: https://hashscan.io/testnet/transaction/${clearHash}`);
  console.log("");
  console.log("  Update .env:");
  console.log(`  BOND_TOKEN_ADDRESS=${bondAddr}`);
  console.log(`  ACTIVE_ROUND_ID=${roundId}`);
}

main().catch((e) => {
  console.error("\n❌ Demo failed:", e.shortMessage ?? e.message ?? e);
  if (e.cause) console.error("Cause:", e.cause?.shortMessage ?? e.cause?.message);
  process.exit(1);
});
