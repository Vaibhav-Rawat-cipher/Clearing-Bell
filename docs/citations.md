# Citations & References

## Academic Papers

### Budish, Cramton & Shim (2015)
**The High-Frequency Trading Arms Race: Frequent Batch Auctions as a Market Design Response**  
*Quarterly Journal of Economics, 130(4), 1547–1621*  
DOI: https://doi.org/10.1093/qje/qjv027

**Why cited:** This paper is the theoretical foundation for our clearing price mechanism. Budish et al. prove that continuous-limit-order-book markets have a structural problem — they incentivize speed over information. Frequent batch auctions (periodic clearing at a single uniform price) eliminate this arms race. We implement the batch-auction mechanism they describe, adapted for on-chain execution.

Key mechanism we implement (from Section IV):
> "In a frequent batch auction, the market pauses at regular intervals, collects all orders submitted during the interval, and clears them at a single price."

The "single uniform clearing price" — where all matched buyers pay and all matched sellers receive the same price — is implemented in our `ClearingLib.sol`.

---

### Ferreira & Parkes (2022)
**FairTraDEX: A Decentralised NFT Trading Protocol**  
*arXiv:2202.06384*  
URL: https://arxiv.org/abs/2202.06384

**Why cited:** FairTraDEX provides the most directly relevant Solidity implementation of a decentralized batch auction on-chain. We referenced their clearing price algorithm and commit-reveal mechanism design. Our `ClearingLib` is an independent implementation but follows the same algorithmic approach they describe.

---

## Protocol Documentation

### Hedera Asset Tokenization Studio (ATS)
- Architecture: https://github.com/hashgraph/asset-tokenization-studio/blob/main/packages/ats/contracts/ARCHITECTURE.md
- Bond creation: https://docs.tokenization-studio.hedera.com/ats/creating-bond
- Corporate actions: https://docs.tokenization-studio.hedera.com/ats/corporate-actions
- Identity registry: https://docs.tokenization-studio.hedera.com/ats/identity

**Why cited:** Our `BondConfig.sol` configures an ATS-deployed ERC-3643 bond. Our `ComplianceGate.sol` reads from the ATS identity registry. We do not re-implement KYC storage — we query ATS's registry directly.

---

### Uniswap v4
- Core contracts: https://github.com/Uniswap/v4-core
- Hook architecture: https://github.com/Uniswap/v4-core/blob/main/src/libraries/Hooks.sol
- Hook template: https://github.com/Uniswap/v4-template
- OpenZeppelin hooks base: https://github.com/OpenZeppelin/uniswap-hooks

**Why cited:** Our `ClearingBellHook.sol` extends the `BaseHook` from OpenZeppelin's uniswap-hooks package, which itself wraps the Uniswap v4 `IHooks` interface. Hook permission bits follow the Hooks.sol encoding standard.

---

### ERC-3643 (T-REX Standard)
- EIP: https://eips.ethereum.org/EIPS/eip-3643
- Reference implementation: https://github.com/TokenySolutions/T-REX

**Why cited:** ATS implements ERC-3643. Our bond token is an ERC-3643 token. The compliance transfer restrictions and identity registry are defined by this standard.

---

## Tools & Infrastructure

| Tool | Purpose | URL |
|---|---|---|
| Foundry | Solidity testing & deployment | https://getfoundry.sh |
| Hedera Testnet | Deployment target | https://portal.hedera.com |
| HashScan | Hedera block explorer | https://hashscan.io/testnet |
| Hedera JSON-RPC Relay | EVM-compatible RPC | https://testnet.hashio.io/api |
| forge-std | Test utilities | https://github.com/foundry-rs/forge-std |
| OpenZeppelin Contracts | Security primitives | https://github.com/OpenZeppelin/openzeppelin-contracts |
