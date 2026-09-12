#!/usr/bin/env bash
# =============================================================================
# deploy.sh  —  Clearing Bell contract deployment to Hedera Testnet
#
# Uses: cast (Foundry) instead of forge script
# Why:  forge script calls eth_getBlockByNumber with a malformed object param
#       that Hedera's hashio.io JSON-RPC relay rejects with HTTP 400.
#       cast send --create only calls eth_chainId + eth_getTransactionCount
#       + eth_sendRawTransaction, all of which Hedera supports fine.
#
# Usage:
#   cd contracts
#   bash script/deploy.sh
#
# Prerequisites:
#   - forge build must have been run (artifacts needed)
#   - .env in the repo root with DEPLOYER_PRIVATE_KEY and BOND_TOKEN_ADDRESS
# =============================================================================

# ── Load env ─────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [ -f "$ROOT_DIR/.env" ]; then
  # Sourcing safely handling CRLF and stripping quotes
  while IFS= read -r line || [ -n "$line" ]; do
    line=$(echo "$line" | tr -d '\r' | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
    if [[ ! "$line" =~ ^# ]] && [[ -n "$line" ]]; then
      # Split by first = and strip quotes from value
      key=$(echo "$line" | cut -d= -f1)
      val=$(echo "$line" | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
      export "$key=$val"
    fi
  done < "$ROOT_DIR/.env"
else
  echo "ERROR: $ROOT_DIR/.env not found"
  exit 1
fi

# ── Config ───────────────────────────────────────────────────────────────────
RPC="https://testnet.hashio.io/api"
PKEY="${DEPLOYER_PRIVATE_KEY}"
BOND_TOKEN="${BOND_TOKEN_ADDRESS:-}"
ATS_REGISTRY="${ATS_IDENTITY_REGISTRY_ADDRESS:-0x0000000000000000000000000000000000000000}"

DEPLOYER=$(cast wallet address --private-key "$PKEY")
CAST_FLAGS="--rpc-url $RPC --private-key $PKEY --legacy --gas-price 1500000000000"

echo "================================================================="
echo "  Clearing Bell — Contract Deployment (cast / Foundry)"
echo "================================================================="
echo "  Deployer   : $DEPLOYER"
echo "  Bond token : ${BOND_TOKEN:-<not set, BondConfig.configure will be skipped>}"
echo "  RPC        : $RPC"
echo ""

# ── Helper: deploy a contract and return its address ─────────────────────────
deploy() {
  local NAME="$1"
  local INITCODE="$2"
  local GAS="${3:-5000000}"

  echo -n "  Deploying $NAME ... "
  local TX_JSON
  TX_JSON=$(cast send \
    $CAST_FLAGS \
    --gas-limit "$GAS" \
    --create "$INITCODE" \
    --json 2>&1)

  local TXHASH
  TXHASH=$(echo "$TX_JSON" | grep -o '"transactionHash":"0x[^"]*"' | head -1 | cut -d'"' -f4 || echo "")

  if [ -z "$TXHASH" ]; then
    echo "FAILED"
    echo "$TX_JSON"
    exit 1
  fi

  local ADDR
  ADDR=$(cast receipt "$TXHASH" --rpc-url "$RPC" --json 2>/dev/null \
    | grep -o '"contractAddress":"0x[^"]*"' | cut -d'"' -f4 || echo "")

  echo "done"
  echo "    tx   : $TXHASH"
  echo "    addr : $ADDR"
  echo ""
  echo "$ADDR"
}

# ── Helper: get forge artifact bytecode ──────────────────────────────────────
bytecode() {
  forge inspect "$1" bytecode 2>/dev/null
}

# ── 1. MockUSDC ──────────────────────────────────────────────────────────────
if [ -n "${USDC_ADDRESS:-}" ] && [ "$USDC_ADDRESS" != '""' ] && [ "$USDC_ADDRESS" != "" ]; then
  echo "  MockUSDC    : $USDC_ADDRESS (existing, skipping)"
  USDC_ADDR="$USDC_ADDRESS"
else
  ERC20_BC=$(bytecode "MockERC20")
  ERC20_ARGS=$(cast abi-encode "constructor(string,string,uint8)" "USD Coin" "USDC" "6")
  ERC20_INITCODE="${ERC20_BC}${ERC20_ARGS:2}"
  USDC_ADDR=$(deploy "MockUSDC" "$ERC20_INITCODE" "3000000")
  if [[ "$USDC_ADDR" == *FAILED* ]]; then echo "$USDC_ADDR"; exit 1; fi

  # Mint 100M USDC (100_000_000 * 1e6) to deployer
  echo -n "  Minting 100M USDC to deployer ... "
  cast send "$USDC_ADDR" "mint(address,uint256)" "$DEPLOYER" "100000000000000" \
    $CAST_FLAGS --gas-limit 200000 > /dev/null
  echo "done"
  echo ""
fi

# ── 2. BondConfig ─────────────────────────────────────────────────────────────
BONDCONFIG_BC=$(bytecode "BondConfig")
BONDCONFIG_ADDR=$(deploy "BondConfig" "$BONDCONFIG_BC" "3000000")
if [[ "$BONDCONFIG_ADDR" == *FAILED* ]]; then echo "$BONDCONFIG_ADDR"; exit 1; fi

# ── 3. ComplianceGate ────────────────────────────────────────────────────────
GATE_BC=$(bytecode "ComplianceGate")
GATE_ADDR=$(deploy "ComplianceGate" "$GATE_BC" "3000000")
if [[ "$GATE_ADDR" == *FAILED* ]]; then echo "$GATE_ADDR"; exit 1; fi

# ── 4. AuctionEngine ─────────────────────────────────────────────────────────
ENGINE_BC=$(bytecode "AuctionEngine")
ENGINE_ARGS=$(cast abi-encode "constructor(address,address)" "$GATE_ADDR" "$DEPLOYER")
ENGINE_INITCODE="${ENGINE_BC}${ENGINE_ARGS:2}"
ENGINE_ADDR=$(deploy "AuctionEngine" "$ENGINE_INITCODE" "5000000")
if [[ "$ENGINE_ADDR" == *FAILED* ]]; then echo "$ENGINE_ADDR"; exit 1; fi

# ── 5. Authorize AuctionEngine as relayer (self) ─────────────────────────────
echo -n "  Wiring: AuctionEngine.setAuthorizedBidRelayer ... "
cast send "$ENGINE_ADDR" "setAuthorizedBidRelayer(address,bool)" "$ENGINE_ADDR" "true" \
  $CAST_FLAGS --gas-limit 100000 > /dev/null
echo "done"
echo ""

# ── 6. BondConfig.configure (if bond token known) ────────────────────────────
if [ -n "$BOND_TOKEN" ]; then
  echo -n "  Wiring: BondConfig.configure ... "
  cast send "$BONDCONFIG_ADDR" \
    "configure(address,address,address,address,address)" \
    "$BOND_TOKEN" "$ATS_REGISTRY" "$GATE_ADDR" "$ENGINE_ADDR" "$USDC_ADDR" \
    $CAST_FLAGS --gas-limit 200000 > /dev/null
  echo "done"

  # Register ATS registry in ComplianceGate (if set)
  if [ "$ATS_REGISTRY" != "0x0000000000000000000000000000000000000000" ]; then
    echo -n "  Wiring: ComplianceGate.registerRegistry ... "
    cast send "$GATE_ADDR" \
      "registerRegistry(address,address)" "$BOND_TOKEN" "$ATS_REGISTRY" \
      $CAST_FLAGS --gas-limit 100000 > /dev/null
    echo "done"
  fi
  echo ""
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo "================================================================="
echo "  Deployment Complete! Add these to your .env:"
echo "================================================================="
echo "USDC_ADDRESS=\"$USDC_ADDR\""
echo "BOND_CONFIG_ADDRESS=\"$BONDCONFIG_ADDR\""
echo "COMPLIANCE_GATE_ADDRESS=\"$GATE_ADDR\""
echo "AUCTION_ENGINE_ADDRESS=\"$ENGINE_ADDR\""
echo ""
echo "  HashScan:"
echo "  MockUSDC      https://hashscan.io/testnet/contract/$USDC_ADDR"
echo "  BondConfig    https://hashscan.io/testnet/contract/$BONDCONFIG_ADDR"
echo "  ComplianceGate https://hashscan.io/testnet/contract/$GATE_ADDR"
echo "  AuctionEngine https://hashscan.io/testnet/contract/$ENGINE_ADDR"
echo "================================================================="
