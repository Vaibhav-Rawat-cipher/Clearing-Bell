// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {ComplianceGate} from "src/auction/ComplianceGate.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";

/// @title ComplianceGate Unit Tests
/// @notice Coverage per PLAN.md §8: eligible / not-eligible / revoked-mid-round,
///         plus registry registration and guardrails.
///         registerRegistry() is permissionless per Option C.
contract ComplianceGateTest is Test {
    ComplianceGate internal gate;
    MockIdentityRegistry internal registry;

    address internal constant OWNER = address(0x0a1CE);
    address internal constant BOND = address(0xB0A0A);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant CAROL = address(0xCA401);

    function setUp() public {
        gate = new ComplianceGate();
        registry = new MockIdentityRegistry();
        // The test contract is the deploying owner of ComplianceGate.
        gate.registerRegistry(BOND, address(registry));
    }

    // =========================================================================
    // Registry registration — permissionless (Option C)
    // =========================================================================

    function test_RegisterRegistry_EmitsEvent() public {
        address newBond = address(0x0eab);
        vm.expectEmit(true, true, true, true, address(gate));
        emit ComplianceGate.RegistryRegistered(newBond, address(registry));
        gate.registerRegistry(newBond, address(registry));
    }

    function test_RegisterRegistry_Permissionless() public {
        address newBond = address(0x0eab);
        vm.prank(ALICE);
        gate.registerRegistry(newBond, address(registry));
        assertTrue(gate.identityRegistry(newBond) == address(registry), "Alice registered bond registry");
    }

    // =========================================================================
    // Eligibility — eligible / not-eligible per PLAN §8
    // =========================================================================

    function test_Eligible_WhenVerified() public {
        registry.grant(ALICE);
        assertTrue(gate.isEligible(ALICE, BOND), "verified user is eligible");
        assertGt(gate.eligibilityCheckedAt(ALICE, BOND), 0, "registration date recorded");
    }

    function test_NotEligible_WhenNotVerified() public view {
        // BOB never registered
        assertFalse(gate.isEligible(BOB, BOND), "unregistered user not eligible");
    }

    // =========================================================================
    // Revoked mid-round per PLAN §8 — must flip eligible -> not eligible
    // =========================================================================

    function test_RevokedMidRound_BecomesNotEligible() public {
        registry.grant(ALICE);
        assertTrue(gate.isEligible(ALICE, BOND), "eligible before revocation");

        registry.revoke(ALICE);

        assertFalse(gate.isEligible(ALICE, BOND), "not eligible after revocation");
    }

    // =========================================================================
    // Guardrails
    // =========================================================================

    function test_RevertWhen_NoRegistrySetForBond() public {
        address unregisteredBond = address(0xDEAD);
        vm.expectRevert(
            abi.encodeWithSelector(ComplianceGate.RegistryNotSet.selector, unregisteredBond)
        );
        gate.isEligible(ALICE, unregisteredBond);
    }

    function test_RevertWhen_NoRegistrySet_EligibilityTime() public {
        address unregisteredBond = address(0xDEAD);
        vm.expectRevert(
            abi.encodeWithSelector(ComplianceGate.RegistryNotSet.selector, unregisteredBond)
        );
        gate.eligibilityCheckedAt(ALICE, unregisteredBond);
    }
}
