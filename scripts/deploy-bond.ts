/**
 * deploy-bond.ts
 *
 * Deploys the Clearing Bell bond token via the REAL ATS Factory on Hedera Testnet.
 *
 * KEY FINDINGS:
 *  - The deployed factory (0.0.7708432) was compiled from v7.0.0 of the contracts,
 *    NOT v8.0.0.  The v7 SecurityData struct has a completely different field order,
 *    producing selector 0x5133f0e0 (vs 0x29002951 for v8).
 *  - configId = 0x2, configVersion = 1  (confirmed via live bond getConfigInfo())
 *  - ISIN checksum uses the exact algorithm from isinValidator.sol
 *
 * Factory Proxy : 0x5fA65CA30d1984701F10476664327f97c864A9D3  (0.0.7708432)
 * BLR Proxy     : 0xEFEF4CAe9642631Cfc6d997D6207Ee48fa78fe42  (0.0.7707874)
 *
 * Usage:  npm run deploy:bond
 */

import { config } from "dotenv";
import {
  createWalletClient,
  createPublicClient,
  http,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";
import * as path from "path";

config({ path: path.resolve(__dirname, "../.env") });

// ─── Chain ────────────────────────────────────────────────────────────────────
const hederaTestnet = defineChain({
  id: 296,
  name: "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 8 },
  rpcUrls: { default: { http: ["https://testnet.hashio.io/api"] } },
  blockExplorers: {
    default: { name: "HashScan", url: "https://hashscan.io/testnet" },
  },
});

// ─── ATS Infrastructure (Hedera Testnet — v7 deployment) ─────────────────────
const FACTORY_PROXY = "0x5fA65CA30d1984701F10476664327f97c864A9D3" as const;
const BLR_PROXY     = "0xEFEF4CAe9642631Cfc6d997D6207Ee48fa78fe42" as const;

// Confirmed from calling getConfigInfo() on a live ATS bond (0x8b728490...)
// returns: (BLR, 0x0000...0002, 1)
const BOND_CONFIG_KEY: `0x${string}` =
  "0x0000000000000000000000000000000000000000000000000000000000000002";
const CONFIG_VERSION = 1n;

// ─── ISIN Validation — mirrors isinValidator.sol exactly ─────────────────────
// _byteToCode: char > ASCII 57 ('9') → code-55 (A=10…Z=35), else code-48 (0=0…9=9)
function computeISINChecksum(isinFirst11: string): string {
  const byteToCode = (c: string) => {
    const code = c.charCodeAt(0);
    return code > 57 ? code - 55 : code - 48;
  };
  const conv: number[] = [];
  for (const c of isinFirst11) {
    const code = byteToCode(c);
    if (code > 9) { conv.push(Math.floor(code / 10)); conv.push(code % 10); }
    else conv.push(code);
  }
  // Luhn: pairing = (conv.length + 1) % 2
  const pairing = (conv.length + 1) % 2;
  let sum = 0;
  for (let i = 0; i < conv.length; i++) {
    let c = conv[i] * (i % 2 === pairing ? 2 : 1);
    if (c > 9) sum += Math.floor(c / 10) + (c % 10);
    else sum += c;
  }
  return String((10 - (sum % 10)) % 10);
}

const ISIN_BASE = "US0000CB202"; // 11 chars (CC + NSIN)
const BOND_ISIN = ISIN_BASE + computeISINChecksum(ISIN_BASE);

// ─── Bond Parameters ──────────────────────────────────────────────────────────
const USD_BYTES3: `0x${string}` = toHex("USD", { size: 3 });
const NOMINAL_VALUE          = 100n;             // 1.00 USD
const NOMINAL_VALUE_DECIMALS = 2;
const MAX_SUPPLY             = 1_000_000n * 10n ** 6n; // 1M tokens @ 6 decimals
const STARTING_DATE          = BigInt(Math.floor(Date.now() / 1000));
const MATURITY_DATE          = 1861862400n;      // 2028-12-31 UTC

// ─── Factory ABI — v7.0.0 SecurityData field order ───────────────────────────
// CRITICAL: The deployed factory is v7, where SecurityData fields are ordered:
//   arePartitionsProtected, isMultiPartition, resolver,
//   resolverProxyConfiguration, rbacs,
//   isControllable, isWhiteList, maxSupply, erc20MetadataInfo,
//   clearingActive, internalKycActivated,
//   externalPauses[], externalControlLists[], externalKycLists[],
//   erc20VotesActivated, compliance, identityRegistry
//
// This produces selector 0x5133f0e0 (confirmed match with on-chain successful txs)
const FACTORY_ABI = [
  {
    name: "deployBond",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "_bondData",
        type: "tuple",
        components: [
          {
            name: "security",
            type: "tuple",
            // v7 field order — DO NOT REORDER
            components: [
              { name: "arePartitionsProtected", type: "bool"    },
              { name: "isMultiPartition",        type: "bool"    },
              { name: "resolver",                type: "address" },
              {
                name: "resolverProxyConfiguration",
                type: "tuple",
                components: [
                  { name: "key",     type: "bytes32" },
                  { name: "version", type: "uint256" },
                ],
              },
              {
                name: "rbacs",
                type: "tuple[]",
                components: [
                  { name: "role",    type: "bytes32"   },
                  { name: "members", type: "address[]" },
                ],
              },
              { name: "isControllable",       type: "bool"    },
              { name: "isWhiteList",          type: "bool"    },
              { name: "maxSupply",            type: "uint256" },
              {
                name: "erc20MetadataInfo",
                type: "tuple",
                components: [
                  { name: "name",     type: "string" },
                  { name: "symbol",   type: "string" },
                  { name: "isin",     type: "string" },
                  { name: "decimals", type: "uint8"  },
                ],
              },
              { name: "clearingActive",       type: "bool"      },
              { name: "internalKycActivated", type: "bool"      },
              { name: "externalPauses",       type: "address[]" },
              { name: "externalControlLists", type: "address[]" },
              { name: "externalKycLists",     type: "address[]" },
              { name: "erc20VotesActivated",  type: "bool"      },
              { name: "compliance",           type: "address"   },
              { name: "identityRegistry",     type: "address"   },
            ],
          },
          {
            name: "bondDetails",
            type: "tuple",
            components: [
              { name: "currency",             type: "bytes3"  },
              { name: "nominalValue",         type: "uint256" },
              { name: "nominalValueDecimals", type: "uint8"   },
              { name: "startingDate",         type: "uint256" },
              { name: "maturityDate",         type: "uint256" },
            ],
          },
          { name: "proceedRecipients",     type: "address[]" },
          { name: "proceedRecipientsData", type: "bytes[]"   },
        ],
      },
      {
        name: "_factoryRegulationData",
        type: "tuple",
        components: [
          { name: "regulationType",    type: "uint8" },
          { name: "regulationSubType", type: "uint8" },
          {
            name: "additionalSecurityData",
            type: "tuple",
            components: [
              { name: "countriesControlListType", type: "bool"   },
              { name: "listOfCountries",          type: "string" },
              { name: "info",                     type: "string" },
            ],
          },
        ],
      },
    ],
    outputs: [{ name: "bondAddress_", type: "address" }],
  },
] as const;

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey || !privateKey.startsWith("0x")) {
    throw new Error(
      "DEPLOYER_PRIVATE_KEY missing or not 0x-prefixed in .env\n" +
      "Must be the HEX-ENCODED ECDSA private key from Hedera Portal."
    );
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const deployer = account.address;

  // Verify selector is correct before sending any tx
  const { keccak256, toBytes } = await import("viem");
  const SIG =
    "deployBond(((bool,bool,address,(bytes32,uint256),(bytes32,address[])[],bool,bool,uint256,(string,string,string,uint8),bool,bool,address[],address[],address[],bool,address,address),(bytes3,uint256,uint8,uint256,uint256),address[],bytes[]),(uint8,uint8,(bool,string,string)))";
  const computedSelector = keccak256(toBytes(SIG)).slice(0, 10);

  console.log("=== Clearing Bell — ATS Bond Deployment ===");
  console.log(`Network    : Hedera Testnet (chain 296)`);
  console.log(`Deployer   : ${deployer}`);
  console.log(`Factory    : ${FACTORY_PROXY}`);
  console.log(`BLR Proxy  : ${BLR_PROXY}`);
  console.log(`ISIN       : ${BOND_ISIN}`);
  console.log(`configKey  : ${BOND_CONFIG_KEY}`);
  console.log(`configVer  : ${CONFIG_VERSION}`);
  console.log(`Selector   : ${computedSelector} (expected 0x5133f0e0 — match: ${computedSelector === "0x5133f0e0"})`);
  console.log("");

  if (computedSelector !== "0x5133f0e0") {
    throw new Error(
      `Selector mismatch! Computed ${computedSelector} but expected 0x5133f0e0. ` +
      "The ABI struct field order is wrong."
    );
  }

  const walletClient = createWalletClient({
    account,
    chain: hederaTestnet,
    transport: http("https://testnet.hashio.io/api"),
  });

  const publicClient = createPublicClient({
    chain: hederaTestnet,
    transport: http("https://testnet.hashio.io/api"),
  });

  console.log("Submitting deployBond transaction...");

  const txHash = await walletClient.writeContract({
    address: FACTORY_PROXY,
    abi: FACTORY_ABI,
    functionName: "deployBond",
    gas: 15_000_000n, // ATS SDK GAS.CREATE_BOND_ST = 15_000_000
    args: [
      {
        security: {
          // v7 field order
          arePartitionsProtected: false,
          isMultiPartition:        false,
          resolver:                BLR_PROXY,
          resolverProxyConfiguration: {
            key:     BOND_CONFIG_KEY,
            version: CONFIG_VERSION,
          },
          rbacs: [
            {
              role: "0x0000000000000000000000000000000000000000000000000000000000000000",
              members: [deployer],
            },
          ],
          isControllable:       true,
          isWhiteList:          true,
          maxSupply:            MAX_SUPPLY,
          erc20MetadataInfo: {
            name:     "Clearing Bell Bond 2028",
            symbol:   "CBB28",
            isin:     BOND_ISIN,
            decimals: 6,
          },
          clearingActive:       false,
          internalKycActivated: true,
          externalPauses:       [],
          externalControlLists: [],
          externalKycLists:     [],
          erc20VotesActivated:  false,
          compliance:       "0x0000000000000000000000000000000000000000",
          identityRegistry: "0x0000000000000000000000000000000000000000",
        },
        bondDetails: {
          currency:             USD_BYTES3,
          nominalValue:         NOMINAL_VALUE,
          nominalValueDecimals: NOMINAL_VALUE_DECIMALS,
          startingDate:         STARTING_DATE,
          maturityDate:         MATURITY_DATE,
        },
        proceedRecipients:     [],
        proceedRecipientsData: [],
      },
      {
        regulationType:    0,
        regulationSubType: 0,
        additionalSecurityData: {
          countriesControlListType: false,
          listOfCountries: "",
          info: "Clearing Bell Bond 2028 — ETHOnline hackathon demo",
        },
      },
    ],
  });

  console.log(`Tx submitted  : ${txHash}`);
  console.log(`HashScan tx   : https://hashscan.io/testnet/tx/${txHash}`);
  console.log("Waiting for confirmation...");

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: 120_000,
  });

  if (receipt.status !== "success") {
    console.error(`\n❌  Tx status: ${receipt.status}`);
    console.error(`Check HashScan: https://hashscan.io/testnet/tx/${txHash}`);
    throw new Error(`Transaction reverted`);
  }

  // BondDeployed event topic0 confirmed from factory logs
  const BOND_DEPLOYED_TOPIC =
    "0x01d3e27a30d468a96e49f71ff84af896733789c198ff030dae07d2d9ae9e9f17";

  let bondAddress: string | undefined;
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() === FACTORY_PROXY.toLowerCase() &&
      log.topics[0] === BOND_DEPLOYED_TOPIC &&
      log.data &&
      log.data.length >= 66
    ) {
      // bondAddress is the first 32-byte word in the event data
      bondAddress = "0x" + log.data.slice(26, 66);
      break;
    }
  }

  console.log("\n✅  Bond deployed successfully!");
  if (bondAddress) {
    console.log(`Bond address  : ${bondAddress}`);
    console.log(`HashScan      : https://hashscan.io/testnet/contract/${bondAddress}`);
    console.log("\n─── Add to your .env ─────────────────────────────");
    console.log(`BOND_TOKEN_ADDRESS=${bondAddress}`);
    console.log("──────────────────────────────────────────────────");
    console.log("\nNext steps:");
    console.log(
      "  1. cd ../contracts && forge script script/Deploy.s.sol --rpc-url https://testnet.hashio.io/api --broadcast"
    );
    console.log("  2. npx ts-node seed-testnet.ts");
  } else {
    console.log(
      `Bond address could not be parsed from logs — check HashScan tx above.`
    );
  }
}

main().catch((e) => {
  console.error("\n❌  Deployment failed:", e.shortMessage || e.message);
  if (e.cause) console.error("Cause:", e.cause?.shortMessage || e.cause?.message);
  process.exit(1);
});
