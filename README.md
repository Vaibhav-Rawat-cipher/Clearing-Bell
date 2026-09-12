# Clearing Bell: The Multi-Issuer Platform

A decentralized, wallet-connected batch-auction interface for tokenized securities. The platform allows multiple companies to independently launch and manage their own tokenized bonds, while the platform admin curates listings. The React frontend and Solidity auction backend now live in this repository.

## Run locally

Prerequisites: Node.js **22.15+** (22.21 tested), npm, Git, and [Foundry](https://getfoundry.sh/) with `forge` and `anvil` on PATH.

```sh
npm run setup
npm run dev:local
```

Open **http://localhost:5173/**. Vite binds to loopback only. The setup starts a local Anvil chain on **127.0.0.1:8545**, deploys the contracts, seeds test tokens and orders, and writes a public deployment manifest. No signing key is exported or embedded in the frontend.

On subsequent runs, `npm run dev:local` reuses the local deployment. To deploy a fresh fixture without erasing previous chain state:

```sh
npm run local:fresh
```

Reload the browser after a fresh deployment. The local chain is ephemeral across Anvil restarts. Its process ID is stored in `contracts/local/anvil.pid` when this script starts it.

## Multi-Issuer Registration Flow

The platform supports multiple independent issuers. Here is the lifecycle for a company looking to launch an auction:

### Backend Admin Setup (One-Time)
These steps are currently handled via backend administrative scripts (e.g., `scripts/deploy-stack.ts`) to ensure secure platform curation:
1. **Get Whitelisted (Platform Admin):** The platform admin calls `AuctionEngine.registerBondIssuer(bondToken, companyWallet)` to authorize the company.
2. **Connect Compliance (Company):** The company links their ATS identity registry by calling `ComplianceGate.registerRegistry(bondToken, identityRegistry)`.
3. **Configure Bond (Company):** The company registers their auction engine and settlement token via `BondConfig.configure()`.

### Frontend Issuer Dashboard (Daily Operations)
Once the backend setup is complete, the company uses the frontend `/issuer` dashboard to run their auctions:
4. **Open a Round:** The company clicks "Open a round" to start a live auction for their bond.
5. **Close and Clear:** When the timer expires, the company clicks "Close Round" to automatically calculate the uniform clearing price and atomically settle all trades.

## Try the connected flow

1. Open **Markets** and select the open round.
2. **Connect wallet → Investor** selects a funded local test account.
3. Enter price **100** and quantity **10**, approve USDC, then place the order.
4. The order appears in the public book and your portfolio.
5. Switch to **Issuer**, review the round, then confirm **Close and settle round**.
6. Switch back to **Investor** and check the additional bonds, USDC debit, and settlement receipt.
7. The **Unverified account** cannot trade. The issuer console is read-only for non-issuer accounts.

Issuer controls also support opening new rounds and pausing/resuming the engine. Confirmation dialogs explain the effect before each action.

Local accounts are available only in the Vite development build, on chain 31337, with a literal loopback RPC host. Production builds require an injected EVM wallet.

## Checks

```sh
npm run check
RUN_CHAIN_TESTS=1 npm run test:frontend
```

The second command requires the local deployment. It performs read-only integration assertions against actual contract state.

- 66 Solidity tests, including clearing and fractional-payment fuzz regressions.
- 23 frontend unit/config tests; 1 additional opt-in live local-chain integration test.
- TypeScript, ESLint, and production Vite build.
- Browser-verified approval → public bid → issuer clearing → actual portfolio receipt.

See [verification results](docs/VERIFICATION.md) and [local contract notes](contracts/local/README.md).

## External deployment / Hedera testnet

Use `frontend/.env.example` as the template for `frontend/.env.local`. Set RPC URL, chain ID and auction engine address together. Explicit environment settings take precedence over the generated local manifest.

**Deploy the corrected contracts in this checkout first.** Changes made here do not patch any previously deployed contract. No external chain transaction or hosted deployment was performed during integration.

The app validates chain ID, engine bytecode, gate and token metadata. Missing configuration, wrong-chain wallets, RPC failures, declined requests and reverted transactions produce explicit states, not sample success data.

All `VITE_` values and `public/deployment.json` are public. Never put private keys, personal identity data, or secret RPC credentials in them.

## Repository structure

```text
frontend/
  src/pages/             Home, markets, auction, portfolio, issuer
  src/components/        Shared shell, forms, receipts, process visualization
  src/context/           Wallet session, transactions, refresh orchestration
  src/lib/               Contract ABI, RPC reads, config, exact amount validation
  src/styles/            Shared tokens and responsive page styles
  tests/                 Amount, configuration and local chain tests
contracts/
  src/auction/           Engine, clearing algorithm, compliance gate
  src/hooks/             Existing Uniswap v4 integration (not used by frontend)
  test/                  Contract tests and regression coverage
  local/                 Local instructions and generated deployment artifacts
scripts/local-dev.mjs     Reproducible local deployment and liquidity fixture
docs/                    Architecture and verification record
```

## Scope and production limits

The frontend calls the AuctionEngine directly. There is no separate application server or database to deploy.

The implemented mechanism has **public bids**, not sealed commit/reveal. `closeAndClear` performs clearing and settlement atomically. Coupons, automatic corporate actions, document uploads, KYC-provider onboarding and asset issuance are not implemented by this UI. Unsupported controls and fictitious portfolio returns have been removed.

**This is a tested local integration, not an audited production exchange.**

- Orders are not escrowed or cancellable. Removing a required balance or allowance can make settlement revert.
- The local registry and ERC-20 assets are test fixtures; they do not establish real-world KYC or security issuance.
- The existing Uniswap hook tests use a mock PoolManager. Real pool swap safety remains unverified, so the UI deliberately does not route through it.
- Reads are bounded to the latest 100 rounds and 20,000 event-history blocks. The UI discloses these bounds and blocks new bids when complete outstanding-order funding cannot be checked.
- A receipt timeout keeps the original transaction pending and blocks duplicate submission. It does not rebroadcast.
- External deployments need production identity/token integration, RPC capacity planning and an independent smart-contract security review.

The original standalone frontend outside this cloned directory was preserved.
