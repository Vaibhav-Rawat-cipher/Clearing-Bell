# Connected application architecture

## Runtime boundary

```text
React pages + shared components
             ↓
Wallet session and transaction coordinator
        ↙                         ↘
Read-only viem RPC client      EIP-1193 wallet
        ↓                     (local Anvil only in DEV)
        └───────────┬─────────────┘
               AuctionEngine
                ↙         ↘
      ComplianceGate      ClearingLib
             ↓                 ↓
      Identity registry   uniform-price allocations
                          and atomic ERC-20 transfers
```

The frontend is a static Vite build. Contracts are the application backend; no custom API server, private-key service, or database was introduced. The optional existing Uniswap hook is outside the verified frontend execution path.

## Module contracts

| Module | Responsibility |
| --- | --- |
| `src/lib/config.ts` | Parse explicit deployment settings or public manifest; restrict unlocked accounts to local development |
| `src/lib/chain.ts` | Validate chain/code, read rounds and public bids, resolve token metadata, registry result, balances, allowances and receipts |
| `src/lib/amounts.ts` | Exact BigInt parsing, token precision, overflow checks and total own-order funding exposure |
| `src/lib/errors.ts` | Translate wallet/RPC/contract errors into actionable messages |
| `src/context/` | Account/network changes, transaction lock, simulation, signature, receipt confirmation and refreshing |
| `src/components/ui/` | Accessible dialogs, status, error/empty/loading states and copy/explorer references |
| `src/components/scene/` | Optional lazy-loaded process schematic; never authoritative trading state |
| `src/pages/` | Task-focused views composed from the same read model |

Metadata is resolved from token contracts, not a hardcoded product catalogue. Portfolio quantities come from `balanceOf`; transaction receipts come from `Settled` events. The order depth chart comes from `getRoundBids`. Unknown values remain unknown.

## Actual auction lifecycle

1. Issuer calls `openRound(bondToken, settlementToken, bidWindowSeconds)`.
2. Eligible wallets approve their funding token and call `submitBid(roundId, price, quantity, isBuy)` before the deadline.
3. Orders are public and remain in contract storage. The contract does not escrow them or provide cancellation.
4. Issuer can call `closeAndClear` early; any wallet can call it after the deadline.
5. Eligibility is rechecked and revoked participants excluded before pricing and matching.
6. The engine computes a uniform price maximizing matched volume. Allocation has price priority and is pro-rata within each price level.
7. Buyers and sellers transfer payment and bonds atomically. Final round state is Closed; Cleared is an internal intermediate state.

Bond quantities use 18 decimals. Prices use settlement-token decimals per one whole bond. Payment uses cumulative-floor quotes per side so collected and distributed totals match; frontend buy approvals conservatively reserve the ceiling for each order.

## UI responsibilities

- **Home:** product purpose, latest actual round, process explanation, workflow entry points.
- **Markets:** searchable open/closed round directory; selecting a row selects that exact round.
- **Auction:** real deadline, public depth and order table, wallet eligibility, allowance + order controls, close confirmation and final result.
- **Portfolio:** balances, engine allowances, own open bids, settlement events, working CSV exports.
- **Issuer:** actual issuer authorization, create round, pause/resume, round review and deployed contract references.

Unsupported coupon schedules, sealed-order claims, fake price changes, static holdings and nonfunctional document actions were removed.

## Reliability and limits

- Deployment settings must be complete; no automatic external-network fallback.
- Account and selected-round changes invalidate stale in-flight reads.
- Refresh is periodic while visible, with manual retry.
- Every write validates wallet chain/account, simulates against the RPC and waits for successful inclusion.
- Transaction locks prevent duplicate clicks; unknown receipt outcomes poll the original hash.
- The environment name/chain remain visible. Local assets are identified as test assets.
- Local accounts never use private keys in browser code.
- The latest 100 rounds and 20,000 blocks of events are loaded with bounded request batches. This is intentionally not a production indexer.
- WebGL loads near the viewport, pauses offscreen, honors reduced motion and has a readable fallback. External Spline assets are optional and have a load timeout.

## What is not verified for production

Non-escrow settlement can be blocked by withdrawn funds/allowances. The local identity registry is a fixture. Uniswap real-PoolManager behavior remains outside this path. No CouponScheduler exists in this repository. Production deployment requires a real security/identity policy and an independent security review.
