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
        // ~7%/yr linear approximation on fully-idle (unlocked) bonded balance.
        assertApproxEqAbs(bondedAfter, 930e18, 1e18);
    }
}
