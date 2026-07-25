// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AvalRegistry} from "../src/AvalRegistry.sol";
import {MockAddressBook} from "./mocks/MockAddressBook.sol";

contract AvalRegistryTest is Test {
    AvalRegistry internal registry;
    MockAddressBook internal addressBook;

    uint256 internal attestorPk = 0xA11CE;
    address internal attestor;
    address internal governor = address(0xF00D);

    address internal alice = address(0x1111);
    address internal bob = address(0x2222);
    address internal carol = address(0x3333);
    address internal dave = address(0x4444);
    address internal erin = address(0x5555);

    bytes32 internal constant CRED = keccak256("orb");

    function setUp() public {
        // Forge's default block.timestamp is 1. `lastVouchAt` defaults to 0 for a never-vouched
        // member, and the rate-limit check is `block.timestamp < lastVouchAt + 1 days` — at
        // timestamp 1 that's trivially true, so a member's very first-ever vouch would spuriously
        // revert RateLimited. Warp to a realistic timestamp first, same as any real chain would be.
        vm.warp(10 days);

        attestor = vm.addr(attestorPk);
        addressBook = new MockAddressBook();
        registry = new AvalRegistry(address(addressBook), governor, attestor);
    }

    // ─── signing helpers ────────────────────────────────────────────────────
    function _signEnroll(address account, uint256 nullifierHash, bytes32 credential, uint64 deadline, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(registry.ENROLL_TYPEHASH(), account, nullifierHash, credential, deadline, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", registry.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signVouch(address voucher, address vouchee, uint8 tier, uint64 deadline, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(registry.VOUCH_TYPEHASH(), voucher, vouchee, tier, deadline, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", registry.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _enroll(address account, uint256 nullifierHash) internal {
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        uint256 nonce = uint256(keccak256(abi.encode(account, nullifierHash, "enroll-nonce")));
        bytes memory sig = _signEnroll(account, nullifierHash, CRED, deadline, nonce);
        vm.prank(account);
        registry.enroll(nullifierHash, CRED, "handle", deadline, nonce, sig);
    }

    function _vouch(address voucher, address vouchee, uint8 tier) internal {
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        uint256 nonce = uint256(keccak256(abi.encode(voucher, vouchee, tier, block.timestamp, "vouch-nonce")));
        bytes memory sig = _signVouch(voucher, vouchee, tier, deadline, nonce);
        vm.prank(voucher);
        registry.vouch(vouchee, tier, deadline, nonce, sig);
    }

    // ─── tests ──────────────────────────────────────────────────────────────

    function test_DoubleEnroll_SameNullifier_Reverts() public {
        uint256 nullifier = 42;
        _enroll(alice, nullifier);

        uint64 deadline = uint64(block.timestamp + 5 minutes);
        uint256 nonce = uint256(keccak256("bob-nonce"));
        bytes memory sig = _signEnroll(bob, nullifier, CRED, deadline, nonce);

        vm.prank(bob);
        vm.expectRevert(AvalRegistry.NullifierUsed.selector);
        registry.enroll(nullifier, CRED, "bob-handle", deadline, nonce, sig);
    }

    function test_DoubleEnroll_SameAccount_Reverts() public {
        _enroll(alice, 1);

        uint64 deadline = uint64(block.timestamp + 5 minutes);
        uint256 nonce = uint256(keccak256("alice-nonce-2"));
        bytes memory sig = _signEnroll(alice, 2, CRED, deadline, nonce);

        vm.prank(alice);
        vm.expectRevert(AvalRegistry.AlreadyEnrolled.selector);
        registry.enroll(2, CRED, "alice-handle-2", deadline, nonce, sig);
    }

    function test_SelfVouch_Reverts() public {
        _enroll(alice, 1);

        uint64 deadline = uint64(block.timestamp + 5 minutes);
        uint256 nonce = 1;
        bytes memory sig = _signVouch(alice, alice, 1, deadline, nonce);

        vm.prank(alice);
        vm.expectRevert(AvalRegistry.SelfVouch.selector);
        registry.vouch(alice, 1, deadline, nonce, sig);
    }

    function test_VouchBeyondSlots_Reverts() public {
        _enroll(alice, 1);   // voucher, will vouch at tier 1 => 3 slots
        _enroll(bob, 2);
        _enroll(carol, 3);
        _enroll(dave, 4);
        _enroll(erin, 5);

        // Fill all 3 tier-1 slots, spaced >24h apart to respect the rate limit.
        _vouch(alice, bob, 1);
        skip(1 days + 1);
        _vouch(alice, carol, 1);
        skip(1 days + 1);
        _vouch(alice, dave, 1);

        // 4th vouch, also spaced out so only NoSlots (not RateLimited) can be the cause.
        skip(1 days + 1);
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        uint256 nonce = 999;
        bytes memory sig = _signVouch(alice, erin, 1, deadline, nonce);

        vm.prank(alice);
        vm.expectRevert(AvalRegistry.NoSlots.selector);
        registry.vouch(erin, 1, deadline, nonce, sig);
    }

    function test_SecondVouchWithin24h_Reverts() public {
        _enroll(alice, 1);
        _enroll(bob, 2);
        _enroll(carol, 3);

        _vouch(alice, bob, 1);

        uint64 deadline = uint64(block.timestamp + 5 minutes);
        uint256 nonce = 2;
        bytes memory sig = _signVouch(alice, carol, 1, deadline, nonce);

        vm.prank(alice);
        vm.expectRevert(AvalRegistry.RateLimited.selector);
        registry.vouch(carol, 1, deadline, nonce, sig);
    }

    function test_Revoke_FreesSlot_Immediately() public {
        _enroll(alice, 1);
        _enroll(bob, 2);
        _enroll(carol, 3);
        _enroll(dave, 4);
        _enroll(erin, 5);

        _vouch(alice, bob, 1);
        skip(1 days + 1);
        _vouch(alice, carol, 1);
        skip(1 days + 1);
        _vouch(alice, dave, 1);

        (, , uint32 activeBefore, , , , ,) = registry.members(alice);
        assertEq(activeBefore, 3, "3 slots should be filled");

        // Revoke one — must free the slot with no gate, no cost, no cooldown.
        vm.prank(alice);
        registry.revoke(bob);

        (, , uint32 activeAfter, , , , ,) = registry.members(alice);
        assertEq(activeAfter, 2, "revoke must free the slot immediately");

        // Prove the freed slot is usable: a 4th vouch now succeeds (after respecting rate limit).
        skip(1 days + 1);
        _vouch(alice, erin, 1);
        (, , uint32 activeFinal, , , , ,) = registry.members(alice);
        assertEq(activeFinal, 3, "freed slot should be usable again");
    }

    function test_Reaffirm_NoRateLimit() public {
        _enroll(alice, 1);
        _enroll(bob, 2);

        _vouch(alice, bob, 1);

        // Reaffirm in the very same block as the vouch — must NOT revert with RateLimited,
        // because re-affirming is not new trust (docs/10-constants.md §4).
        vm.prank(alice);
        registry.reaffirm(bob);

        (, uint64 expiresAt, ) = registry.vouches(alice, bob);
        assertEq(expiresAt, uint64(block.timestamp) + registry.VOUCH_EXPIRY());

        // And it can be called again immediately, still no rate limit.
        vm.prank(alice);
        registry.reaffirm(bob);
    }

    function test_Enroll_EmitsEvent() public {
        uint256 nullifier = 7;
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        uint256 nonce = 123;
        bytes memory sig = _signEnroll(alice, nullifier, CRED, deadline, nonce);

        vm.expectEmit(true, true, false, true, address(registry));
        emit AvalRegistry.Enrolled(alice, nullifier, CRED, uint64(block.timestamp) + registry.CREDENTIAL_VALIDITY(), "handle");

        vm.prank(alice);
        registry.enroll(nullifier, CRED, "handle", deadline, nonce, sig);
    }

    function test_BadAttestor_Reverts() public {
        uint256 badPk = 0xBAD;
        uint256 nullifier = 55;
        uint64 deadline = uint64(block.timestamp + 5 minutes);
        uint256 nonce = 1;

        bytes32 structHash = keccak256(
            abi.encode(registry.ENROLL_TYPEHASH(), alice, nullifier, CRED, deadline, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", registry.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(badPk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(alice);
        vm.expectRevert(AvalRegistry.BadAttestation.selector);
        registry.enroll(nullifier, CRED, "handle", deadline, nonce, sig);
    }
}
