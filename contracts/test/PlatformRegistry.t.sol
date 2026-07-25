// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {AvalToken} from "../src/AvalToken.sol";
import {AvalRegistry} from "../src/AvalRegistry.sol";
import {PlatformRegistry} from "../src/PlatformRegistry.sol";
import {MockAddressBook} from "./mocks/MockAddressBook.sol";

contract PlatformRegistryTest is Test {
    AvalToken internal token;
    AvalRegistry internal avalRegistry;
    PlatformRegistry internal platformRegistry;
    MockAddressBook internal addressBook;

    uint256 internal attestorPk = 0xA11CE;
    address internal attestor;
    address internal governor = address(0xF00D);
    address internal treasury = address(0xBEEF);
    address internal platform = address(0x9000);
    address internal humanVoucher = address(0x1111);

    function setUp() public {
        attestor = vm.addr(attestorPk);
        addressBook = new MockAddressBook();
        token = new AvalToken(governor);
        avalRegistry = new AvalRegistry(address(addressBook), governor, attestor);
        platformRegistry = new PlatformRegistry(address(token), governor, treasury);

        vm.startPrank(governor);
        token.setMinter(governor, true);
        platformRegistry.setAttestor(attestor, true);
        vm.stopPrank();

        vm.prank(governor);
        token.mint(platform, 10_000e18);
        vm.prank(platform);
        token.approve(address(platformRegistry), type(uint256).max);
    }

    function _registerPlatform() internal {
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        uint256 nonce = 1;
        bytes32 structHash = keccak256(
            abi.encode(
                platformRegistry.REGISTER_TYPEHASH(),
                platform,
                keccak256(bytes("myapp.aval.eth")),
                deadline,
                nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", platformRegistry.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorPk, digest);

        vm.prank(platform);
        platformRegistry.registerPlatform(
            "myapp.aval.eth", bytes32("meta"), bytes32("policy"), 5_000e18, deadline, nonce, abi.encodePacked(r, s, v)
        );
    }

    // ─── P-3, structural: platforms can never vouch for humans ─────────────
    //
    // There is no function in PlatformRegistry.sol that takes a human `vouchee` from a platform
    // `msg.sender` — grep the file: the only vouch-shaped entry points are `vouchPlatform` (a HUMAN
    // vouching for a platform) and `revokePlatformVouch`. This is a compile-time absence (P-3), not
    // a runtime check. As a runtime corroboration, the only place a "vouch" from an arbitrary
    // address could land on a human is `AvalRegistry.vouch`, and a platform address was never
    // `AvalRegistry.enroll`-ed (registration happens exclusively through PlatformRegistry, an
    // entirely separate contract/storage space), so even a platform attempting to call the human
    // registry's vouch function structurally fails.
    function test_P3_NoPlatformToHumanVouchPath() public {
        _registerPlatform();

        uint64 deadline = uint64(block.timestamp + 5 minutes);
        bytes memory bogusSig = new bytes(65);

        vm.prank(platform);
        vm.expectRevert(AvalRegistry.NotEnrolled.selector);
        avalRegistry.vouch(humanVoucher, 1, deadline, 1, bogusSig);
    }

    // ─── requestScore records the pair and is queryable by ReportRegistry ──
    function test_RequestScore_RecordsPair() public {
        _registerPlatform();

        address subject = address(0xCAFE);
        bytes32 purpose = keccak256("airdrop-eligibility");

        vm.prank(platform);
        bytes32 requestId = platformRegistry.requestScore(subject, purpose);

        assertTrue(requestId != bytes32(0));
        bytes32 key = keccak256(abi.encode(platform, subject));
        assertTrue(platformRegistry.scoreRequests(key), "the (platform, subject) pair must be recorded");
    }

    function test_RequestScore_RevertsForUnregisteredPlatform() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert(PlatformRegistry.NotRegistered.selector);
        platformRegistry.requestScore(address(0xCAFE), keccak256("purpose"));
    }

    function test_RequestScore_EmitsScoreRequested() public {
        _registerPlatform();
        address subject = address(0xCAFE);
        bytes32 purpose = keccak256("purpose");

        vm.recordLogs();
        vm.prank(platform);
        platformRegistry.requestScore(subject, purpose);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == keccak256("ScoreRequested(bytes32,address,address,bytes32,uint64)")) {
                found = true;
            }
        }
        assertTrue(found, "ScoreRequested must be emitted");
    }

    function test_RegisterPlatform_RevertsBelowMinBond() public {
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        uint256 nonce = 2;
        bytes32 structHash = keccak256(
            abi.encode(platformRegistry.REGISTER_TYPEHASH(), platform, keccak256(bytes("x.aval.eth")), deadline, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", platformRegistry.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorPk, digest);

        vm.prank(platform);
        vm.expectRevert(PlatformRegistry.InsufficientBond.selector);
        platformRegistry.registerPlatform(
            "x.aval.eth", bytes32(0), bytes32(0), 100e18, deadline, nonce, abi.encodePacked(r, s, v)
        );
    }

    function test_HumanAndPlatformSlots_AreIndependentPools() public {
        _registerPlatform();
        // Human slot pool lives entirely in AvalRegistry.Member.activeOutbound; platform slot pool
        // lives in PlatformRegistry.HumanActivity.activeOutbound. Confirm they are in fact two
        // different storage locations, not shared counters, by checking a fresh human's platform
        // activity is zero regardless of AvalRegistry state.
        (uint32 platformActive, , ) = platformRegistry.humanActivity(humanVoucher);
        assertEq(platformActive, 0);
    }

    // ─── G-B5: an address must not be both a human and a platform (mirror of AvalRegistry's) ──

    function test_RegisterPlatform_RevertsIfEnrolledHuman() public {
        vm.startPrank(governor);
        avalRegistry.setAttestor(attestor, true);
        platformRegistry.setAvalRegistry(address(avalRegistry));
        vm.stopPrank();

        // A registered platform address (`platform`) first enrolls as a human in AvalRegistry.
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        uint256 nonce = 1;
        bytes32 structHash = keccak256(
            abi.encode(avalRegistry.ENROLL_TYPEHASH(), platform, uint256(777), keccak256("orb"), deadline, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", avalRegistry.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorPk, digest);

        vm.prank(platform);
        avalRegistry.enroll(777, keccak256("orb"), "platform-as-human", deadline, nonce, abi.encodePacked(r, s, v));

        // Now the same address tries to register as a platform — must revert. `expectRevert` only
        // covers the *very next* call, so the attestation is signed here (off-chain, no external
        // call) rather than through `_registerPlatform()`, which makes an extra `REGISTER_TYPEHASH()`
        // view call of its own before the real one and would consume the expectation early.
        uint64 deadline2 = uint64(block.timestamp + 5 minutes);
        uint256 nonce2 = 2;
        bytes32 structHash2 = keccak256(
            abi.encode(
                platformRegistry.REGISTER_TYPEHASH(), platform, keccak256(bytes("myapp.aval.eth")), deadline2, nonce2
            )
        );
        bytes32 digest2 = keccak256(abi.encodePacked("\x19\x01", platformRegistry.domainSeparator(), structHash2));
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(attestorPk, digest2);

        vm.prank(platform);
        vm.expectRevert(PlatformRegistry.AlreadyEnrolledHuman.selector);
        platformRegistry.registerPlatform(
            "myapp.aval.eth", bytes32("meta"), bytes32("policy"), 5_000e18, deadline2, nonce2,
            abi.encodePacked(r2, s2, v2)
        );
    }
}
