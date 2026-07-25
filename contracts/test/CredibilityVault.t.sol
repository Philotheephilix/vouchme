// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AvalToken} from "../src/AvalToken.sol";
import {CredibilityVault} from "../src/CredibilityVault.sol";

contract CredibilityVaultTest is Test {
    AvalToken internal token;
    CredibilityVault internal vault;

    address internal governor = address(0xF00D);
    address internal treasury = address(0xBEEF);
    address internal reportRegistry = address(0x9999);
    address internal alice = address(0x1111);
    address internal target = address(0x2222);
    address internal carol = address(0x3333);
    address internal dave = address(0x4444);
    address internal erin = address(0x5555);

    function setUp() public {
        token = new AvalToken(governor);
        vault = new CredibilityVault(address(token), governor, treasury);

        vm.startPrank(governor);
        token.setMinter(governor, true);
        vault.setReportRegistry(reportRegistry);
        vm.stopPrank();

        vm.prank(governor);
        token.mint(alice, 1_000e18);

        vm.prank(alice);
        token.approve(address(vault), type(uint256).max);
    }

    function _bond(uint128 amount) internal {
        vm.prank(alice);
        vault.bond(amount);
    }

    function _fundAndBond(address who, uint128 amount) internal {
        vm.prank(governor);
        token.mint(who, amount);
        vm.prank(who);
        token.approve(address(vault), type(uint256).max);
        vm.prank(who);
        vault.bond(amount);
    }

    // ─── withdraw reverts while a claim is open ─────────────────────────────
    function test_Withdraw_RevertsWhileClaimOpen() public {
        _bond(1_000e18);

        bytes32 reportId = keccak256("report-1");
        vm.prank(reportRegistry);
        vault.lockForReport(reportId, alice, 400e18);

        // 600 AVAL is still unlocked; request-unbond it and let the 14-day timer mature.
        vm.prank(alice);
        vault.requestUnbond(600e18);
        skip(14 days + 1);

        // Even though the pending-unbond amount has matured, `locked != 0` blocks ALL withdrawals —
        // "the correct play on receiving a report is to withdraw everything before it resolves" is
        // exactly what this must prevent (docs/11-token-vault.md §3.1).
        vm.prank(alice);
        vm.expectRevert(CredibilityVault.ClaimOpen.selector);
        vault.withdraw();

        // Once the claim settles (locked funds released), withdrawal of the matured amount succeeds.
        vm.prank(reportRegistry);
        vault.settle(reportId, CredibilityVault.Outcome.UNPROVEN, target);

        vm.prank(alice);
        vault.withdraw();
        assertEq(token.balanceOf(alice), 1_000e18 - 400e18, "unproven report returns the full bond");
    }

    // ─── unbond respects the 14-day timer ────────────────────────────────────
    function test_Unbond_Respects14DayTimer() public {
        _bond(500e18);

        vm.prank(alice);
        vault.requestUnbond(500e18);

        // Immediately: not matured yet.
        vm.prank(alice);
        vm.expectRevert(CredibilityVault.UnbondNotMatured.selector);
        vault.withdraw();

        // 1 second before maturity: still not matured.
        skip(14 days - 1);
        vm.prank(alice);
        vm.expectRevert(CredibilityVault.UnbondNotMatured.selector);
        vault.withdraw();

        // At/after maturity: succeeds. Alice started with 1_000e18, bonded 500e18 (leaving 500e18
        // in her wallet), and now withdraws that same 500e18 back — full balance restored.
        skip(2);
        vm.prank(alice);
        vault.withdraw();
        assertEq(token.balanceOf(alice), 1_000e18);
    }

    function test_RequestUnbond_RevertsBeyondAvailable() public {
        _bond(100e18);
        bytes32 reportId = keccak256("report-2");
        vm.prank(reportRegistry);
        vault.lockForReport(reportId, alice, 60e18);

        vm.prank(alice);
        vm.expectRevert(CredibilityVault.InsufficientAvailable.selector);
        vault.requestUnbond(50e18); // only 40 is unlocked
    }

    function test_Bond_IncreasesPosition() public {
        _bond(250e18);
        (uint128 bonded, , , , ) = vault.positions(alice);
        assertEq(bonded, 250e18);
        assertEq(token.balanceOf(address(vault)), 250e18);
    }

    function test_ApplyDemurrage_DecaysIdleBondedOverTime() public {
        _bond(1_000e18);
        vault.applyDemurrage(alice); // first touch: only sets the baseline, no decay yet
        (uint128 bondedBefore, , , , ) = vault.positions(alice);
        assertEq(bondedBefore, 1_000e18);

        skip(365 days);
        vault.applyDemurrage(alice);
        (uint128 bondedAfter, , , , ) = vault.positions(alice);
        // Exact continuous compounding over exactly 1 year lands at exactly 0.93 by construction
        // (that is the definition of "7%/yr"), so this also pins down the exact-decay implementation.
        assertApproxEqAbs(bondedAfter, 930e18, 1e18);
    }

    // ─── demurrage: exact continuous decay ──────────────────────────────────────────────────

    function test_ApplyDemurrage_ContinuousDecay_MatchesGeometricHalfYear() public {
        _bond(1_000e18);
        vault.applyDemurrage(alice); // baseline

        skip(365 days / 2);
        vault.applyDemurrage(alice);
        (uint128 bondedAfter, , , , ) = vault.positions(alice);

        // Continuous decay over half a year is `sqrt(0.93) * 1000 AVAL` ≈ 964.365 AVAL, distinct
        // from a linear approximation's `1000 * (1 - 0.035) = 965 AVAL`. Pin the exact integer the
        // fixed-point `_wadPow` implementation produces rather than only bounding it, so a linear
        // formula — landing at 965e18, outside this tolerance — fails loudly.
        assertEq(bondedAfter, 964365076097496600000, "continuous decay must match sqrt(0.93) exactly");
        assertLt(bondedAfter, 965e18 - 0.5e18, "must not match the old linear approximation (965 AVAL)");
    }

    function test_ApplyDemurrage_LockedBalanceExempt() public {
        _bond(1_000e18);
        bytes32 reportId = keccak256("report-lock-exempt");
        vm.prank(reportRegistry);
        vault.lockForReport(reportId, alice, 600e18); // 600 locked, 400 idle

        vault.applyDemurrage(alice); // baseline
        skip(365 days);
        vault.applyDemurrage(alice);

        (uint128 bondedAfter, uint128 lockedAfter, , , ) = vault.positions(alice);
        assertEq(lockedAfter, 600e18, "locked balance must not decay at all");
        // Only the idle 400 AVAL decays by ~7%; the exact figure is deterministic.
        assertEq(bondedAfter, 971999999998612163200, "only the idle 400 AVAL decays");
        assertApproxEqAbs(bondedAfter, 972e18, 1e18);
    }

    // ─── the four terminal settlement outcomes route funds correctly ────────────────────────

    function test_Settle_Upheld_NoRebutters_ReporterGetsInsuranceViaSlashInsurance() public {
        // "UPHELD, nobody defends": the reporter must still receive 50% of the target's insurance
        // bonds even though `rebuttersOf[reportId]` is empty (docs/12-reporting.md §4 row 1).
        _bond(400e18); // alice = reporter

        _fundAndBond(erin, 300e18);
        vm.prank(erin);
        vault.bondInsurance(target, 200e18); // erin insured `target`, unrelated to rebutting

        bytes32 reportId = keccak256("report-upheld-no-rebutters");
        vm.prank(reportRegistry);
        vault.lockForReport(reportId, alice, 100e18);

        vm.prank(reportRegistry);
        vault.settle(reportId, CredibilityVault.Outcome.UPHELD, target);

        (uint128 aliceBondedAfterSettle, uint128 aliceLockedAfterSettle, , , ) = vault.positions(alice);
        assertEq(aliceLockedAfterSettle, 0, "reporter's lock released");
        assertEq(aliceBondedAfterSettle, 400e18, "no rebuttal stake: settle() alone changes nothing yet");

        address[] memory insured = new address[](1);
        insured[0] = erin;

        vm.expectEmit(true, false, false, true, address(vault));
        emit CredibilityVault.InsuranceSlashed(reportId, 100e18, 100e18);
        vault.slashInsurance(reportId, insured); // permissionless

        (uint128 erinBondedAfter, uint128 erinLockedAfter, , , ) = vault.positions(erin);
        assertEq(erinBondedAfter, 300e18 - 200e18, "erin's insurance is fully slashed");
        assertEq(erinLockedAfter, 0, "the insurance was erin's only locked balance");

        (uint128 aliceBondedFinal, , , , ) = vault.positions(alice);
        assertEq(aliceBondedFinal, aliceBondedAfterSettle + 100e18, "reporter gets 50% of slashed insurance");
        assertEq(token.balanceOf(treasury), 100e18, "treasury gets the other 50%");

        // Idempotent / guarded: replaying the same list a second time is a silent no-op, not a
        // double-slash — a caller cannot re-drain an address that was never actually insured either.
        vault.slashInsurance(reportId, insured);
        (uint128 erinBondedTwice, , , , ) = vault.positions(erin);
        assertEq(erinBondedTwice, erinBondedAfter, "a second pass over the same voucher is a no-op");
    }

    function test_Settle_Upheld_WithRebuttal_RoutesFundsCorrectly() public {
        _bond(1_000e18); // alice = reporter
        _fundAndBond(carol, 500e18);
        _fundAndBond(dave, 300e18);

        bytes32 reportId = keccak256("report-upheld-rebutted");
        vm.prank(reportRegistry);
        vault.lockForReport(reportId, alice, 200e18);
        vm.prank(reportRegistry);
        vault.lockForRebuttal(reportId, carol, 150e18);
        vm.prank(reportRegistry);
        vault.lockForRebuttal(reportId, dave, 100e18); // rebuttalTotal = 250e18 (>= the 200e18 bond)

        vm.prank(reportRegistry);
        vault.settle(reportId, CredibilityVault.Outcome.UPHELD, target);

        (uint128 aliceBonded, uint128 aliceLocked, , , ) = vault.positions(alice);
        assertEq(aliceLocked, 0, "reporter's lock released");
        assertEq(aliceBonded, 1_000e18 + 125e18, "reporter keeps bond + 50% of rebuttal stake");

        (uint128 carolBonded, uint128 carolLocked, , , ) = vault.positions(carol);
        assertEq(carolLocked, 0);
        assertEq(carolBonded, 500e18 - 150e18, "carol's rebuttal stake is forfeited, not just unlocked");

        (uint128 daveBonded, uint128 daveLocked, , , ) = vault.positions(dave);
        assertEq(daveLocked, 0);
        assertEq(daveBonded, 300e18 - 100e18, "dave's rebuttal stake is forfeited, not just unlocked");

        assertEq(token.balanceOf(treasury), 250e18 - 125e18, "treasury gets the other 50% of rebuttal stake");
    }

    function test_Settle_Unproven_ReturnsEverythingUnharmed() public {
        _bond(1_000e18);
        _fundAndBond(carol, 500e18);

        bytes32 reportId = keccak256("report-unproven");
        vm.prank(reportRegistry);
        vault.lockForReport(reportId, alice, 200e18);
        vm.prank(reportRegistry);
        vault.lockForRebuttal(reportId, carol, 150e18);

        vm.prank(reportRegistry);
        vault.settle(reportId, CredibilityVault.Outcome.UNPROVEN, target);

        (uint128 aliceBonded, uint128 aliceLocked, , , ) = vault.positions(alice);
        assertEq(aliceLocked, 0);
        assertEq(aliceBonded, 1_000e18, "reporter's bond returned in full, nobody punished");

        (uint128 carolBonded, uint128 carolLocked, , , ) = vault.positions(carol);
        assertEq(carolLocked, 0);
        assertEq(carolBonded, 500e18, "rebutter's stake returned in full, nobody punished");

        assertEq(token.balanceOf(treasury), 0, "UNPROVEN settles to zero for everyone");
    }

    function test_Settle_Malicious_RoutesFundsCorrectly() public {
        _bond(1_000e18); // alice = reporter
        _fundAndBond(carol, 500e18);
        _fundAndBond(dave, 300e18);

        bytes32 reportId = keccak256("report-malicious");
        vm.prank(reportRegistry);
        vault.lockForReport(reportId, alice, 200e18);
        vm.prank(reportRegistry);
        vault.lockForRebuttal(reportId, carol, 150e18);
        vm.prank(reportRegistry);
        vault.lockForRebuttal(reportId, dave, 50e18); // rebuttalTotal = 200e18

        vm.prank(reportRegistry);
        vault.settle(reportId, CredibilityVault.Outcome.MALICIOUS, target);

        (uint128 aliceBonded, uint128 aliceLocked, , , ) = vault.positions(alice);
        assertEq(aliceLocked, 0);
        assertEq(aliceBonded, 1_000e18 - 200e18, "reporter's bond is fully slashed");

        // toRebutters = 100e18, toTarget = 100e18, split pro rata by stake (150:50).
        (uint128 carolBonded, uint128 carolLocked, , , ) = vault.positions(carol);
        assertEq(carolLocked, 0);
        assertEq(carolBonded, 500e18 + 75e18, "carol keeps her stake plus a pro-rata share (150/200*100)");

        (uint128 daveBonded, uint128 daveLocked, , , ) = vault.positions(dave);
        assertEq(daveLocked, 0);
        assertEq(daveBonded, 300e18 + 25e18, "dave keeps his stake plus a pro-rata share (50/200*100)");

        (uint128 targetBonded, , , , ) = vault.positions(target);
        assertEq(targetBonded, 100e18, "target receives the other half of the slashed reporter bond");
    }

    function test_Settle_Withdrawn_RoutesFundsCorrectly() public {
        _bond(500e18);
        _fundAndBond(carol, 200e18);

        bytes32 reportId = keccak256("report-withdrawn");
        vm.prank(reportRegistry);
        vault.lockForReport(reportId, alice, 100e18);
        vm.prank(reportRegistry);
        vault.lockForRebuttal(reportId, carol, 80e18);

        vm.prank(reportRegistry);
        vault.settle(reportId, CredibilityVault.Outcome.WITHDRAWN, target);

        (uint128 aliceBonded, uint128 aliceLocked, , , ) = vault.positions(alice);
        assertEq(aliceLocked, 0);
        assertEq(aliceBonded, 500e18 - 10e18, "10% of the reporter's bond is burned on withdrawal");

        (uint128 carolBonded, uint128 carolLocked, , , ) = vault.positions(carol);
        assertEq(carolLocked, 0);
        assertEq(carolBonded, 200e18, "rebutters are made whole on withdrawal");

        assertEq(token.balanceOf(treasury), 10e18, "the 10% burn share reaches the treasury");
    }
}
