/**
 * seed-testnet.ts
 *
 * Creates 3 KYC-approved test investor wallets on Hedera testnet and registers
 * them with the ATS identity registry. Also funds them with testnet HBAR and
 * assigns mock USDC / bond token balances for demo purposes.
 *
 * Prerequisite .env keys:
 *   HEDERA_OPERATOR_ID, HEDERA_OPERATOR_KEY, HEDERA_NETWORK
 *   BOND_TOKEN_ADDRESS
 *   ATS_IDENTITY_REGISTRY_ADDRESS
 *   USDC_ADDRESS
 *   AUCTION_ENGINE_ADDRESS
 *
 * Usage:
 *   npx tsx scripts/seed-testnet.ts
 *
 * Personas:
 *   Alice  — institutional buyer (gets testnet USDC)
 *   Bob    — retail buyer (gets testnet USDC)
 *   Carol  — bond seller (gets CBB28 bond allocation)
 *
 * References: PLAN.md §10 / ARCHITECTURE.md §Testnet Configuration
 */

import { config } from "dotenv";
import {
  Client,
  AccountId,
  PrivateKey,
  AccountCreateTransaction,
  Hbar,
  TransferTransaction,
} from "@hashgraph/sdk";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hederaTestnet } from "viem/chains";

config({ path: "../.env" });

// ─── Config ──────────────────────────────────────────────────────────────────

const OPERATOR_ID  = AccountId.fromString(process.env.HEDERA_OPERATOR_ID!);
const OPERATOR_KEY = PrivateKey.fromStringECDSA(process.env.HEDERA_OPERATOR_KEY!);
const NETWORK      = (process.env.HEDERA_NETWORK ?? "testnet") as "testnet" | "mainnet";
const RPC_URL      = process.env.HEDERA_RPC_URL!;

const BOND_ADDRESS     = process.env.BOND_TOKEN_ADDRESS!;
const REGISTRY_ADDRESS = process.env.ATS_IDENTITY_REGISTRY_ADDRESS!;
const USDC_ADDRESS     = process.env.USDC_ADDRESS!;
const ENGINE_ADDRESS   = process.env.AUCTION_ENGINE_ADDRESS!;

// Seed amounts
const HBAR_SEED        = new Hbar(100);
const USDC_SEED_AMOUNT = 1_000_000n * 1_000_000n; // 1,000,000 USDC (6 dec)
const BOND_SEED_AMOUNT = 500_000n * BigInt(1e18);  // 500,000 CBB28 (18 dec)

// ─── Minimal ABIs ────────────────────────────────────────────────────────────

const ERC20_ABI = [
  { name: "transfer",  type: "function", inputs: [{name:"to",type:"address"},{name:"amount",type:"uint256"}] },
  { name: "approve",   type: "function", inputs: [{name:"spender",type:"address"},{name:"amount",type:"uint256"}] },
  { name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{name:"account",type:"address"}], outputs: [{type:"uint256"}] },
] as const;

const REGISTRY_ABI = [
  { name: "registerIdentity", type: "function",
    inputs: [{name:"userAddress",type:"address"},{name:"identity",type:"address"},{name:"country",type:"uint16"}] },
] as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildHederaClient(): Client {
  const client =
    NETWORK === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(OPERATOR_ID, OPERATOR_KEY);
  return client;
}

function buildViemClient(privateKey: `0x${string}`) {
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({
    account,
    chain: hederaTestnet,
    transport: http(RPC_URL),
  }).extend(publicActions);
}

interface Persona {
  name: string;
  privateKey: `0x${string}`;
  hederaAccountId?: string;
  role: "buyer" | "seller";
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Clearing Bell — Testnet Seeding ===");
  console.log(`Network: Hedera ${NETWORK}\n`);

  const hClient = buildHederaClient();

  // Use env keys if provided, otherwise generate fresh ones
  const personas: Persona[] = [
    {
      name:       "Alice (buyer)",
      privateKey: (process.env.ALICE_PRIVATE_KEY ?? PrivateKey.generateECDSA().toStringRaw()) as `0x${string}`,
      role:       "buyer",
    },
    {
      name:       "Bob (buyer)",
      privateKey: (process.env.BOB_PRIVATE_KEY ?? PrivateKey.generateECDSA().toStringRaw()) as `0x${string}`,
      role:       "buyer",
    },
    {
      name:       "Carol (seller)",
      privateKey: (process.env.CAROL_PRIVATE_KEY ?? PrivateKey.generateECDSA().toStringRaw()) as `0x${string}`,
      role:       "seller",
    },
  ];

  // Operator wallet (funds everyone)
  const operatorViemClient = buildViemClient(
    process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`
  );

  for (const p of personas) {
    console.log(`\n--- Setting up ${p.name} ---`);

    const account = privateKeyToAccount(p.privateKey);
    console.log(`  EVM address : ${account.address}`);

    // 1. Create Hedera account (auto-creates from EVM address alias)
    try {
      const createTx = await new AccountCreateTransaction()
        .setAlias(account.address)
        .setInitialBalance(HBAR_SEED)
        .execute(hClient);
      const receipt = await createTx.getReceipt(hClient);
      p.hederaAccountId = receipt.accountId?.toString();
      console.log(`  Hedera ID   : ${p.hederaAccountId}`);
    } catch {
      console.log(`  Hedera ID   : (alias account, may already exist)`);
    }

    // 2. Register on ATS identity registry (KYC approval)
    const operatorAccount = privateKeyToAccount(
      process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`
    );
    await operatorViemClient.writeContract({
      address: REGISTRY_ADDRESS as `0x${string}`,
      abi: REGISTRY_ABI,
      functionName: "registerIdentity",
      args: [account.address, account.address, 840], // 840 = US country code
    });
    console.log(`  KYC approved ✅`);

    // 3. Fund with tokens based on role
    const pViemClient = buildViemClient(p.privateKey);
    if (p.role === "buyer") {
      // Send USDC from operator to buyer
      await operatorViemClient.writeContract({
        address: USDC_ADDRESS as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [account.address, USDC_SEED_AMOUNT],
      });
      console.log(`  Funded with 1,000,000 USDC`);

      // Approve engine to pull USDC for settlement
      await pViemClient.writeContract({
        address: USDC_ADDRESS as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [ENGINE_ADDRESS as `0x${string}`, USDC_SEED_AMOUNT * 100n],
      });
      console.log(`  Engine approved for USDC ✅`);
    } else {
      // Send bond tokens from operator to seller
      await operatorViemClient.writeContract({
        address: BOND_ADDRESS as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [account.address, BOND_SEED_AMOUNT],
      });
      console.log(`  Funded with 500,000 CBB28`);

      // Approve engine to pull bond tokens for settlement
      await pViemClient.writeContract({
        address: BOND_ADDRESS as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [ENGINE_ADDRESS as `0x${string}`, BOND_SEED_AMOUNT * 100n],
      });
      console.log(`  Engine approved for bond ✅`);
    }

    console.log(`  HashScan: https://hashscan.io/${NETWORK}/account/${account.address}`);
  }

  hClient.close();

  console.log("\n=== Seeding Complete ===");
  console.log("Add these to your .env:");
  personas.forEach((p) => {
    const safeName = p.name.split(" ")[0].toUpperCase();
    console.log(`${safeName}_PRIVATE_KEY=${p.privateKey}`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
