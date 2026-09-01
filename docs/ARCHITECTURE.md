# Clearing Bell — Architecture

## System Overview

Clearing Bell is a compliance-gated batch-auction secondary market for tokenized securities. It combines Hedera ATS for compliant bond issuance with a Uniswap v4 hook that intercepts swaps and routes them through a periodic batch auction engine.

## Component Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Hedera Testnet                                │
│                                                                      │
│  ┌──────────────┐     ┌─────────────────┐     ┌─────────────────┐    │
│  │   Hedera     │     │   Uniswap v4    │     │   Frontend      │    │
│  │     ATS      │     │   PoolManager   │     │   Frontend      │    │
│  │              │     │                 │     │                 │    │
│  │  Bond Token  │     │  ┌───────────┐  │     │  /issuer        │    │
│  │  (ERC-3643)  │     │  │ Clearing  │  │     │  /bidder        │    │
│  │              │     │  │ BellHook  │  │     │  /auctions/[id] │    │
│  │  Identity    │◄────┼──│           │  │     │                 │    │
│  │  Registry    │     │  │beforeSwap │  │     └────────┬────────┘    │
│  │  (KYC store) │     │  └─────┬─────┘  │              │             │
│  └──────────────┘     │        │        │              │             │
│         ▲             └────────┼────────┘     JSON-RPC │             │
│         │                      │                       │             │
│  ┌──────┴──────┐     ┌─────────▼──────────────────────▼──────────┐   │
│  │ Compliance  │     │              AuctionEngine                  │ │
│  │    Gate     │◄────│                                             │ │
│  │             │     │  openRound() → submitBid() → closeAndClear()│ │
│  │ isEligible()│     │                                             │ │
│  └─────────────┘     │  ┌──────────────────────────────────────┐   │ │
│                      │  │             ClearingLib              │   │ │
│                      │  │  (pure library — no state)           │   │ │
│                      │  │                                      │   │ │
│                      │  │  computeClearingPrice(bids[])        |   │ │
│                      │  │  matchBids(bids[], clearingPrice)    │   │ │
│                      │  └──────────────────────────────────────┘   │ │
│                      └─────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

## Data Flow: Full Auction Round

```
1. Issuer                AuctionEngine.openRound(bondToken, window)
                                  │
2. Bidder A/B/C          submitBid(roundId, price, qty, isSell)
                                  │
                         ComplianceGate.isEligible(bidder) ─── if false: revert
                                  │
3. [time passes / manual close]
                                  │
4. Anyone                closeAndClear(roundId)
                                  │
                         ClearingLib.computeClearingPrice(allBids)
                                  ▼
                         clearingPrice set, phase = Cleared
                                  │
5. Settlement            settle(roundId) ← called internally
                                  │
                         For each filled bid:
                           if buyer: receive bond tokens, pay USDC
                           if seller: receive USDC, transfer bond tokens
                         All in a single atomic transaction
```

## Contract Responsibilities

| Contract | Type | State | Key Dependencies |
|---|---|---|---|
| `ClearingLib` | Library | None (pure) | — |
| `ComplianceGate` | Contract | None (view-only) | ATS Identity Registry |
| `AuctionEngine` | Contract | Rounds, Bids | ClearingLib, ComplianceGate |
| `ClearingBellHook` | Contract | Pool state | AuctionEngine, PoolManager |
| `BondConfig` | Script/Config | Deployed via ATS | ATS SDK |
| `CouponScheduler` | Contract | Scheduled actions | ATS Corporate Actions |

## Phase State Machine (AuctionRound)

```
         openRound()              closeAndClear()
Closed ──────────────► Open ──────────────────► Cleared
                         ▲
                         │  submitBid() accepted here only
                         │
                  [commit window]
```

## Security Model

1. **Compliance dual-check**: Eligibility is verified at bid submission AND at settlement. A revoked KYC between rounds cannot receive securities.
2. **Re-entrancy protection**: `settle()` uses OpenZeppelin `ReentrancyGuard`. Transfers are ordered: collect payment first, then deliver asset.
3. **Access control**: Only the issuer address can call `openRound()`, `closeAndClear()`, and schedule corporate actions.
4. **Emergency pause**: `AuctionEngine` inherits `Pausable` — the issuer can halt all activity instantly.

## Hedera-specific Notes

- The bond token is deployed via Hedera ATS, which wraps ERC-3643 and stores identity data natively on Hedera
- `ComplianceGate` queries the ATS identity registry via the Hedera JSON-RPC relay endpoint
- Scheduled Transactions (Hedera-native feature) are used by `CouponScheduler` for automatic coupon payments
- All smart contracts are deployed to the Hedera EVM (chain ID 296 for testnet)

## Uniswap v4 Integration

The `ClearingBellHook` registers with hook permission bits:
- `beforeSwap = true` — intercepts all swaps and queues them as bids
- `afterSwap = true` — emits post-settlement price update events for indexers

The hook converts a standard Uniswap swap (zeroForOne + amount) into a `Bid` struct and calls `AuctionEngine.submitBid()`. The pool's effective price is updated to the clearing price after each round closes.
