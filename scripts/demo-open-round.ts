/**
 * demo-open-round.ts  — DEMO STEP 1
 *
 * Deploys fresh bond + registry, KYCs wallets, seeds tokens,
 * opens a 10-minute auction round, saves demo-state.json.
 *
 * Usage:  npx tsx scripts/demo-open-round.ts
 */

import { config } from "dotenv";
import {
  createWalletClient, createPublicClient, http, parseAbi,
  encodeAbiParameters, parseAbiParameters, decodeEventLog,
  type Hex, type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hederaTestnet } from "viem/chains";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import * as path from "path";

config({ path: path.resolve(__dirname, "../.env") });

const GATE_ADDRESS   = (process.env.COMPLIANCE_GATE_ADDRESS || "0x59ace2042088dc40790a456f6af24febdbb4dfc7") as Address;
const ENGINE_ADDRESS = (process.env.AUCTION_ENGINE_ADDRESS  || "0x663d1825f7a1eb323eb531152e23720c7f2ad7a2") as Address;
const USDC_ADDRESS   = (process.env.USDC_ADDRESS            || "0x37a4ae6511f491c5a07fbf61f6cf8b292727d255") as Address;
const RPC_URL = "https://testnet.hashio.io/api";

const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY as Hex;
const ALICE_KEY    = process.env.ALICE_PRIVATE_KEY    as Hex;
const BOB_KEY      = process.env.BOB_PRIVATE_KEY      as Hex;
if (!DEPLOYER_KEY || !ALICE_KEY || !BOB_KEY) throw new Error("Missing keys in .env");

const ERC20_ABI = parseAbi([
  "function mint(address to, uint256 amount) external",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function transfer(address to, uint256 amount) external returns (bool)",
]);
const REGISTRY_ABI = parseAbi(["function grant(address user) external"]);
const GATE_ABI     = parseAbi(["function registerRegistry(address bondToken, address registry) external"]);
const ENGINE_ABI   = parseAbi([
  "function openRound(address bondToken, address settlementToken, uint256 bidWindow) external returns (uint256)",
  "event RoundOpened(uint256 indexed roundId, address indexed bondToken, address settlementToken, uint256 openDeadline)",
]);

function makeClients(key: Hex) {
  const account = privateKeyToAccount(key);
  const wallet  = createWalletClient({ account, chain: hederaTestnet, transport: http(RPC_URL) });
  const pub     = createPublicClient({ chain: hederaTestnet, transport: http(RPC_URL) });
  return { wallet, pub, address: account.address };
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

async function main() {
  const D = makeClients(DEPLOYER_KEY);
  const A = makeClients(ALICE_KEY);
  const B = makeClients(BOB_KEY);
  const pub = D.pub;

  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log(  "║  DEMO STEP 1 — Open Auction Round                   ║");
  console.log(  "╚══════════════════════════════════════════════════════╝\n");
  console.log("  Deployer :", D.address);
  console.log("  Alice    :", A.address);
  console.log("  Bob      :", B.address, "\n");

  // 1. Deploy MockBond
  process.stdout.write("1/7  Deploying MockBond (CBDB)... ");
  const bondAddress = await deploy(D.wallet, pub,
    loadBytecode("MockERC20.sol", "MockERC20"),
    encodeAbiParameters(parseAbiParameters("string,string,uint8"), ["Clearing Bell Demo Bond", "CBDB", 18])
  );
  console.log("✅", bondAddress);

  // 2. Deploy MockRegistry
  process.stdout.write("2/7  Deploying MockIdentityRegistry... ");
  const registryAddress = await deploy(D.wallet, pub, loadBytecode("MockIdentityRegistry.sol", "MockIdentityRegistry"));
  console.log("✅", registryAddress);

  // 3. KYC all bidders
  process.stdout.write("3/7  Granting KYC (Deployer, Alice, Bob)... ");
  for (const addr of [D.address, A.address, B.address]) {
    await waitFor(pub, await D.wallet.writeContract({ address: registryAddress, abi: REGISTRY_ABI, functionName: "grant", args: [addr] }));
  }
  console.log("✅");

  // 4. Register registry in ComplianceGate
  process.stdout.write("4/7  Registering registry in ComplianceGate... ");
  await waitFor(pub, await D.wallet.writeContract({ address: GATE_ADDRESS, abi: GATE_ABI, functionName: "registerRegistry", args: [bondAddress, registryAddress] }));
  console.log("✅");

  // 5. Seed tokens
  process.stdout.write("5/7  Seeding tokens... ");
  await waitFor(pub, await D.wallet.writeContract({ address: bondAddress, abi: ERC20_ABI, functionName: "mint", args: [B.address, 500n * 10n ** 18n] }));
  await waitFor(pub, await D.wallet.writeContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "transfer", args: [A.address, 100_000n * 10n ** 6n] }));
  console.log("✅  Bob: 500 CBDB  |  Alice: 100,000 USDC");

  // 6. Set approvals
  process.stdout.write("6/7  Setting token approvals... ");
  const MAX = 2n ** 256n - 1n;
  await waitFor(pub, await A.wallet.writeContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "approve", args: [ENGINE_ADDRESS, MAX] }));
  await waitFor(pub, await B.wallet.writeContract({ address: bondAddress,  abi: ERC20_ABI, functionName: "approve", args: [ENGINE_ADDRESS, MAX] }));
  await waitFor(pub, await D.wallet.writeContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "approve", args: [ENGINE_ADDRESS, MAX] }));
  console.log("✅");

  // 7. Open round
  process.stdout.write("7/7  Opening 10-minute auction round... ");
  const hash = await D.wallet.writeContract({ address: ENGINE_ADDRESS, abi: ENGINE_ABI, functionName: "openRound", args: [bondAddress, USDC_ADDRESS, 600n] });
  const receipt = await waitFor(pub, hash);

  let roundId = 0n, deadline = 0n;
  for (const log of receipt.logs) {
    try {
      const d = decodeEventLog({ abi: ENGINE_ABI, ...log });
      if (d.eventName === "RoundOpened") { roundId = d.args.roundId; deadline = d.args.openDeadline; }
    } catch {}
  }
  if (!roundId) throw new Error("Could not parse RoundOpened");
  console.log(`✅  Round #${roundId}`);

  // Save state
  const state = { roundId: roundId.toString(), bondAddress, registryAddress, deadline: deadline.toString(), openedAt: new Date().toISOString() };
  writeFileSync(path.resolve(__dirname, "demo-state.json"), JSON.stringify(state, null, 2));

  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log(  "║  ✅  ROUND OPEN — refresh the frontend!              ║");
  console.log(  "╚══════════════════════════════════════════════════════╝\n");
  console.log(`  Bond      : ${bondAddress}`);
  console.log(`  Round ID  : ${roundId}`);
  console.log(`  Closes    : ${new Date(Number(deadline) * 1000).toLocaleTimeString()}`);
  console.log(`  Frontend  : http://127.0.0.1:5173\n`);
  console.log("  ➜  Next: npx tsx scripts/demo-bid-alice.ts");
}
main().catch(e => { console.error("\n❌", e.shortMessage ?? e.message); process.exit(1); });
