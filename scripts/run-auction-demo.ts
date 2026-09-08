/**
 * run-auction-demo.ts
 *
 * Full on-chain auction demo — no Foundry, pure TypeScript + viem.
 *
 * What this does (in order):
 *   1. Deploy MockBond (ERC-20, 18 dec) — stand-in for the real ATS bond
 *   2. Deploy MockRegistry — stand-in for ATS identity registry
 *   3. KYC-approve ALICE (buyer) and BOB (seller) in the registry
 *   4. Wire the mock registry into the REAL ComplianceGate
 *   5. Mint 1,000 MockBond to BOB (seller), 0 to ALICE (she uses USDC)
 *   6. Approve AuctionEngine to pull tokens from both bidders
 *   7. Open a fresh auction round on the REAL AuctionEngine
 *   8. Submit SELL bid from BOB  @ $95 / bond — 100 bonds
 *   9. Submit BUY  bid from ALICE @ $105 / bond — 100 bonds
 *  10. Issuer (deployer) calls closeAndClear() — engine computes clearing price
 *  11. Print final clearing price + settlement amounts
 *
 * Clearing math (Budish/Cramton/Shim):
 *   buy $105 crosses sell $95 → clearing price = $95 (lowest valid crossing)
 *   settlement = 100 bonds × $95 = $9,500 USDC flows BOB→engine→ALICE
 *                100 bonds flows ALICE→engine→BOB
 *
 * Usage:
 *   cd scripts
 *   npx tsx run-auction-demo.ts
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

// ─── Real deployed contracts on Hedera Testnet ─────────────────────────────
const GATE_ADDRESS    = "0x59acE2042088Dc40790a456f6af24feBdbB4Dfc7" as const;
const ENGINE_ADDRESS  = "0x663d1825f7a1eb323EB531152e23720C7f2AD7a2" as const;
const USDC_ADDRESS    = "0x37A4ae6511f491C5a07fbf61F6cF8b292727D255" as const;
const RPC_URL         = "https://testnet.hashio.io/api";

// ─── Keys (from .env) ──────────────────────────────────────────────────────
const DEPLOYER_KEY  = process.env.DEPLOYER_PRIVATE_KEY  as Hex;
const ALICE_KEY     = process.env.ALICE_PRIVATE_KEY     as Hex;
const BOB_KEY       = process.env.BOB_PRIVATE_KEY       as Hex;

if (!DEPLOYER_KEY || !ALICE_KEY || !BOB_KEY) {
  throw new Error("Missing DEPLOYER_PRIVATE_KEY, ALICE_PRIVATE_KEY, or BOB_PRIVATE_KEY in .env");
}

// ─── ABIs ──────────────────────────────────────────────────────────────────
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

// getRoundBids returns a struct array — must use JSON ABI (abitype can't parse inline tuples)
const GET_BIDS_ABI = [
  {
    name: "getRoundBids",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "roundId", type: "uint256" }],
    outputs: [{
      type: "tuple[]",
      components: [
        { name: "bidder",   type: "address" },
        { name: "price",    type: "uint256" },
        { name: "quantity", type: "uint256" },
        { name: "isBuy",    type: "bool"    },
        { name: "index",    type: "uint256" },
      ],
    }],
  },
] as const;

// ─── Bytecodes from compiled Foundry artifacts ──────────────────────────────
function loadBytecode(solFile: string, contractName: string): Hex {
  const artifactPath = resolve(
    __dirname,
    "../contracts/out",
    solFile,
    `${contractName}.json`
  );
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  return artifact.bytecode.object as Hex;
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function makeClient(key: Hex) {
  const account = privateKeyToAccount(key);
  return {
    wallet: createWalletClient({
      account,
      chain: hederaTestnet,
      transport: http(RPC_URL),
    }),
    public: createPublicClient({
      chain: hederaTestnet,
      transport: http(RPC_URL),
    }),
    address: account.address,
  };
}

function usd(dollars: number): bigint {
  return BigInt(Math.round(dollars * 1_000_000)); // USDC 6 decimals
}

function tok(whole: number): bigint {
  return BigInt(whole) * 10n ** 18n; // bond token 18 decimals
}

function fmtUsdc(raw: bigint): string {
  return `$${(Number(raw) / 1e6).toFixed(2)}`;
}

function fmtBond(raw: bigint): string {
  return `${(Number(raw) / 1e18).toFixed(2)} bonds`;
}

async function waitFor(
  publicClient: ReturnType<typeof createPublicClient>,
  hash: Hex
) {
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    timeout: 120_000,
  });
  if (receipt.status !== "success") throw new Error(`TX reverted: ${hash}`);
  return receipt;
}

async function deployContract(
  walletClient: ReturnType<typeof createWalletClient>,
  publicClient: ReturnType<typeof createPublicClient>,
  bytecode: Hex,
  constructorArgs?: Hex
): Promise<Hex> {
  const data: Hex = constructorArgs
    ? `${bytecode}${constructorArgs.slice(2)}`
    : bytecode;

  const hash = await walletClient.sendTransaction({
    data,
    gas: 3_000_000n,
  });
  const receipt = await waitFor(publicClient, hash);
  if (!receipt.contractAddress) throw new Error("No contract address in receipt");
  return receipt.contractAddress;
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const deployer = makeClient(DEPLOYER_KEY);
  const alice    = makeClient(ALICE_KEY);
  const bob      = makeClient(BOB_KEY);

  const pub = deployer.public;

  console.log("");
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║         Clearing Bell — Full Auction Demo                ║");
  console.log("║         Hedera Testnet (chain 296)                       ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("Deployer :", deployer.address);
  console.log("Alice    :", alice.address, "← buyer");
  console.log("Bob      :", bob.address, "← seller");
  console.log("Engine   :", ENGINE_ADDRESS);
  console.log("Gate     :", GATE_ADDRESS);
  console.log("USDC     :", USDC_ADDRESS);
  console.log("");

  // ── 1. Deploy MockBond ──────────────────────────────────────────────────
  console.log("Step 1/10 — Deploying MockBond (18 dec ERC-20)...");
  const mockBondBytecode = loadBytecode("MockERC20.sol", "MockERC20");
  // constructor(string name, string symbol, uint8 decimals)
  const bondCtorArgs = encodeAbiParameters(
    parseAbiParameters("string, string, uint8"),
    ["Clearing Bell Bond 2028 [DEMO]", "dCBB28", 18]
  );
  const bondAddress = await deployContract(
    deployer.wallet,
    pub,
    mockBondBytecode,
    bondCtorArgs
  );
  console.log("  MockBond deployed:", bondAddress);

  // ── 2. Deploy MockRegistry ──────────────────────────────────────────────
  console.log("Step 2/10 — Deploying MockIdentityRegistry...");
  const registryBytecode = loadBytecode(
    "MockIdentityRegistry.sol",
    "MockIdentityRegistry"
  );
  const registryAddress = await deployContract(
    deployer.wallet,
    pub,
    registryBytecode
  );
  console.log("  MockRegistry deployed:", registryAddress);

  // ── 3. KYC-approve Alice + Bob ──────────────────────────────────────────
  console.log("Step 3/10 — Granting KYC to Alice and Bob...");
  await waitFor(
    pub,
    await deployer.wallet.writeContract({
      address: registryAddress,
      abi: REGISTRY_ABI,
      functionName: "grant",
      args: [alice.address],
    })
  );
  await waitFor(
    pub,
    await deployer.wallet.writeContract({
      address: registryAddress,
      abi: REGISTRY_ABI,
      functionName: "grant",
      args: [bob.address],
    })
  );

  // Verify
  const aliceKyc = await pub.readContract({
    address: registryAddress,
    abi: REGISTRY_ABI,
    functionName: "isVerified",
    args: [alice.address],
  });
  const bobKyc = await pub.readContract({
    address: registryAddress,
    abi: REGISTRY_ABI,
    functionName: "isVerified",
    args: [bob.address],
  });
  console.log(`  Alice KYC: ${aliceKyc ? "✅" : "❌"}  Bob KYC: ${bobKyc ? "✅" : "❌"}`);

  // ── 4. Wire registry into ComplianceGate ───────────────────────────────
  console.log("Step 4/10 — Registering MockRegistry in ComplianceGate...");
  await waitFor(
    pub,
    await deployer.wallet.writeContract({
      address: GATE_ADDRESS,
      abi: GATE_ABI,
      functionName: "registerRegistry",
      args: [bondAddress, registryAddress],
    })
  );

  // Verify eligibility
  const aliceEligible = await pub.readContract({
    address: GATE_ADDRESS,
    abi: GATE_ABI,
    functionName: "isEligible",
    args: [alice.address, bondAddress],
  });
  console.log(
    `  ComplianceGate.isEligible(Alice, bond) = ${aliceEligible ? "✅ ELIGIBLE" : "❌ NOT ELIGIBLE"}`
  );

  // ── 5. Mint MockBond to Bob (seller) and USDC to Alice (buyer) ─────────
  console.log("Step 5/10 — Seeding balances...");
  // Mint 1000 bonds to Bob
  await waitFor(
    pub,
    await deployer.wallet.writeContract({
      address: bondAddress,
      abi: ERC20_ABI,
      functionName: "mint",
      args: [bob.address, tok(1000)],
    })
  );
  // Transfer 100k USDC to Alice (deployer has plenty)
  await waitFor(
    pub,
    await deployer.wallet.writeContract({
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [alice.address, usd(100_000)],
    })
  );

  const bobBondBal  = await pub.readContract({ address: bondAddress, abi: ERC20_ABI, functionName: "balanceOf", args: [bob.address] });
  const aliceUsdcBal = await pub.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [alice.address] });
  console.log(`  Bob bond balance   : ${fmtBond(bobBondBal)}`);
  console.log(`  Alice USDC balance : ${fmtUsdc(aliceUsdcBal)}`);

  // ── 6. Approve AuctionEngine to pull tokens ────────────────────────────
  console.log("Step 6/10 — Approving AuctionEngine for token pulls...");
  // Bob approves engine to pull his bonds (for sell settlement)
  await waitFor(
    pub,
    await bob.wallet.writeContract({
      address: bondAddress,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [ENGINE_ADDRESS, tok(10_000)], // plenty
    })
  );
  // Alice approves engine to pull her USDC (for buy settlement)
  await waitFor(
    pub,
    await alice.wallet.writeContract({
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [ENGINE_ADDRESS, usd(1_000_000)], // plenty
    })
  );
  console.log("  Bob approved engine for bonds ✅");
  console.log("  Alice approved engine for USDC ✅");

  // ── 7. Open auction round (10-min window) ─────────────────────────────
  console.log("Step 7/10 — Opening auction round...");
  const openHash = await deployer.wallet.writeContract({
    address: ENGINE_ADDRESS,
    abi: ENGINE_ABI,
    functionName: "openRound",
    args: [bondAddress, USDC_ADDRESS, 600n], // 10 min window
  });
  const openReceipt = await waitFor(pub, openHash);

  // Parse RoundOpened event to get roundId
  let roundId = 0n;
  for (const log of openReceipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: ENGINE_ABI, ...log });
      if (decoded.eventName === "RoundOpened") {
        roundId = decoded.args.roundId;
      }
    } catch {}
  }
  if (!roundId) throw new Error("Could not parse RoundOpened event");

  console.log(`  Round ${roundId} opened ✅`);
  console.log(`  HashScan tx: https://hashscan.io/testnet/transaction/${openHash}`);

  // ── 8. Bob submits SELL bid @ $95/bond, 100 bonds ─────────────────────
  console.log("");
  console.log("Step 8/10 — Bob submits SELL bid: 100 bonds @ $95.00...");
  const sellHash = await bob.wallet.writeContract({
    address: ENGINE_ADDRESS,
    abi: ENGINE_ABI,
    functionName: "submitBid",
    args: [roundId, usd(95), tok(100), false], // isBuy = false
  });
  await waitFor(pub, sellHash);
  console.log(`  SELL bid submitted ✅`);
  console.log(`  HashScan: https://hashscan.io/testnet/transaction/${sellHash}`);

  // ── 9. Alice submits BUY bid @ $105/bond, 100 bonds ───────────────────
  console.log("Step 9/10 — Alice submits BUY bid: 100 bonds @ $105.00...");
  const buyHash = await alice.wallet.writeContract({
    address: ENGINE_ADDRESS,
    abi: ENGINE_ABI,
    functionName: "submitBid",
    args: [roundId, usd(105), tok(100), true], // isBuy = true
  });
  await waitFor(pub, buyHash);
  console.log(`  BUY bid submitted ✅`);
  console.log(`  HashScan: https://hashscan.io/testnet/transaction/${buyHash}`);

  // Snapshot bids before clearing
  const bids = await pub.readContract({
    address: ENGINE_ADDRESS,
    abi: GET_BIDS_ABI,
    functionName: "getRoundBids",
    args: [roundId],
  });
  console.log("");
  console.log(`  Bids in round ${roundId}:`);
  for (const b of bids) {
    const side = b.isBuy ? "BUY " : "SELL";
    console.log(
      `    [${b.index}] ${side} ${fmtBond(b.quantity)} @ ${fmtUsdc(b.price)} — ${b.bidder}`
    );
  }

  // ── 10. Close and clear (issuer force-closes early) ───────────────────
  console.log("");
  console.log("Step 10/10 — Issuer calls closeAndClear()...");
  const clearHash = await deployer.wallet.writeContract({
    address: ENGINE_ADDRESS,
    abi: ENGINE_ABI,
    functionName: "closeAndClear",
    args: [roundId],
    gas: 500_000n,
  });
  const clearReceipt = await waitFor(pub, clearHash);
  console.log(`  closeAndClear tx: https://hashscan.io/testnet/transaction/${clearHash}`);

  // Parse events
  let clearingPrice = 0n;
  let clearedQty    = 0n;
  let hasCrossing   = false;

  for (const log of clearReceipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: ENGINE_ABI, ...log });
      if (decoded.eventName === "RoundCleared") {
        clearingPrice = decoded.args.clearingPrice;
        clearedQty    = decoded.args.clearedQuantity;
        hasCrossing   = true;
      } else if (decoded.eventName === "RoundClosedWithNoCrossing") {
        console.log("  ⚠️  No crossing — round closed with no trades");
      } else if (decoded.eventName === "Settled") {
        const side = decoded.args.isBuy ? "BUY " : "SELL";
        console.log(
          `  Settled: [${side}] ${fmtBond(decoded.args.filledQuantity)} @ ${fmtUsdc(decoded.args.settledPrice)} → ${decoded.args.bidder}`
        );
      }
    } catch {}
  }

  // Final round state
  const roundState = await pub.readContract({
    address: ENGINE_ADDRESS,
    abi: ENGINE_ABI,
    functionName: "rounds",
    args: [roundId],
  });
  const phaseNames = ["Closed", "Open", "Cleared"];
  const phase      = phaseNames[roundState[4]] ?? "Unknown";

  // Final balances
  const bobBondAfter   = await pub.readContract({ address: bondAddress,  abi: ERC20_ABI, functionName: "balanceOf", args: [bob.address] });
  const bobUsdcAfter   = await pub.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [bob.address] });
  const aliceBondAfter = await pub.readContract({ address: bondAddress,  abi: ERC20_ABI, functionName: "balanceOf", args: [alice.address] });
  const aliceUsdcAfter = await pub.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [alice.address] });

  console.log("");
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║                    AUCTION RESULTS                      ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log("");

  if (hasCrossing) {
    const settlementTotal = (clearedQty * clearingPrice) / 10n ** 18n;
    console.log(`  Clearing price     : ${fmtUsdc(clearingPrice)} per bond`);
    console.log(`  Cleared quantity   : ${fmtBond(clearedQty)}`);
    console.log(`  Total settlement   : ${fmtUsdc(settlementTotal)} USDC`);
    console.log(`  Round phase        : ${phase}`);
    console.log("");
    console.log("  Final Balances:");
    console.log(`    Alice — bonds: ${fmtBond(aliceBondAfter)}  USDC: ${fmtUsdc(aliceUsdcAfter)}`);
    console.log(`    Bob   — bonds: ${fmtBond(bobBondAfter)}  USDC: ${fmtUsdc(bobUsdcAfter)}`);
    console.log("");
    console.log("  What happened:");
    console.log("    Buy $105 crossed Sell $95 → clearing price = $95");
    console.log("    Alice paid 9,500 USDC and received 100 bonds ✅");
    console.log("    Bob  sent 100 bonds and received 9,500 USDC ✅");
    console.log("    Settlement was atomic (DvP) in a single tx ✅");
  }

  console.log("");
  console.log(`  HashScan engine: https://hashscan.io/testnet/contract/${ENGINE_ADDRESS}`);
  console.log(`  MockBond       : https://hashscan.io/testnet/contract/${bondAddress}`);
  console.log("");
  console.log("  Update .env:");
  console.log(`    BOND_TOKEN_ADDRESS=${bondAddress}`);
  console.log(`    ACTIVE_ROUND_ID=${roundId}`);
}

main().catch((e) => {
  console.error("\n❌ Demo failed:", e.shortMessage ?? e.message ?? e);
  if (e.cause) console.error("Cause:", e.cause?.shortMessage ?? e.cause?.message);
  process.exit(1);
});
