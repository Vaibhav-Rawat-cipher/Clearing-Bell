/**
 * fix-gate.ts
 *
 * Deploys a Mock Identity Registry that always returns true,
 * then registers it with the existing ComplianceGate for the
 * existing Bond token. This bypasses the KYC check without
 * needing to redeploy the entire AuctionEngine stack.
 */

import { config } from "dotenv";
import { resolve, join } from "path";
import { readFileSync } from "fs";
import { createWalletClient, http, publicActions, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hederaTestnet } from "viem/chains";

config({ path: resolve(__dirname, "../.env") });

const RPC_URL = process.env.HEDERA_RPC_URL ?? "https://testnet.hashio.io/api";
const PKEY = process.env.DEPLOYER_PRIVATE_KEY as Hex;
const GATE_ADDR = process.env.COMPLIANCE_GATE_ADDRESS as Hex;
const BOND_ADDR = process.env.BOND_TOKEN_ADDRESS as Hex;

async function main() {
  const account = privateKeyToAccount(PKEY);
  const client = createWalletClient({
    account,
    chain: hederaTestnet,
    transport: http(RPC_URL),
  }).extend(publicActions);

  console.log("Deploying MockIdentityRegistry...");
  
  const artifactPath = join(__dirname, "../contracts/out/MockRegistry.sol/MockIdentityRegistry.json");
  const raw = JSON.parse(readFileSync(artifactPath, "utf8"));
  const abi = raw.abi;
  const bytecode = raw.bytecode.object as Hex;
  
  const hash = await client.deployContract({ abi, bytecode });
  const receipt = await client.waitForTransactionReceipt({ hash });
  const mockRegAddr = receipt.contractAddress!;
  console.log(`MockRegistry deployed at: ${mockRegAddr}`);
  
  console.log("Registering on ComplianceGate...");
  const gatePath = join(__dirname, "../contracts/out/ComplianceGate.sol/ComplianceGate.json");
  const gateRaw = JSON.parse(readFileSync(gatePath, "utf8"));
  
  const regHash = await client.writeContract({
    address: GATE_ADDR,
    abi: gateRaw.abi,
    functionName: "registerRegistry",
    args: [BOND_ADDR, mockRegAddr]
  });
  await client.waitForTransactionReceipt({ hash: regHash });
  console.log("✅ Registry successfully linked to ComplianceGate!");
}

main().catch(console.error);
