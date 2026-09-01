/**
 * deploy-bond.ts
 *
 * Deploys the ATS bond token on Hedera testnet using the
 * Hedera Asset Tokenization SDK. This is the FIRST deploy script to run.
 *
 * Prerequisites:
 *   - .env populated with HEDERA_OPERATOR_ID, HEDERA_OPERATOR_KEY, HEDERA_NETWORK
 *   - `npm install` run in this directory
 *
 * Usage:
 *   npx tsx scripts/deploy-bond.ts
 *
 * After this runs, copy the output BOND_TOKEN_ADDRESS and
 * ATS_IDENTITY_REGISTRY_ADDRESS into your .env, then run deploy-auction.ts.
 *
 * References:
 *   - PLAN.md §4.1 / §10
 *   - https://docs.tokenization-studio.hedera.com/ats/creating-bond
 */

import { config } from "dotenv";
import {
  Client,
  AccountId,
  PrivateKey,
} from "@hashgraph/sdk";

config({ path: "../.env" });

// ─── Config ──────────────────────────────────────────────────────────────────

const OPERATOR_ID  = AccountId.fromString(process.env.HEDERA_OPERATOR_ID!);
const OPERATOR_KEY = PrivateKey.fromStringECDSA(process.env.HEDERA_OPERATOR_KEY!);
const NETWORK      = (process.env.HEDERA_NETWORK ?? "testnet") as "testnet" | "mainnet";

// Bond parameters (per BondConfig.sol constants)
const BOND_PARAMS = {
  name:            "Clearing Bell Bond 2028",
  symbol:          "CBB28",
  decimals:        18,
  totalSupply:     1_000_000n * BigInt(1e18),
  couponRateBps:   550,    // 5.50%
  maturityDate:    1861862400n, // 2028-12-31 UTC
  maxHolders:      1000,
  settlementToken: process.env.USDC_ADDRESS ?? "0x0000000000000000000000000000000000000000",
} as const;

// ─── Hedera Client ──────────────────────────────────────────────────────────

function buildClient(): Client {
  const client =
    NETWORK === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(OPERATOR_ID, OPERATOR_KEY);
  return client;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const client = buildClient();
  console.log("=== Clearing Bell — ATS Bond Deployment ===");
  console.log(`Network   : Hedera ${NETWORK}`);
  console.log(`Operator  : ${OPERATOR_ID.toString()}`);
  console.log(`Bond name : ${BOND_PARAMS.name}`);
  console.log("");

  // NOTE: The Hedera Asset Tokenization SDK is pre-release.
  // The exact API below matches the SDK's documented interface as of v0.1.x.
  // If you encounter import errors, check the latest SDK changelog:
  //   https://github.com/hashgraph/asset-tokenization-studio/releases

  try {
    // Dynamic import to avoid build errors if the SDK version changes
    const { SecurityFactory } = await import(
      "@hashgraph/asset-tokenization-sdk" as string
    );

    const factory = new SecurityFactory({ client });

    console.log("Deploying ATS bond via SecurityFactory...");
    const result = await factory.deployBond({
      name:         BOND_PARAMS.name,
      symbol:       BOND_PARAMS.symbol,
      decimals:     BOND_PARAMS.decimals,
      totalSupply:  BOND_PARAMS.totalSupply,
      couponRate:   BOND_PARAMS.couponRateBps,
      maturityDate: BOND_PARAMS.maturityDate,
      maxHolders:   BOND_PARAMS.maxHolders,
    });

    const bondAddress      = result.tokenAddress;
    const registryAddress  = result.identityRegistryAddress;

    console.log("\n✅ Bond deployed successfully!");
    console.log(`Bond token address     : ${bondAddress}`);
    console.log(`Identity registry      : ${registryAddress}`);
    console.log(`HashScan (bond)        : https://hashscan.io/${NETWORK}/token/${bondAddress}`);
    console.log(`HashScan (registry)    : https://hashscan.io/${NETWORK}/contract/${registryAddress}`);

    console.log("\nAdd to your .env:");
    console.log(`BOND_TOKEN_ADDRESS=${bondAddress}`);
    console.log(`ATS_IDENTITY_REGISTRY_ADDRESS=${registryAddress}`);

    client.close();
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("Cannot find module")) {
      console.error(
        "❌ @hashgraph/asset-tokenization-sdk not available.\n" +
        "   Run `npm install` in this directory, then try again.\n" +
        "   If the SDK is pre-release, check the private registry instructions\n" +
        "   in the hackathon Hedera track docs.\n"
      );
    } else {
      throw err;
    }
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
