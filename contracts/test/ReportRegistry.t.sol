// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VouchMeToken} from "../src/VouchMeToken.sol";
import {VouchMeRegistry} from "../src/VouchMeRegistry.sol";
import {CredibilityVault} from "../src/CredibilityVault.sol";
import {PlatformRegistry} from "../src/PlatformRegistry.sol";
import {ReportRegistry} from "../src/ReportRegistry.sol";
import {MockAddressBook} from "./mocks/MockAddressBook.sol";

/// @notice Covers the challenge game (docs/12-reporting.md §3, §5) end to end: filing, the 72h
///         window (silence ⇒ UPHELD, rebuttal ⇒ ARBITRATION), withdrawal, and arbitration verdicts.
contract ReportRegistryTest is Test {
    VouchMeToken internal token;
    VouchMeRegistry internal vouchMeRegistry;
    CredibilityVault internal vault;
    PlatformRegistry internal platformRegistry;
    ReportRegistry internal reportRegistry;
    MockAddressBook internal addressBook;

    uint256 internal attestorPk = 0xA11CE;
    address internal attestor;
    address internal governor = address(0xF00D);
    address internal treasury = address(0xBEEF);

    address internal alice = address(0x1111); // reporter
    address internal bob = address(0x2222);   // target
    address internal carol = address(0x3333); // voucher of bob / rebutter
    address internal dave = address(0x4444);  // voucher of bob / rebutter
    address internal platformAddr = address(0x9000);

    address internal juror1 = address(0xA001);
    address internal juror2 = address(0xA002);
    address internal juror3 = address(0xA003);
    address internal juror4 = address(0xA004);
    address internal juror5 = address(0xA005);

    bytes32 internal constant CRED = keccak256("orb");

    function setUp() public {
        vm.warp(10 days); // see VouchMeRegistryTest for why: avoids a spurious RateLimited at t=1

        attestor = vm.addr(attestorPk);
        addressBook = new MockAddressBook();
        token = new VouchMeToken(governor);
        vouchMeRegistry = new VouchMeRegistry(address(addressBook), governor, attestor);
        vault = new CredibilityVault(address(token), governor, treasury);
        platformRegistry = new PlatformRegistry(address(token), governor, treasury);
        reportRegistry = new ReportRegistry(
            address(vouchMeRegistry), address(vault), address(platformRegistry), governor
        );

        vm.startPrank(governor);
        token.setMinter(governor, true);
        reportRegistry.setAttestor(attestor, true);
        platformRegistry.setAttestor(attestor, true);
        vault.setReportRegistry(address(reportRegistry));
        vouchMeRegistry.setReportRegistry(address(reportRegistry));
        platformRegistry.setReportRegistry(address(reportRegistry));
        vm.stopPrank();

        _enroll(alice, 1);
        _enroll(bob, 2);
        _fundAndBond(alice, 10_000e18); // headroom to cover any report bond used in these tests
    }

    // ─── VouchMeRegistry enroll/vouch helpers (same pattern as VouchMeRegistry.t.sol) ─────────────

    function _signEnroll(address account, uint256 nullifierHash, uint64 deadline, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(vouchMeRegistry.ENROLL_TYPEHASH(), account, nullifierHash, CRED, deadline, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", vouchMeRegistry.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _enroll(address account, uint256 nullifierHash) internal {
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        uint256 nonce = uint256(keccak256(abi.encode(account, nullifierHash, "enroll-nonce")));
        bytes memory sig = _signEnroll(account, nullifierHash, deadline, nonce);
        vm.prank(account);
        vouchMeRegistry.enroll(nullifierHash, CRED, "handle", deadline, nonce, sig);
    }

    function _signVouch(address voucher, address vouchee, uint8 tier, uint64 deadline, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(vouchMeRegistry.VOUCH_TYPEHASH(), voucher, vouchee, tier, deadline, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", vouchMeRegistry.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _vouch(address voucher, address vouchee) internal {
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        uint256 nonce = uint256(keccak256(abi.encode(voucher, vouchee, block.timestamp, "vouch-nonce")));
        bytes memory sig = _signVouch(voucher, vouchee, 1, deadline, nonce);
        vm.prank(voucher);
        vouchMeRegistry.vouch(vouchee, 1, deadline, nonce, sig);
    }

    // ─── CredibilityVault bonding helper ─────────────────────────────────────────────────────

    function _fundAndBond(address who, uint128 amount) internal {
        vm.prank(governor);
        token.mint(who, amount);
        vm.prank(who);
        token.approve(address(vault), type(uint256).max);
        vm.prank(who);
        vault.bond(amount);
    }

    // ─── ReportRegistry.file helper ──────────────────────────────────────────────────────────

    function _signReport(address reporter, address target, uint32 weightPoints, uint64 deadline, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(reportRegistry.REPORT_TYPEHASH(), reporter, target, weightPoints, deadline, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", reportRegistry.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _file(address reporter, address target, uint32 weightPoints, uint256 nonce)
        internal
        returns (bytes32 id)
    {
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        bytes memory sig = _signReport(reporter, target, weightPoints, deadline, nonce);
        vm.prank(reporter);
        id = reportRegistry.file(target, keccak256("evidence"), weightPoints, deadline, nonce, sig);
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // R-3: platform reporter needs a prior ScoreRequest
    // ═══════════════════════════════════════════════════════════════════════════════════════

    function _registerPlatform() internal {
        vm.prank(governor);
        token.mint(platformAddr, 10_000e18);
        vm.prank(platformAddr);
        token.approve(address(platformRegistry), type(uint256).max);

        uint64 deadline = uint64(block.timestamp + 5 minutes);
        uint256 nonce = 1;
        bytes32 structHash = keccak256(
            abi.encode(
                platformRegistry.REGISTER_TYPEHASH(), platformAddr, keccak256(bytes("platform.vouchme.eth")),
                deadline, nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", platformRegistry.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorPk, digest);

        vm.prank(platformAddr);
        platformRegistry.registerPlatform(
            "platform.vouchme.eth", bytes32("meta"), bytes32("policy"), 5_000e18, deadline, nonce,
            abi.encodePacked(r, s, v)
        );
    }

    function test_File_PlatformReport_WithoutScoreRequest_Reverts() public {
        _registerPlatform();

        uint64 deadline = uint64(block.timestamp + 5 minutes);
        uint256 nonce = 1;
        bytes memory sig = _signReport(platformAddr, bob, 20, deadline, nonce);

        vm.prank(platformAddr);
        vm.expectRevert(ReportRegistry.NoScoreRequest.selector);
        reportRegistry.file(bob, keccak256("evidence"), 20, deadline, nonce, sig);
    }

    function test_File_PlatformReport_WithScoreRequest_Succeeds() public {
        _registerPlatform();
        _fundAndBond(platformAddr, 1_000e18); // report bond is locked from the platform's own position

        vm.prank(platformAddr);
        platformRegistry.requestScore(bob, keccak256("purpose"));

        bytes32 id = _file(platformAddr, bob, 20, 2);
        (address reporter, address target, , uint32 weightPoints, uint128 bondAmt, , , , ,) = reportRegistry.reports(id);
        assertEq(reporter, platformAddr);
        assertEq(target, bob);
        assertEq(weightPoints, 20);
        assertEq(bondAmt, 200e18);
    }

    function test_File_UnenrolledHuman_Reverts() public {
        address stranger = address(0x7777);
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        bytes memory sig = _signReport(stranger, bob, 10, deadline, 1);

        vm.prank(stranger);
        vm.expectRevert(ReportRegistry.NotEnrolledHuman.selector);
        reportRegistry.file(bob, keccak256("evidence"), 10, deadline, 1, sig);
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 72h challenge window: silence ⇒ UPHELD; sufficient rebuttal ⇒ ARBITRATION
    // ═══════════════════════════════════════════════════════════════════════════════════════

    function test_Resolve_BeforeWindow_Reverts() public {
        bytes32 id = _file(alice, bob, 10, 1);

        vm.expectRevert(ReportRegistry.ChallengeWindowOpen.selector);
        reportRegistry.resolve(id);
    }

    function test_Silence72h_Upholds() public {
        bytes32 id = _file(alice, bob, 10, 1); // bond = 100e18

        skip(72 hours + 1);

        vm.expectEmit(true, false, false, true, address(reportRegistry));
        emit ReportRegistry.Resolved(id, ReportRegistry.State.UPHELD, uint64(block.timestamp));
        reportRegistry.resolve(id); // permissionless

        (, , , , , , uint64 resolvedAt, , , ReportRegistry.State state) = reportRegistry.reports(id);
        assertEq(uint8(state), uint8(ReportRegistry.State.UPHELD));
        assertTrue(resolvedAt != 0);
        assertEq(reportRegistry.openReportCount(alice), 0, "the reporter's open-report slot is freed");
    }

    function test_Rebuttal_GreaterEqualBond_TwoRebutters_Escalates() public {
        // carol and dave must be active vouchers of `bob` to be eligible rebutters.
        _enroll(carol, 10);
        _enroll(dave, 11);
        _vouch(carol, bob);
        skip(1 days + 1);
        _vouch(dave, bob);

        bytes32 id = _file(alice, bob, 20, 1); // bond = 200e18

        _fundAndBond(carol, 150e18);
        _fundAndBond(dave, 150e18);

        vm.prank(carol);
        reportRegistry.rebut(id, 120e18);
        vm.prank(dave);
        reportRegistry.rebut(id, 100e18); // total 220e18 >= 200e18 bond, 2 distinct rebutters

        skip(72 hours + 1);

        address[5] memory placeholder;
        vm.expectEmit(true, false, false, true, address(reportRegistry));
        emit ReportRegistry.Escalated(id, placeholder);
        reportRegistry.resolve(id);

        (, , , , , , , , , ReportRegistry.State state) = reportRegistry.reports(id);
        assertEq(uint8(state), uint8(ReportRegistry.State.ARBITRATION), "must escalate, not auto-uphold");
    }

    function test_Rebuttal_BelowBond_StillUpholds() public {
        _enroll(carol, 10);
        _vouch(carol, bob);

        bytes32 id = _file(alice, bob, 20, 1); // bond = 200e18
        _fundAndBond(carol, 150e18);

        vm.prank(carol);
        reportRegistry.rebut(id, 50e18); // well under the 200e18 bond, and only 1 rebutter

        skip(72 hours + 1);
        reportRegistry.resolve(id);

        (, , , , , , , , , ReportRegistry.State state) = reportRegistry.reports(id);
        assertEq(uint8(state), uint8(ReportRegistry.State.UPHELD), "insufficient rebuttal still upholds");
    }

    function test_Rebut_ByNonVoucher_Reverts() public {
        bytes32 id = _file(alice, bob, 10, 1);
        // carol never vouched for bob.
        vm.prank(carol);
        vm.expectRevert(ReportRegistry.NotActiveVoucher.selector);
        reportRegistry.rebut(id, 10e18);
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // withdrawal: 10% burn, only before the window closes
    // ═══════════════════════════════════════════════════════════════════════════════════════

    function test_WithdrawReport_Before72h_Burns10Percent() public {
        _fundAndBond(alice, 500e18); // headroom beyond the report bond, irrelevant to the lock itself
        bytes32 id = _file(alice, bob, 10, 1); // bond = 100e18, locked out of alice's vault position

        vm.prank(alice);
        reportRegistry.withdrawReport(id);

        (, , , , , , , , , ReportRegistry.State state) = reportRegistry.reports(id);
        assertEq(uint8(state), uint8(ReportRegistry.State.WITHDRAWN));
        assertEq(token.balanceOf(treasury), 10e18, "10% of the 100 VOUCHME bond is burned to the treasury");
        assertEq(reportRegistry.openReportCount(alice), 0);
    }

    function test_WithdrawReport_AfterWindow_Reverts() public {
        bytes32 id = _file(alice, bob, 10, 1);
        skip(72 hours + 1);

        vm.prank(alice);
        vm.expectRevert(ReportRegistry.ChallengeWindowClosed.selector);
        reportRegistry.withdrawReport(id);
    }

    function test_WithdrawReport_ByNonReporter_Reverts() public {
        bytes32 id = _file(alice, bob, 10, 1);
        vm.prank(carol);
        vm.expectRevert(ReportRegistry.NotReporter.selector);
        reportRegistry.withdrawReport(id);
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // rate limits: 1 concurrent report per human, 180-day same-pair cooldown
    // ═══════════════════════════════════════════════════════════════════════════════════════

    function test_HumanConcurrentReportCap_Reverts() public {
        _file(alice, bob, 10, 1); // alice's one open report

        address secondTarget = address(0x8888);
        _enroll(secondTarget, 99);

        uint64 deadline = uint64(block.timestamp + 5 minutes);
        bytes memory sig = _signReport(alice, secondTarget, 10, deadline, 2);
        vm.prank(alice);
        vm.expectRevert(ReportRegistry.TooManyOpenReports.selector);
        reportRegistry.file(secondTarget, keccak256("evidence"), 10, deadline, 2, sig);
    }

    function test_SamePairCooldown_Reverts() public {
        bytes32 id = _file(alice, bob, 10, 1);
        skip(72 hours + 1);
        reportRegistry.resolve(id); // frees alice's concurrent-report slot

        uint64 deadline = uint64(block.timestamp + 5 minutes);
        bytes memory sig = _signReport(alice, bob, 10, deadline, 2);
        vm.prank(alice);
        vm.expectRevert(ReportRegistry.CooldownActive.selector);
        reportRegistry.file(bob, keccak256("evidence"), 10, deadline, 2, sig);
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // arbitration: per-juror single vote, and the three verdicts
    // ═══════════════════════════════════════════════════════════════════════════════════════

    function _escalate() internal returns (bytes32 id) {
        _enroll(carol, 10);
        _enroll(dave, 11);
        _vouch(carol, bob);
        skip(1 days + 1);
        _vouch(dave, bob);

        id = _file(alice, bob, 20, 1); // bond = 200e18
        _fundAndBond(carol, 150e18);
        _fundAndBond(dave, 150e18);

        vm.prank(carol);
        reportRegistry.rebut(id, 120e18);
        vm.prank(dave);
        reportRegistry.rebut(id, 100e18);

        skip(72 hours + 1);
        reportRegistry.resolve(id);

        address[5] memory jurors = [juror1, juror2, juror3, juror4, juror5];
        vm.prank(governor);
        reportRegistry.assignJurors(id, jurors);
    }

    function test_JurorCannotVoteTwice() public {
        bytes32 id = _escalate();

        vm.prank(juror1);
        reportRegistry.juryVote(id, true, false);

        vm.prank(juror1);
        vm.expectRevert(ReportRegistry.AlreadyVoted.selector);
        reportRegistry.juryVote(id, true, false);
    }

    function test_JuryVote_ByNonJuror_Reverts() public {
        bytes32 id = _escalate();
        address stranger = address(0x6666);
        vm.prank(stranger);
        vm.expectRevert(ReportRegistry.NotJuror.selector);
        reportRegistry.juryVote(id, true, false);
    }

    function test_Arbitration_MajorityUpheld_SlashesRebuttersAndAppliesSlotPenalty() public {
        bytes32 id = _escalate();

        vm.prank(juror1);
        reportRegistry.juryVote(id, true, false); // uphold
        vm.prank(juror2);
        reportRegistry.juryVote(id, true, false); // uphold
        vm.prank(juror3);
        reportRegistry.juryVote(id, false, false); // unproven

        (, , , , , , , , , ReportRegistry.State state) = reportRegistry.reports(id);
        assertEq(uint8(state), uint8(ReportRegistry.State.UPHELD));

        // Rebutters' stakes are gone (settled through CredibilityVault, verified in
        // CredibilityVault.t.sol); here we confirm the ReportRegistry-side effect: the -1 slot / 30d
        // penalty from docs/12-reporting.md §6 lands on both rebutters.
        (, , , , uint64 carolPenaltyUntil, uint8 carolPenaltyCount, ,) = vouchMeRegistry.members(carol);
        assertTrue(carolPenaltyUntil > block.timestamp);
        assertEq(carolPenaltyCount, 1);
        (, , , , uint64 davePenaltyUntil, uint8 davePenaltyCount, ,) = vouchMeRegistry.members(dave);
        assertTrue(davePenaltyUntil > block.timestamp);
        assertEq(davePenaltyCount, 1);
    }

    function test_Arbitration_MajorityMalicious_VoidsReporterAndSlashesBond() public {
        bytes32 id = _escalate();

        vm.prank(juror1);
        reportRegistry.juryVote(id, false, true); // malicious
        vm.prank(juror2);
        reportRegistry.juryVote(id, false, true); // malicious
        vm.prank(juror3);
        reportRegistry.juryVote(id, true, false); // uphold

        (, , , , , , , , , ReportRegistry.State state) = reportRegistry.reports(id);
        assertEq(uint8(state), uint8(ReportRegistry.State.MALICIOUS));
        assertTrue(reportRegistry.voided(alice), "R-6: a MALICIOUS verdict voids the reporter");

        // A voided reporter cannot file again, anywhere.
        address freshTarget = address(0x8888);
        _enroll(freshTarget, 123);
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        bytes memory sig = _signReport(alice, freshTarget, 10, deadline, 99);
        vm.prank(alice);
        vm.expectRevert(ReportRegistry.ReporterVoidedErr.selector);
        reportRegistry.file(freshTarget, keccak256("evidence"), 10, deadline, 99, sig);
    }

    function test_Arbitration_MajorityUnproven_ReturnsEverything() public {
        bytes32 id = _escalate();

        vm.prank(juror1);
        reportRegistry.juryVote(id, false, false); // unproven
        vm.prank(juror2);
        reportRegistry.juryVote(id, false, false); // unproven
        vm.prank(juror3);
        reportRegistry.juryVote(id, true, false); // uphold

        (, , , , , , , , , ReportRegistry.State state) = reportRegistry.reports(id);
        assertEq(uint8(state), uint8(ReportRegistry.State.UNPROVEN));
        assertFalse(reportRegistry.voided(alice));
    }
}
