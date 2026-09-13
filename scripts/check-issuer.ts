import { createPublicClient, http, parseAbi } from 'viem';
import { hederaTestnet } from 'viem/chains';

const pub = createPublicClient({
  chain: hederaTestnet,
  transport: http('https://testnet.hashio.io/api', { timeout: 30_000 }),
});

const NEW_ENGINE = '0x90ab5537d8b2131519a9af560959d0a59bb69974' as const;
const OLD_ENGINE = '0x663d1825f7a1eb323eb531152e23720c7f2ad7a2' as const;

const issuerAbi = parseAbi([
  'function issuer() view returns (address)',
  'function nextRoundId() view returns (uint256)',
  'function paused() view returns (bool)',
]);

async function tryRead(addr: `0x${string}`, label: string) {
  try {
    const issuer = await pub.readContract({ address: addr, abi: issuerAbi, functionName: 'issuer' });
    const rid = await pub.readContract({ address: addr, abi: issuerAbi, functionName: 'nextRoundId' });
    const paused = await pub.readContract({ address: addr, abi: issuerAbi, functionName: 'paused' });
    console.log(`${label}:`);
    console.log(`  issuer      = ${issuer}`);
    console.log(`  nextRoundId = ${rid}`);
    console.log(`  paused      = ${paused}`);
  } catch (e: any) {
    console.log(`${label}: ERROR - ${e.shortMessage ?? e.message}`);
  }
}

async function main() {
  console.log('Checking AuctionEngine contracts on Hedera testnet...\n');
  await tryRead(NEW_ENGINE, 'NEW Engine (0x90ab5537...)');
  console.log('');
  await tryRead(OLD_ENGINE, 'OLD Engine (0x663d1825...)');
  console.log('\nDeployer address: 0x26b3DFD284226781B0358217a9c8A724DE1d0e0c');
  console.log('Done.');
}

main().catch(console.error);
