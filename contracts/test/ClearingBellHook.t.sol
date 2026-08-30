// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {HookMiner} from "v4-periphery/utils/HookMiner.sol";

import {ClearingBellHook} from "hook/ClearingBellHook.sol";
import {AuctionEngine} from "auction/AuctionEngine.sol";
import {ComplianceGate} from "auction/ComplianceGate.sol";
import {ClearingLib} from "auction/ClearingLib.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {MockPoolManager} from "./mocks/MockPoolManager.sol";

/// @title ClearingBellHook Unit Tests
/// @notice Phase 3 gate per PLAN.md §8:
///         "Hook-specific: beforeSwap correctly queues instead of instant-filling."
///         Also covers the §4.5 / ARCHITECTURE.md hook responsibilities:
///         permission bits, KYC gating, swap→Bid direction mapping, ZERO_DELTA
///         (order queued, not filled), afterEpochClose clearing-price sync, and
///         issuer-only admin.
contract ClearingBellHookTest is Test {
    MockPoolManager internal poolManager;
    AuctionEngine internal engine;
    ComplianceGate internal gate;
    MockIdentityRegistry internal registry;
    MockERC20 internal bond;
    MockERC20 internal usdc;

    uint256 internal activeRoundId;

    address internal constant ISSUER = address(0x155E);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    uint256 internal constant USD = 1e6;
    uint256 internal constant TOK = 1e18;

    // =========================================================================
    // setUp — deploy the full auction stack plus the hook (CREATE2 mined)
    // =========================================================================

    function setUp() public {
        poolManager = new MockPoolManager();

        bond = new MockERC20("Bond", "BND", 18);
        usdc = new MockERC20("USDC", "USDC", 6);

        registry = new MockIdentityRegistry();
        gate = new ComplianceGate();
        gate.registerRegistry(address(bond), address(registry));

        engine = new AuctionEngine(address(gate), ISSUER);

        // KYC everyone.
        registry.grant(ISSUER);
        registry.grant(ALICE);
        registry.grant(BOB);

        // Fund bidders: buyers get USDC, sellers get bond.
        usdc.mint(ALICE, 1_000_000 * USD);
        bond.mint(BOB, 1_000_000 * TOK);
        usdc.approve(address(engine), type(uint256).max);
        bond.approve(address(engine), type(uint256).max);
        usdc.approve(address(poolManager), type(uint256).max);
        bond.approve(address(poolManager), type(uint256).max);

        // Bidders approve the engine so settlement can pull their legs.
        vm.prank(ALICE);
        usdc.approve(address(engine), type(uint256).max);
        vm.prank(BOB);
        bond.approve(address(engine), type(uint256).max);

        // Deploy the hook via CREATE2 with mined address encoding BEFORE+AFTER_SWAP.
        _deployHook();

        // Issuer authorizes the deployed hook as a bid relayer (AuctionEngine.setAuthorizedBidRelayer).
        vm.prank(ISSUER);
        engine.setAuthorizedBidRelayer(address(hook), true);

        // Open a round and register it as active.
        vm.prank(ISSUER);
        activeRoundId = engine.openRound(address(bond), address(usdc), 1 hours);
        vm.prank(ISSUER);
        hook.setActiveRound(address(bond), activeRoundId);
    }

    ClearingBellHook internal hook;

    function _deployHook() internal {
        bytes memory constructorArgs = abi.encode(address(poolManager), address(engine));
        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);
        (address hookAddr, bytes32 salt) = HookMiner.find(
            address(this), flags, type(ClearingBellHook).creationCode, constructorArgs
        );

        hook = new ClearingBellHook{salt: salt}(IPoolManager(address(poolManager)), engine);

        assertEq(address(hook), hookAddr, "hook deployed at mined CREATE2 address");
    }

    function _poolKey() internal view returns (PoolKey memory key) {
        key = PoolKey({
            currency0: Currency.wrap(address(bond)),
            currency1: Currency.wrap(address(usdc)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
    }

    function _swapParams(bool zeroForOne, int256 amount) internal pure returns (SwapParams memory) {
        return SwapParams({zeroForOne: zeroForOne, amountSpecified: amount, sqrtPriceLimitX96: type(uint160).max});
    }

    // =========================================================================
    // Hook permissions — PLAN §4.5 / ARCHITECTURE.md
    // =========================================================================

    function test_HookPermissions_BeforeAndAfterSwapEnabled() public view {
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertTrue(p.beforeSwap, "beforeSwap permission must be set");
        assertTrue(p.afterSwap, "afterSwap permission must be set");
        assertFalse(p.beforeAddLiquidity, "no other permissions should be set");
        assertFalse(p.afterAddLiquidity);
        assertFalse(p.beforeSwapReturnDelta, "we return ZERO_DELTA, no custom token accounting");
    }

    // =========================================================================
    // beforeSwap — order is queued, NOT instant-filled (PLAN §8)
    // =========================================================================

    function test_BeforeSwap_QueuesBid_NotInstantFill() public {
        PoolKey memory key = _poolKey();
        SwapParams memory params = _swapParams(false, int256(50 * TOK)); // buy 50 bond
        bytes memory hookData = abi.encode(105 * USD); // limit price 105

        uint256 bidsBefore = engine.getRoundBids(activeRoundId).length;
        uint256 aliceUsdcBefore = usdc.balanceOf(ALICE);
        uint256 aliceBondBefore = bond.balanceOf(ALICE);

        // Only the pool manager may invoke the hook.
        vm.prank(address(poolManager));
        (bytes4 selector, BeforeSwapDelta delta, ) = hook.beforeSwap(ALICE, key, params, hookData);

        // Pulse: return values prove "queued, not filled".
        assertEq(selector, hook.beforeSwap.selector, "returns beforeSwap selector");
        assertEq(
            BeforeSwapDelta.unwrap(delta),
            BeforeSwapDelta.unwrap(BeforeSwapDeltaLibrary.ZERO_DELTA),
            "ZERO_DELTA => order queued, not filled"
        );

        // The order was recorded as a bid in the AuctionEngine.
        assertEq(engine.getRoundBids(activeRoundId).length, bidsBefore + 1, "bid queued into engine");

        // No tokens moved — proof it did NOT instant-fill through the AMM.
        assertEq(usdc.balanceOf(ALICE), aliceUsdcBefore, "no USDC pulled (not instant-filled)");
        assertEq(bond.balanceOf(ALICE), aliceBondBefore, "no bond delivered (not instant-filled)");

        // Direction mapping: zeroForOne=false → buy (isBuy=true).
        (address bidder, uint256 price, uint256 quantity, bool isBuy,) = _lastBid();
        assertEq(bidder, ALICE);
        assertEq(price, 105 * USD);
        assertEq(quantity, 50 * TOK);
        assertTrue(isBuy, "zeroForOne=false maps to a buy order");
    }

    function test_BeforeSwap_SellDirection_ZeroForOneTrue() public {
        PoolKey memory key = _poolKey();
        // zeroForOne=true → selling bond (token0) → sell order (isBuy=false).
        SwapParams memory params = _swapParams(true, -int256(80 * TOK)); // exact-in sell 80 bond
        bytes memory hookData = abi.encode(100 * USD);

        vm.prank(address(poolManager));
        hook.beforeSwap(BOB, key, params, hookData);

        (, uint256 price, uint256 quantity, bool isBuy,) = _lastBid();
        assertEq(price, 100 * USD);
        assertEq(quantity, 80 * TOK, "uses absolute value of negative amountSpecified");
        assertFalse(isBuy, "zeroForOne=true maps to a sell order");
        assertEq(engine.getRoundBids(activeRoundId).length, 1);
    }

    function test_RevertWhen_NotKyc_Sender() public {
        address mallory = address(0x9A1C0);
        PoolKey memory key = _poolKey();
        bytes memory hookData = abi.encode(105 * USD);

        vm.prank(address(poolManager));
        vm.expectRevert(abi.encodeWithSelector(ClearingBellHook.BidderNotEligible.selector, mallory));
        hook.beforeSwap(mallory, key, _swapParams(false, int256(10 * TOK)), hookData);
    }

    function test_RevertWhen_NoActiveRound() public {
        // A second bond token that IS KYC-registered but has NO active round.
        MockERC20 otherBond = new MockERC20("Other", "OTH", 18);
        gate.registerRegistry(address(otherBond), address(registry));

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(otherBond)),
            currency1: Currency.wrap(address(usdc)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        bytes memory hookData = abi.encode(105 * USD);

        vm.prank(address(poolManager));
        vm.expectRevert(
            abi.encodeWithSelector(ClearingBellHook.NoActiveRound.selector, address(otherBond))
        );
        hook.beforeSwap(ALICE, key, _swapParams(false, int256(10 * TOK)), hookData);
    }

    function test_RevertWhen_InvalidHookData() public {
        PoolKey memory key = _poolKey();
        bytes memory shortData = abi.encodePacked(uint8(1)); // < 32 bytes

        vm.prank(address(poolManager));
        vm.expectRevert(ClearingBellHook.InvalidHookData.selector);
        hook.beforeSwap(ALICE, key, _swapParams(false, int256(10 * TOK)), shortData);
    }

    function test_RevertWhen_ZeroQuantity() public {
        PoolKey memory key = _poolKey();

        vm.prank(address(poolManager));
        vm.expectRevert(ClearingBellHook.ZeroQuantity.selector);
        hook.beforeSwap(ALICE, key, _swapParams(false, int256(0)), abi.encode(105 * USD));
    }

    function test_RevertWhen_NotPoolManager() public {
        PoolKey memory key = _poolKey();
        // Called directly, not by the pool manager.
        vm.prank(ALICE);
        vm.expectRevert(); // BaseHook.NotPoolManager
        hook.beforeSwap(ALICE, key, _swapParams(false, int256(10 * TOK)), abi.encode(105 * USD));
    }

    // =========================================================================
    // afterSwap — selector passthrough (indexer extensibility)
    // =========================================================================

    function test_AfterSwap_ReturnsSelector() public {
        PoolKey memory key = _poolKey();
        BalanceDelta delta = BalanceDelta.wrap(0);

        vm.prank(address(poolManager));
        (bytes4 selector,) = hook.afterSwap(ALICE, key, _swapParams(false, int256(10 * TOK)), delta, "");

        assertEq(selector, hook.afterSwap.selector, "afterSwap returns selector");
    }

    // =========================================================================
    // afterEpochClose — sync clearing price (PLAN §4.5)
    // =========================================================================

    function test_AfterEpochClose_UpdatesClearingPrice() public {
        // Run a full round and settle to produce a clearing price.
        _submitBidsAndClear();

        vm.expectEmit(true, true, true, true, address(hook));
        emit ClearingBellHook.ClearingPriceUpdated(address(bond), activeRoundId, 100 * USD);
        vm.prank(ISSUER);
        hook.afterEpochClose(activeRoundId, address(bond));

        assertEq(hook.lastClearingPrice(address(bond)), 100 * USD, "clearing price synced");
    }

    function test_RevertWhen_NonIssuerCallsAfterEpochClose() public {
        vm.prank(ALICE);
        vm.expectRevert(ClearingBellHook.NotIssuer.selector);
        hook.afterEpochClose(activeRoundId, address(bond));
    }

    // =========================================================================
    // setActiveRound — issuer only (PLAN §4.5)
    // =========================================================================

    function test_RevertWhen_NonIssuerSetsActiveRound() public {
        vm.prank(ALICE);
        vm.expectRevert(ClearingBellHook.NotIssuer.selector);
        hook.setActiveRound(address(bond), activeRoundId);
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    function _submitBidsAndClear() internal {
        uint256 roundId = activeRoundId;
        // Alice buys 100 @105, Bob sells 100 @100 -> clearing price 100, qty 100.
        vm.prank(address(poolManager));
        hook.beforeSwap(ALICE, _poolKey(), _swapParams(false, int256(100 * TOK)), abi.encode(105 * USD));
        vm.prank(address(poolManager));
        hook.beforeSwap(BOB, _poolKey(), _swapParams(true, -int256(100 * TOK)), abi.encode(100 * USD));

        vm.warp(block.timestamp + 1 hours + 1);
        engine.closeAndClear(roundId);
    }

    function _lastBid()
        internal
        view
        returns (address bidder, uint256 price, uint256 quantity, bool isBuy, uint256 index)
    {
        ClearingLib.Bid[] memory bids = engine.getRoundBids(activeRoundId);
        require(bids.length > 0, "no bids");
        ClearingLib.Bid memory b = bids[bids.length - 1];
        return (b.bidder, b.price, b.quantity, b.isBuy, b.index);
    }
}
