// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AvalToken} from "../src/AvalToken.sol";
import {AvalRegistry} from "../src/AvalRegistry.sol";
import {CredibilityVault} from "../src/CredibilityVault.sol";
import {PresenceDrip} from "../src/PresenceDrip.sol";
import {MockAddressBook} from "./mocks/MockAddressBook.sol";

/// @dev Test-only harness exposing the internal pure tenure formula and a direct storage setter,
///      so the exact-integer table in docs/16-presence-drip.md §4 can be asserted without driving
///      a full claim() flow (which would otherwise require minting/attesting thousands of epochs).
contract PresenceDripHarness is PresenceDrip {
    constructor(address t, address v, address a, address g) PresenceDrip(t, v, a, g) {}

    function setEpochsClaimed(address account, uint64 epochs) external {
        presence[account].epochsClaimed = epochs;
    }

    function tenureCentiFromEpochs(uint64 e) external pure returns (uint32) {
        return _tenureCentiFromEpochs(e);
    }
}

contract PresenceDripTest is Test {
    AvalToken internal token;
    AvalRegistry internal registry;
    CredibilityVault internal vault;
    PresenceDripHarness internal drip;
    MockAddressBook internal addressBook;

    uint256 internal attestorPk = 0xA11CE;
    address internal attestor;
    address internal governor = address(0xF00D);
    address internal treasury = address(0xBEEF);
    address internal alice = address(0x1111);

    function setUp() public {
        attestor = vm.addr(attestorPk);
        addressBook = new MockAddressBook();
        registry = new AvalRegistry(address(addressBook), governor, attestor);
        token = new AvalToken(governor);
        vault = new CredibilityVault(address(token), governor, treasury);
        drip = new PresenceDripHarness(address(token), address(vault), address(registry), governor);

        vm.prank(governor);
        token.setMinter(address(drip), true);

        // Enroll alice so PresenceDrip's `_startTime` (which reads AvalRegistry.members(a).enrolledAt)
        // has a nonzero baseline.
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        uint256 nonce = 1;
        bytes32 structHash = keccak256(
            abi.encode(registry.ENROLL_TYPEHASH(), alice, uint256(1), keccak256("orb"), deadline, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", registry.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorPk, digest);
        vm.prank(alice);
        registry.enroll(1, keccak256("orb"), "alice", deadline, nonce, abi.encodePacked(r, s, v));
    }

    // ─── D-3-equivalent: exact §4 table ─────────────────────────────────────
    function test_TenureCenti_ExactTable() public {
        assertEq(drip.tenureCentiFromEpochs(0), 0, "epoch 0");
        assertEq(drip.tenureCentiFromEpochs(120), 41, "epoch 120 (30d)");
        assertEq(drip.tenureCentiFromEpochs(360), 125, "epoch 360 (90d)");
        assertEq(drip.tenureCentiFromEpochs(720), 250, "epoch 720 (180d)");
        assertEq(drip.tenureCentiFromEpochs(1440), 375, "epoch 1440 (360d)");
        assertEq(drip.tenureCentiFromEpochs(2160), 437, "epoch 2160 (540d)");
        assertEq(drip.tenureCentiFromEpochs(2880), 468, "epoch 2880 (720d)");
    }

    function test_TenureCenti_ViaStoredEpochs() public {
        drip.setEpochsClaimed(alice, 720);
        assertEq(drip.tenureCenti(alice), 250);
    }

    function test_TenureCenti_MonotoneAndBounded() public {
        // Never exceeds T_MAX_CENTI, and is monotone non-decreasing in E — cheap sanity invariant
        // that would catch a sign error in the interpolation even without the exact table.
        uint32 prev = 0;
        uint64[7] memory sample = [uint64(0), 100, 1000, 10_000, 100_000, 1_000_000, 10_000_000];
        for (uint256 i = 0; i < sample.length; i++) {
            uint32 t = drip.tenureCentiFromEpochs(sample[i]);
            assertLe(t, drip.T_MAX_CENTI());
            assertGe(t, prev);
            prev = t;
        }
    }

    // ─── invariant I-17 spirit: presence alone can never reach Tier 1 ───────
    function test_PresenceAlone_NeverPromotes() public view {
        uint32 tenure = drip.tenureCentiFromEpochs(10_000_000); // enormous, unrealistic epoch count
        uint256 scoreCenti = 1000 + tenure; // base(10) in centi-points + tenure
        assertLt(scoreCenti, 3000, "base + T_MAX must stay under T1=30 (I-17)");
    }

    // ─── D-1: accrual for 90 days without claiming ⇒ exactly 30 days' worth ─
    function test_Accrued_90Days_CapsAt30DaysWorth() public {
        skip(90 days);
        uint256 amount = drip.accrued(alice);
        // 120 epochs (the 30-day cap) × 0.25 AVAL/epoch = 30 AVAL, at the nominal (tier-blind) rate.
        assertEq(amount, 30e18, "90 days unclaimed must cap at exactly 30 days' worth");
    }

    function test_Accrued_Under30Days_IsUncapped() public {
        skip(10 days);
        uint256 amount = drip.accrued(alice);
        // 10 days = 40 epochs × 0.25 AVAL = 10 AVAL, well under the cap.
        assertEq(amount, 10e18);
    }

    function test_Accrued_ZeroForNeverEnrolled() public view {
        assertEq(drip.accrued(address(0x9999)), 0);
    }

    // ─── claim() mints the tier-adjusted amount and advances state ─────────
    function _signTier(address account, uint8 tier, uint64 deadline, uint256 nonce) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(drip.TIER_TYPEHASH(), account, tier, deadline, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", drip.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_Claim_Tier0_YieldsQuarterRate_NoTenure() public {
        vm.prank(governor);
        drip.setAttestor(attestor, true);

        skip(10 days); // 40 epochs
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        bytes memory sig = _signTier(alice, 0, deadline, 1);

        vm.prank(alice);
        drip.claim(0, deadline, 1, sig);

        // 40 epochs × 0.25 AVAL × 25% = 2.5 AVAL
        assertEq(token.balanceOf(alice), 2.5e18);
        (, uint64 epochsClaimed, ) = drip.presence(alice);
        assertEq(epochsClaimed, 0, "tier 0 must gain zero tenure epochs");
    }

    function test_Claim_Tier1_YieldsFullRate_WithTenure() public {
        vm.prank(governor);
        drip.setAttestor(attestor, true);

        skip(10 days); // 40 epochs
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        bytes memory sig = _signTier(alice, 1, deadline, 1);

        vm.prank(alice);
        drip.claim(1, deadline, 1, sig);

        assertEq(token.balanceOf(alice), 10e18, "40 epochs x 0.25 AVAL at full rate = 10 AVAL");
        (, uint64 epochsClaimed, ) = drip.presence(alice);
        assertEq(epochsClaimed, 40);
    }
}
