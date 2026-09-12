# Uniswap v4 Hook Developer Feedback — Clearing Bell

**Project:** Clearing Bell (ETHOnline 2026)  
**Hook type:** Batch-auction queue hook using `beforeSwap`  
**Repo:** [TODO: add GitHub link]  
**Date:** 2026-08-30

---

## What we built

We implemented a `beforeSwap` hook that intercepts all Uniswap v4 swaps on a bond-token/USDC pool and routes them into a periodic batch auction engine instead of executing them instantly. The hook:
1. Checks the caller's KYC eligibility via Hedera ATS identity registry
2. Converts the swap parameters into a typed `Bid` struct
3. Queues the bid into the current open `AuctionEngine` round
4. Returns a delta indicating "order queued, not filled yet"

After each auction round closes and a uniform clearing price is computed, `afterEpochClose()` updates the pool's effective price to the clearing price.

---

## What worked well

- **`BaseHook` from `openzeppelin/uniswap-hooks`**: Extending this base contract was significantly simpler than implementing the raw `IHooks` interface. The permission bit management and fallback handling removed a full day of boilerplate.
- **`beforeSwap` delta return mechanism**: Being able to return a `BeforeSwapDelta` that signals "order queued" without reverting was exactly what we needed. The fact that it cleanly composes with the rest of the pool lifecycle is well thought out.
- **Hook deployment with `CREATE2` + permission encoding in the address**: Once we understood the pattern (using `HookMiner`), this was elegant. The address-encodes-permissions design prevents misconfiguration at deploy time.

---

## Pain points and friction

### 1. `HookMiner` discovery and documentation gap
Finding the correct `HookMiner` utility and understanding *why* the hook address must encode permission bits took significant time. The v4-template has it, but the conceptual explanation of "the address IS the permission bitmap" is buried in a README footnote. A dedicated developer docs page explaining this mechanism with a worked example would save hours for every team implementing a hook.

### 2. `BeforeSwapDelta` semantics for "order not filled"
The v4 docs and template show `BeforeSwapDelta` for cases where the hook modifies how much is swapped. Returning a delta that means "nothing happened yet, hold this order" required reading the source code of `IPoolManager` directly. A clearer distinction between "partial fill delta" vs. "queue / defer" delta patterns in the docs would help batch-auction and TWAP-style hook authors specifically.

### 3. Testing the hook with `PoolManager` mock
The v4 test utilities (`PoolModifyLiquidityTest`, `PoolSwapTest`) are great for end-to-end tests but make it hard to unit test just the hook logic in isolation. We ended up writing a lightweight `MockPoolManager` that only implements the interfaces our hook calls. A documented pattern for "hook unit testing without a full pool context" would be valuable.

### 4. `afterSwap` timing relative to settlement
We used `afterSwap` to emit post-settlement price updates. It's not obvious whether `afterSwap` fires before or after the pool's LP fee collection. For price oracle use cases (our clearing price update), this ordering matters. The docs should explicitly state the call ordering within a single swap transaction.

---

## Feature requests

1. **Hook-level event indexing guidance**: How should hooks emit events for off-chain indexers? Should they emit from the hook contract directly, or rely on the `PoolManager`'s own events? A recommended pattern would help standardize indexer behavior.
2. **Batched hook calls**: For batch-auction hooks specifically, being able to signal "this swap is queued and will be settled in a future block" as a first-class concept (rather than returning a zero delta and managing state off-chain) would make this pattern cleaner.
3. **Hook deployment templates for common patterns**: Beyond the basic template, pattern-specific scaffolds for common hook types (TWAP oracle, batch auction, fee-adjusting) would accelerate hackathon and production teams alike.

---

## Overall experience

The v4 hook system is genuinely powerful. The `beforeSwap`/`afterSwap`/etc. abstraction is the right level — not so low-level that you're fighting the EVM, not so high-level that you lose control. For compliance-gated markets specifically, the ability to intercept and redirect swaps without forking the protocol is exactly what the space needs.

The main investment area is documentation depth for non-standard patterns. Teams building anything beyond a simple fee hook will hit underdocumented territory quickly.

**Rating:** 8/10 — great primitives, documentation needs to catch up with the power of the system.
