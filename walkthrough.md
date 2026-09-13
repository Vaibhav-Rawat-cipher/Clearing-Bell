# 🔔 Clearing Bell — End-to-End Demo Results

> **Hedera Testnet** · Chain 296 · Block `#40,439,943`

## ✅ Hook Demo — All 11 Steps Passed

The full Uniswap v4 hook E2E test ran successfully on Hedera testnet on **2026-09-13**.

### Deployed This Run
| Contract | Address | HashScan |
|---|---|---|
| `TestnetPoolManager` | `0x9536a6b8e6f4fc4953963f326acfeff8659cfbe7` | [View](https://hashscan.io/testnet/contract/0x9536a6b8e6f4fc4953963f326acfeff8659cfbe7) |
| `ClearingBellHookTestnet` | `0xf22edcfbf1318900888a195a826516d3aa404017` | [View](https://hashscan.io/testnet/contract/0xf22edcfbf1318900888a195a826516d3aa404017) |
| `MockBond (hBND)` | `0x6148d6a1b3f295875f805c4198bb10ea11b67bf8` | [View](https://hashscan.io/testnet/contract/0x6148d6a1b3f295875f805c4198bb10ea11b67bf8) |
| `MockIdentityRegistry` | `0xe8e93a92c1a05d6cb3fc38dd0fce8ecd155be939` | — |

### Pre-Deployed (Production)
| Contract | Address |
|---|---|
| `AuctionEngine` | `0x663d1825f7a1eb323eb531152e23720c7f2ad7a2` |
| `ComplianceGate` | `0x59ace2042088dc40790a456f6af24febdbb4dfc7` |
| `USDC` | `0x37a4ae6511f491c5a07fbf61f6cf8b292727d255` |

---

## Hook Flow Verification

| Step | Result | Description |
|---|---|---|
| Deploy TestnetPoolManager | ✅ | Uniswap v4 PoolManager stand-in |
| Deploy ClearingBellHookTestnet | ✅ | Hook without address validation (testnet variant) |
| Authorize hook as bid relayer | ✅ | Engine grants hook relay permissions |
| Deploy MockBond + MockRegistry | ✅ | ERC-20 + identity registry |
| Alice KYC'd | ✅ | `isEligible(alice) = true` |
| Carol NOT KYC'd | ✅ | `isEligible(carol) = false` |
| Seed tokens + approvals | ✅ | 200 bonds → Bob, 50k USDC → Alice |
| Open Round 13 + wire hook | ✅ | `hook.activeRound = 13` |
| **Alice swap → BUY bid queued** | ✅ | `BidQueued: BUY 100 bonds @ $105.00` |
| **Bob swap → SELL bid queued** | ✅ | `BidQueued: SELL 100 bonds @ $95.00` |
| **Carol swap → REJECTED** | ✅ | `BidderNotEligible` — KYC gate enforced |
| `closeAndClear()` | ✅ | Clearing price = **$95.00** / bond |
| Settled BUY | ✅ | 100 bonds @ $95.00 = **$9,500 USDC** |
| Settled SELL | ✅ | 100 bonds @ $95.00 = **$9,500 USDC** |
| `hook.afterEpochClose()` | ✅ | `ClearingPriceUpdated: $95.00` |
| **Price synced to hook** | ✅ | `hook.lastClearingPrice == engine clearingPrice` |

### Key Transactions (HashScan)
- Alice swap: [0x2b5258...](https://hashscan.io/testnet/transaction/0x2b5258768b08d6fada06d34d08279b75e03874a026c0ff45946f378a2c758cd9)
- Bob swap: [0x657409...](https://hashscan.io/testnet/transaction/0x657409a301e6ac686eb38452b004e357e9fd02508345c4fdb9083ab80c1ad0ed)
- closeAndClear: [0xf5ea24...](https://hashscan.io/testnet/transaction/0xf5ea24c3e4ec412b0664c8c20528a44378ebb95b4a221078b7dcd540f6e108f3)
- afterEpochClose: [0x86aed3...](https://hashscan.io/testnet/transaction/0x86aed337c22b26d4ecabbc98353a63587b6c8168bfe7ff8342e7798102fff13a)

---

## Frontend — Live & Connected

**URL**: http://127.0.0.1:5173

### Chain Data (Live from Hedera Testnet)
- **Open rounds**: 7
- **Closed rounds**: 6
- **Total orders received**: 19
- **Latest block**: `#40,439,943`
- **Network**: Hedera Testnet / Chain 296
- **Errors**: None

---

## Recording

![Demo Recording](file:///C:/Users/VAIBHAV/.gemini/antigravity-ide/brain/ebb9e643-76c4-4b22-b6ea-c9cf42fcfa8d/clearing_bell_live_demo_1789251657017.webp)

---

## Page Screenshots

````carousel
![Home Page](file:///C:/Users/VAIBHAV/.gemini/antigravity-ide/brain/ebb9e643-76c4-4b22-b6ea-c9cf42fcfa8d/home_page_1789251668510.png)

<!-- slide -->
![Markets Page — Live hBND/USDC Rounds](file:///C:/Users/VAIBHAV/.gemini/antigravity-ide/brain/ebb9e643-76c4-4b22-b6ea-c9cf42fcfa8d/markets_page_loaded_1789251686702.png)

<!-- slide -->
![Auction Workspace — Round #012](file:///C:/Users/VAIBHAV/.gemini/antigravity-ide/brain/ebb9e643-76c4-4b22-b6ea-c9cf42fcfa8d/auction_page_1789251701411.png)

<!-- slide -->
![Issuer Console — 7 Open, 6 Closed, 19 Orders](file:///C:/Users/VAIBHAV/.gemini/antigravity-ide/brain/ebb9e643-76c4-4b22-b6ea-c9cf42fcfa8d/issuer_page_1789251721952.png)

<!-- slide -->
![Portfolio Page](file:///C:/Users/VAIBHAV/.gemini/antigravity-ide/brain/ebb9e643-76c4-4b22-b6ea-c9cf42fcfa8d/portfolio_page_1789251740387.png)
````

---

## Scripts Available for Video Demo

```bash
# Full hook demo (deploys hook, runs Alice/Bob/Carol swaps, settles)
npx tsx scripts/run-hook-demo.ts

# Basic auction demo (2 bidders, clearing price computation)
npx tsx scripts/run-auction-demo.ts

# Multi-bidder demo (4 bidders, uniform price discovery)
npx tsx scripts/run-multi-bidder-demo.ts

# Frontend (already running)
npm run dev --prefix frontend
# → http://127.0.0.1:5173
```
