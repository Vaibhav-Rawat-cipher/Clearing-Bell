# 🎬 Clearing Bell — Video Demo Script

## Setup Before Recording

1. **Frontend running**: `npm run dev --prefix frontend` → http://127.0.0.1:5173
2. **4 terminal windows open**, each in `e:\Clearing-Bell\`
3. **Browser on Issuer page**: http://127.0.0.1:5173/issuer
4. Frontend auto-refreshes every **6 seconds** — bids appear automatically

---

## SCENE 1 — Open the Auction Round

**Terminal 1** (Issuer window):
```bash
npx tsx scripts/demo-open-round.ts
```

**What it does (~2 min):**
- Deploys fresh `MockBond (CBDB)` + `MockIdentityRegistry`
- KYCs Deployer, Alice, Bob
- Seeds: 500 bonds → Bob, 100k USDC → Alice
- Opens **Round N** with 10-minute bid window

**What appears on frontend (after ~6s refresh):**
- New round card appears in **Markets** page
- Issuer console shows `Open rounds: 1`
- Round status: **OPEN** with countdown timer

**Narrate:** *"As the bond issuer, I'm opening a new auction round for the CBDB bond. The round is now live — investors can submit sealed bids."*

---

## SCENE 2 — Alice submits a BUY bid

**Terminal 2** (Alice's window):
```bash
npx tsx scripts/demo-bid-alice.ts
```

**What it does:**
- Alice: **BUY 100 bonds @ $105 limit price**
- Real on-chain transaction via AuctionEngine.submitBid()

**What appears on frontend:**
- Order book on **Auction** page: **1 order received**
- Bid counter increments
- Depth chart updates (buy side)

> ⚠️ **Frontend shows BID COUNT only — not the bid amount or price.**
> This is the sealed-bid property. Nobody can see Alice's limit price until clearing.

**Narrate:** *"Alice submits her buy order. Notice the frontend shows a bid was received, but the price is hidden — this is a sealed-bid auction. No front-running possible."*

---

## SCENE 3 — Bob submits a SELL bid

**Terminal 3** (Bob's window):
```bash
npx tsx scripts/demo-bid-bob.ts
```

**What it does:**
- Bob: **SELL 100 bonds @ $95 minimum price**

**What appears on frontend:**
- Order count → **2 orders received**
- Depth chart shows both sides

**Narrate:** *"Bob, a bondholder, submits his sell order. Again — sealed. The market can't see his minimum price."*

---

## SCENE 4 — Deployer submits a BUY bid

**Terminal 4** (Deployer's window):
```bash
npx tsx scripts/demo-bid-deployer.ts
```

**What it does:**
- Deployer: **BUY 50 bonds @ $100 limit**

**What appears on frontend:**
- Order count → **3 orders received**

**Narrate:** *"A third participant enters. We now have 3 sealed bids — 2 buyers, 1 seller. The auction engine will find the single clearing price that clears the most volume."*

---

## SCENE 5 — Close & Clear (the reveal)

**Terminal 1** (Issuer window):
```bash
npx tsx scripts/demo-close-and-clear.ts
```

**What it does:**
- Calls `closeAndClear()` as the issuer
- ClearingLib computes uniform crossing price
- DvP settlement: bonds and USDC transfer atomically

**Terminal output reveals:**
```
UNIFORM CLEARING PRICE : $95.00 / bond
MATCHED QUANTITY       : 100 bonds

  BUY  Alice    : paid $9,500 USDC → received 100 bonds
  SELL Bob      : sold 100 bonds   → received $9,500 USDC
  
Note: Alice bid $105 but only pays $95 — price improvement!
Deployer bid $100 but is UNMATCHED (supply exhausted at $95)
```

**What appears on frontend:**
- Round status: **CLOSED**
- Clearing price: **$95.00** visible
- Matched quantity: **100 bonds**
- Depth chart shows the crossing point

**Narrate:** *"The issuer closes the round. The engine runs the auction algorithm — it finds that $95 is the lowest price where supply meets demand. ALL matched trades settle at this single uniform price. Alice bid $105 but only pays $95 — she gets price improvement. This is how institutional bond markets work."*

---

## SCENE 6 — Uniswap v4 Hook Demo

**Terminal 1** (Issuer window):
```bash
npx tsx scripts/demo-hook-swap.ts
```

**What it does:**
- Deploys `TestnetPoolManager` + `ClearingBellHookTestnet`
- Opens a **new round** for the same bond
- Alice's "swap" → `beforeSwap()` fires → bid queued automatically
- Bob's "swap" → `beforeSwap()` fires → bid queued automatically
- `closeAndClear()` → clears at uniform price
- `afterEpochClose()` → clearing price synced back to hook

**Terminal output:**
```
F. Alice's SWAP intercepted → BidQueued: BUY 100 @ $105 ✅
G. Bob's SWAP intercepted   → BidQueued: SELL 100 @ $95 ✅
H. closeAndClear()          → Clearing price: $95.00 ✅
I. afterEpochClose()        → hook.lastClearingPrice = $95.00 ✅
   Price synced engine → hook: ✅ YES
```

**Narrate:** *"Now the hook layer. Instead of users submitting bids directly, they trigger a swap — just like they would on any DEX. The hook's beforeSwap() automatically intercepts the swap intent and routes it into the auction as a sealed bid. After clearing, the hook stores the clearing price on-chain — future swaps in the pool use this price as an oracle."*

---

## About the Swap — Important Context

> **Q: Is the actual swap (token exchange) happening?**
>
> **A: Yes and no — by design.**
>
> In a regular AMM, a swap is instant: send USDC → get bonds at spot price.
>
> In Clearing Bell, the swap is **batched**:
> - `beforeSwap()` fires → your swap intent becomes an **auction bid**
> - Swap does NOT execute immediately (batch window)
> - After `closeAndClear()` → tokens actually transfer via DvP settlement
>
> **What IS real on-chain:**
> - ✅ Bids recorded in AuctionEngine (real txs)  
> - ✅ Uniform clearing price computed on-chain
> - ✅ Bonds and USDC settle atomically (real transfers)
>
> **What's simulated in our testnet scripts:**
> - ⚠️ We call `dispatchBeforeSwap()` directly (instead of going through a real Uniswap pool) because Hedera testnet doesn't support CREATE2-derived pool addresses
> - The hook logic itself is identical to production

---

## Quick Reference — All Commands

```bash
# Terminal 1 — Issuer
npx tsx scripts/demo-open-round.ts    # Opens auction round
npx tsx scripts/demo-close-and-clear.ts  # Closes + reveals clearing price
npx tsx scripts/demo-hook-swap.ts     # Full hook swap demo

# Terminal 2 — Alice (BUY)
npx tsx scripts/demo-bid-alice.ts

# Terminal 3 — Bob (SELL)
npx tsx scripts/demo-bid-bob.ts

# Terminal 4 — Deployer (BUY)
npx tsx scripts/demo-bid-deployer.ts

# Frontend
npm run dev --prefix frontend
# → http://127.0.0.1:5173
```

## Expected Timeline

| Time | Action |
|------|--------|
| 0:00 | Open frontend, navigate to Issuer page |
| 0:15 | T1: Run `demo-open-round.ts` (~2 min for chain txs) |
| 2:15 | Show frontend — new round appeared |
| 2:30 | T2: Run `demo-bid-alice.ts` (~15s) |
| 2:45 | Show frontend — 1 bid received (price hidden) |
| 3:00 | T3: Run `demo-bid-bob.ts` (~15s) |
| 3:15 | Show frontend — 2 bids received |
| 3:30 | T4: Run `demo-bid-deployer.ts` (~15s) |
| 3:45 | Show frontend — 3 bids received |
| 4:00 | T1: Run `demo-close-and-clear.ts` (~20s) |
| 4:20 | Show frontend — clearing price $95 revealed |
| 4:40 | T1: Run `demo-hook-swap.ts` (~3 min) |
| 7:40 | Show terminal — price synced to hook |
| 8:00 | Done ✅ |
