// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAddressBook} from "./interfaces/IAddressBook.sol";

/// @dev Minimal local interface to avoid a circular concrete import with `PresenceDrip` (which
///      itself imports `VouchMeRegistry`). Used only by the optional post-deploy fraud-zero hook.
interface IPresenceDripZero {
    function zeroTenure(address account) external;
}

/// @dev Minimal local interface mirroring `PlatformRegistry.isRegistered`, used only for the
///      dual-role guard in `enroll` (docs/02-contracts.md §0). Avoids a circular
///      concrete import: `PlatformRegistry` has no compile-time dependency on `VouchMeRegistry`, but
///      wiring both directions through a concrete import would still force a deployment order.
///      Settable post-deploy by governor, same pattern as `reportRegistry` / `presenceDrip`.
interface IPlatformRegistryCheck {
    function isRegistered(address account) external view returns (bool);
}

/// @title VouchMeRegistry
/// @notice The trust graph. Records facts only — enroll, vouch, reaffirm, revoke — as events; the
///         Subgraph computes score/tier/depth. See docs/02-contracts.md §1.
/// @dev Global properties whose truth spans the whole graph (voucherTier at vouch time, report
///      weight elsewhere) are supplied by an off-chain attestor over EIP-712 and checked against
///      the `attestors` allowlist. A forged attestation buys an edge the Subgraph recompute simply
///      will not credit — see docs/02-contracts.md §3.2.
contract VouchMeRegistry {
    // ─── types ──────────────────────────────────────────────────────────────
    struct Member {
        uint64  enrolledAt;
        uint64  credentialExpiresAt;   // Selfie Check validity: enrolledAt + 90d
        uint32  activeOutbound;        // maintained incrementally; slots are enforced here
        uint64  lastVouchAt;           // rate limit: 1 new vouch / 24h
        uint64  slotPenaltyUntil;      // fraud penalty window
        uint8   slotPenaltyCount;
        bool    enrolled;
        bool    fraudulent;
    }

    struct Vouch {
        uint64 issuedAt;
        uint64 expiresAt;              // issuedAt + 90d, reset on reaffirm
        bool   revoked;                // true on explicit revoke() OR lazily on sweep() past expiry
    }

    // ─── constants (docs/10-constants.md §4-5) ─────────────────────────────
    uint64  public constant VOUCH_EXPIRY        = 90 days;
    uint64  public constant CREDENTIAL_VALIDITY = 90 days;
    uint64  public constant GRACE_PERIOD        = 14 days;
    uint64  public constant VOUCH_RATE_LIMIT    = 1 days;
    uint64  public constant FRAUD_SLOT_PENALTY  = 30 days;
    uint32  public constant SLOTS_TIER1         = 3;
    uint32  public constant SLOTS_TIER2         = 10;
    uint64  public constant MAX_ATTESTATION_TTL = 5 minutes;
    /// @dev Same 30-day duration as the fraud penalty but a distinct trigger — do not conflate
    ///      reports with confirmed fraud (docs/12-reporting.md §7).
    uint64  public constant REPORT_SLOT_PENALTY = 30 days;

    // ─── EIP-712 ────────────────────────────────────────────────────────────
    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant ENROLL_TYPEHASH = keccak256(
        "EnrollAttestation(address account,uint256 nullifierHash,bytes32 credential,uint64 deadline,uint256 nonce)"
    );
    bytes32 public constant VOUCH_TYPEHASH = keccak256(
        "VouchAttestation(address voucher,address vouchee,uint8 voucherTier,uint64 deadline,uint256 nonce)"
    );

    // ─── storage ────────────────────────────────────────────────────────────
    IAddressBook public immutable addressBook;
    bytes32      public immutable domainSeparator;

    mapping(address => Member)                    public members;
    mapping(address => mapping(address => Vouch)) public vouches;   // voucher => vouchee
    mapping(uint256 => bool)                      public usedNullifier;
    mapping(address => bool)                      public attestors;
    mapping(bytes32 => bool)                      public usedAttestation;
    address public governor;
    /// @dev Not in the docs/02-contracts.md sketch — needed so `ReportRegistry` can apply the
    ///      -1-slot/30-day penalty on UPHELD reports (docs/12-reporting.md §6) without granting it
    ///      `onlyGovernor`. Settable by governor, same pattern as `attestors`.
    address public reportRegistry;
    /// @dev Same post-deploy-wiring reasoning as `reportRegistry`: `PresenceDrip`'s constructor
    ///      needs this contract's address, so this contract cannot also require `PresenceDrip`'s
    ///      address at construction. Settable by governor; `confirmFraud` no-ops the hook while unset.
    address public presenceDrip;
    /// @dev Dual-role guard counterpart (docs/02-contracts.md §0): `enroll` reverts if this
    ///      address reports the caller as an active platform. Settable post-deploy by governor —
    ///      `PlatformRegistry` is deployed independently and neither constructor can require the
    ///      other's address without a circular dependency. No-ops (permits enrollment) while unset,
    ///      same convention as `presenceDrip`.
    address public platformRegistry;

    // ─── events (the entire Subgraph surface) ───────────────────────────────
    event Enrolled(address indexed account, uint256 indexed nullifierHash,
                   bytes32 credential, uint64 credentialExpiresAt, string handle);
    event Vouched(address indexed voucher, address indexed vouchee,
                  uint64 issuedAt, uint64 expiresAt);
    event Reaffirmed(address indexed voucher, address indexed vouchee, uint64 expiresAt);
    event Revoked(address indexed voucher, address indexed vouchee, uint64 at);
    event Swept(address indexed voucher, address indexed vouchee, uint64 at);
    event CredentialRenewed(address indexed account, uint64 credentialExpiresAt);
    event FraudConfirmed(address indexed account, uint64 at, bytes32 reason);
    event SlotPenaltyApplied(address indexed voucher, uint64 until);
    event AttestorSet(address indexed attestor, bool enabled);
    event GovernorTransferred(address indexed previousGovernor, address indexed newGovernor);
    event ReportRegistrySet(address indexed reportRegistry);
    event PlatformRegistrySet(address indexed platformRegistry);
    /// @notice One event per outbound edge voided by `confirmFraud` (FR-7) — "the fraudulent
    ///         account's own outbound vouches", distinct from the `SlotPenaltyApplied` events fired
    ///         for its *vouchers*. The Subgraph follows this the same way it follows `Revoked`.
    event OutboundVouchVoided(address indexed account, address indexed vouchee, uint64 at);

    // ─── errors ─────────────────────────────────────────────────────────────
    error NotEnrolled(); error AlreadyEnrolled(); error NullifierUsed();
    error BadAttestation(); error AttestationExpired(); error AttestationReplayed();
    error NoSlots(); error RateLimited(); error SelfVouch();
    error VouchExists(); error NoSuchVouch(); error CredentialExpired();
    error InsufficientTier(); error Suspended();
    error NotGovernor(); error ZeroAddress(); error NotReportRegistry();
    /// @notice Dual-role guard: raised by `enroll` when `msg.sender` is already an active
    ///         platform in the wired `PlatformRegistry`.
    error AlreadyPlatform();

    // ─── modifiers ──────────────────────────────────────────────────────────
    modifier onlyGovernor() {
        if (msg.sender != governor) revert NotGovernor();
        _;
    }

    modifier onlyReportRegistry() {
        if (msg.sender != reportRegistry) revert NotReportRegistry();
        _;
    }

    constructor(address _addressBook, address _governor, address _initialAttestor) {
        if (_addressBook == address(0) || _governor == address(0)) revert ZeroAddress();
        addressBook = IAddressBook(_addressBook);
        governor = _governor;
        emit GovernorTransferred(address(0), _governor);
        if (_initialAttestor != address(0)) {
            attestors[_initialAttestor] = true;
            emit AttestorSet(_initialAttestor, true);
        }
        domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("VouchMeRegistry")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    // ─── governance ─────────────────────────────────────────────────────────
    function setAttestor(address attestor, bool enabled) external onlyGovernor {
        attestors[attestor] = enabled;
        emit AttestorSet(attestor, enabled);
    }

    function transferGovernor(address newGovernor) external onlyGovernor {
        if (newGovernor == address(0)) revert ZeroAddress();
        emit GovernorTransferred(governor, newGovernor);
        governor = newGovernor;
    }

    function setReportRegistry(address _reportRegistry) external onlyGovernor {
        reportRegistry = _reportRegistry;
        emit ReportRegistrySet(_reportRegistry);
    }

    function setPresenceDrip(address _presenceDrip) external onlyGovernor {
        presenceDrip = _presenceDrip;
    }

    /// @notice Wires the `PlatformRegistry` address for the dual-role guard in `enroll`
    ///         (docs/02-contracts.md §0). Governor-only, post-deploy, same reasoning as
    ///         `setReportRegistry` / `setPresenceDrip`.
    function setPlatformRegistry(address _platformRegistry) external onlyGovernor {
        platformRegistry = _platformRegistry;
        emit PlatformRegistrySet(_platformRegistry);
    }

    /// @notice True if `a` holds an enrolled `Member` record. Read by `PlatformRegistry` for the
    ///         other half of the dual-role guard (`registerPlatform` reverts if `a` is enrolled here).
    function isEnrolled(address a) external view returns (bool) {
        return members[a].enrolled;
    }

    // ─── 3.1 enroll ─────────────────────────────────────────────────────────
    function enroll(
        uint256 nullifierHash,
        bytes32 credential,          // keccak("selfie-check") | keccak("orb")
        string calldata handle,      // ENS label, validated off-chain, uniqueness enforced by registrar
        uint64  deadline,
        uint256 nonce,
        bytes   calldata attestation // EIP-712 sig over (msg.sender, nullifierHash, credential, deadline, nonce)
    ) external {
        if (members[msg.sender].enrolled) revert AlreadyEnrolled();
        if (usedNullifier[nullifierHash]) revert NullifierUsed();   // ← one account per World ID
        // Dual-role guard: an address must not stack a human report weight AND a platform
        // report weight against the same target. No-ops (permits enrollment) until governor wires
        // `platformRegistry` post-deploy.
        if (platformRegistry != address(0) && IPlatformRegistryCheck(platformRegistry).isRegistered(msg.sender)) {
            revert AlreadyPlatform();
        }

        bytes32 structHash = keccak256(
            abi.encode(ENROLL_TYPEHASH, msg.sender, nullifierHash, credential, deadline, nonce)
        );
        _consumeAttestation(structHash, deadline, attestation);

        usedNullifier[nullifierHash] = true;
        uint64 exp = uint64(block.timestamp) + CREDENTIAL_VALIDITY;
        members[msg.sender] = Member({
            enrolledAt: uint64(block.timestamp),
            credentialExpiresAt: exp,
            activeOutbound: 0,
            lastVouchAt: 0,
            slotPenaltyUntil: 0,
            slotPenaltyCount: 0,
            enrolled: true,
            fraudulent: false
        });
        emit Enrolled(msg.sender, nullifierHash, credential, exp, handle);
    }

    /// @notice Re-verification of the Selfie Check credential. Not shown as a code block in
    ///         docs/02-contracts.md, but `CredentialRenewed` is declared there, so an emitter must
    ///         exist. Same attestation discipline as `enroll`.
    function renewCredential(
        bytes32 credential,
        uint64  deadline,
        uint256 nonce,
        bytes   calldata attestation
    ) external {
        if (!members[msg.sender].enrolled) revert NotEnrolled();
        bytes32 structHash = keccak256(
            abi.encode(ENROLL_TYPEHASH, msg.sender, uint256(0), credential, deadline, nonce)
        );
        _consumeAttestation(structHash, deadline, attestation);
        uint64 exp = uint64(block.timestamp) + CREDENTIAL_VALIDITY;
        members[msg.sender].credentialExpiresAt = exp;
        emit CredentialRenewed(msg.sender, exp);
    }

    // ─── 3.2 vouch ──────────────────────────────────────────────────────────
    function vouch(
        address vouchee,
        uint8   voucherTier,         // asserted by attestor from the Subgraph-computed score
        uint64  deadline,
        uint256 nonce,
        bytes   calldata presenceAttestation
    ) external {
        if (vouchee == msg.sender)                 revert SelfVouch();
        if (!members[msg.sender].enrolled)         revert NotEnrolled();
        if (!members[vouchee].enrolled)            revert NotEnrolled();
        if (_suspended(msg.sender))                revert Suspended();
        if (voucherTier == 0)                      revert InsufficientTier();   // FR-3
        if (vouches[msg.sender][vouchee].issuedAt != 0
            && !_dead(vouches[msg.sender][vouchee])) revert VouchExists();
        if (block.timestamp < members[msg.sender].lastVouchAt + VOUCH_RATE_LIMIT) revert RateLimited();
        if (_slotsAvailable(msg.sender, voucherTier) == 0) revert NoSlots();

        // presence + tier are attested together: the attestation binds
        // (voucher, vouchee, tier, deadline, nonce) and is single-use.
        bytes32 structHash = keccak256(
            abi.encode(VOUCH_TYPEHASH, msg.sender, vouchee, voucherTier, deadline, nonce)
        );
        _consumeAttestation(structHash, deadline, presenceAttestation);

        uint64 exp = uint64(block.timestamp) + VOUCH_EXPIRY;
        vouches[msg.sender][vouchee] = Vouch(uint64(block.timestamp), exp, false);
        members[msg.sender].activeOutbound += 1;
        members[msg.sender].lastVouchAt = uint64(block.timestamp);
        emit Vouched(msg.sender, vouchee, uint64(block.timestamp), exp);
    }

    // ─── 3.3 reaffirm, revoke ───────────────────────────────────────────────
    function reaffirm(address vouchee) external {
        Vouch storage v = vouches[msg.sender][vouchee];
        if (v.issuedAt == 0 || v.revoked) revert NoSuchVouch();
        if (_suspended(msg.sender))       revert Suspended();
        v.expiresAt = uint64(block.timestamp) + VOUCH_EXPIRY;    // no rate limit — not new trust
        emit Reaffirmed(msg.sender, vouchee, v.expiresAt);
    }

    function revoke(address vouchee) external {
        Vouch storage v = vouches[msg.sender][vouchee];
        if (v.issuedAt == 0 || v.revoked) revert NoSuchVouch();
        v.revoked = true;
        if (members[msg.sender].activeOutbound > 0) members[msg.sender].activeOutbound -= 1;
        emit Revoked(msg.sender, vouchee, uint64(block.timestamp));
    }

    // ─── sweep: permissionless expiry cleanup (§3.4) ────────────────────────
    /// @notice Anyone may sweep a voucher's provably-expired, not-yet-revoked edges so
    ///         `activeOutbound` (an over-estimate by construction) is brought back in line and
    ///         the slot is freed. Idempotent: an already-swept or already-revoked edge is skipped.
    function sweep(address voucher, address[] calldata vouchees) external {
        for (uint256 i = 0; i < vouchees.length; ++i) {
            Vouch storage v = vouches[voucher][vouchees[i]];
            if (v.issuedAt != 0 && !v.revoked && block.timestamp >= v.expiresAt) {
                v.revoked = true;
                if (members[voucher].activeOutbound > 0) members[voucher].activeOutbound -= 1;
                emit Swept(voucher, vouchees[i], uint64(block.timestamp));
            }
        }
    }

    // ─── 3.5 anchors ─────────────────────────────────────────────────────────
    /// @dev Live, never cached on-chain. The Address Book returns an EXPIRY, not a flag — Orb
    ///      verification lapses unless renewed — so anchor status is "verified until a moment
    ///      still ahead of this block", not "was verified once". See `interfaces/IAddressBook.sol`.
    function isAnchor(address a) public view returns (bool) {
        return addressBook.addressVerifiedUntil(a) > block.timestamp;
    }

    /// @notice Public wrapper so other contracts (e.g. `PresenceDrip`) can read the same
    ///         suspended-credential predicate `vouch`/`reaffirm` gate on internally.
    function isSuspended(address a) external view returns (bool) {
        return _suspended(a);
    }

    /// @notice True if `voucher` currently has a live (unrevoked, unexpired) vouch for `vouchee`.
    ///         Convenience view for `ReportRegistry.rebut` ("only active vouchers of the target").
    function isActiveVoucher(address voucher, address vouchee) external view returns (bool) {
        Vouch storage v = vouches[voucher][vouchee];
        return v.issuedAt != 0 && !v.revoked && block.timestamp < v.expiresAt;
    }

    /// @notice Applies the -1-slot/30-day penalty from an UPHELD report (docs/12-reporting.md §6)
    ///         to `vouchers`. Restricted to `reportRegistry`. Same reverse-index reasoning as
    ///         `confirmFraud`'s `vouchees` parameter: the *full* set of a target's vouchers
    ///         (including the silent majority who did not rebut) is supplied by the caller rather
    ///         than enumerated on-chain.
    function applyReportPenalty(address[] calldata vouchers) external onlyReportRegistry {
        uint64 until_ = uint64(block.timestamp) + REPORT_SLOT_PENALTY;
        for (uint256 i; i < vouchers.length; ++i) {
            Member storage v = members[vouchers[i]];
            v.slotPenaltyUntil = until_;
            v.slotPenaltyCount += 1;
            emit SlotPenaltyApplied(vouchers[i], until_);
        }
    }

    // ─── 3.6 fraud ───────────────────────────────────────────────────────────
    /// @notice Confirms `account` as fraudulent: penalises its inbound vouchers' slots for 30 days,
    ///         zeroes its tenure (if `PresenceDrip` is wired), and **voids its own outbound vouches**
    ///         (FR-7).
    /// @param vouchers Accounts that vouched *for* `account` — penalised per the existing rule.
    /// @param vouchees Accounts `account` itself vouched *for* — voided here. The registry keeps no
    ///        reverse index by design ("the contract stores facts", docs/02-contracts.md §1), so this
    ///        is a governor-supplied list drawn from the Subgraph, which does index the full edge
    ///        set. Each entry is checked against on-chain state before being touched, so a caller
    ///        cannot fabricate a voided-edge event for a pair that was never actually a live vouch.
    function confirmFraud(address account, address[] calldata vouchers, address[] calldata vouchees, bytes32 reason)
        external
        onlyGovernor
    {
        members[account].fraudulent = true;
        emit FraudConfirmed(account, uint64(block.timestamp), reason);
        uint64 until_ = uint64(block.timestamp) + FRAUD_SLOT_PENALTY;
        for (uint256 i; i < vouchers.length; ++i) {
            Member storage v = members[vouchers[i]];
            v.slotPenaltyUntil = until_;
            v.slotPenaltyCount += 1;
            emit SlotPenaltyApplied(vouchers[i], until_);
        }
        if (presenceDrip != address(0)) {
            IPresenceDripZero(presenceDrip).zeroTenure(account);
        }

        // Void `account`'s own outbound vouches (docs/12-reporting.md §7 "outbound voided";
        // docs/01-trust-math.md §17 case 2, distinct from case 3 "merely reported"). Guarded exactly
        // like `sweep`: an entry that was never a live (issued, unrevoked) vouch is silently skipped
        // rather than reverting the whole batch, so a caller passing a stale or wrong address cannot
        // grief the rest of the list, and it cannot fabricate a voided-edge event out of nothing.
        Member storage acct = members[account];
        for (uint256 i; i < vouchees.length; ++i) {
            Vouch storage v = vouches[account][vouchees[i]];
            if (v.issuedAt != 0 && !v.revoked) {
                v.revoked = true;
                if (acct.activeOutbound > 0) acct.activeOutbound -= 1;
                emit OutboundVouchVoided(account, vouchees[i], uint64(block.timestamp));
            }
        }
    }

    // ─── internal: slots ─────────────────────────────────────────────────────
    function _slotsAvailable(address a, uint8 tier) internal view returns (uint32) {
        uint32 base = tier == 2 ? SLOTS_TIER2 : tier == 1 ? SLOTS_TIER1 : 0;
        Member storage m = members[a];
        uint32 penalty = block.timestamp < m.slotPenaltyUntil ? m.slotPenaltyCount : 0;
        uint32 capacity = base > penalty ? base - penalty : 0;
        return capacity > m.activeOutbound ? capacity - m.activeOutbound : 0;
    }

    function _suspended(address a) internal view returns (bool) {
        Member storage m = members[a];
        if (!m.enrolled) return true;
        return block.timestamp > uint256(m.credentialExpiresAt) + GRACE_PERIOD;
    }

    function _dead(Vouch storage v) internal view returns (bool) {
        return v.revoked || block.timestamp >= v.expiresAt;
    }

    // ─── internal: EIP-712 attestation ──────────────────────────────────────
    function _consumeAttestation(bytes32 structHash, uint64 deadline, bytes calldata sig) internal {
        if (block.timestamp > deadline) revert AttestationExpired();
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        if (usedAttestation[digest]) revert AttestationReplayed();
        address signer = _recover(digest, sig);
        if (signer == address(0) || !attestors[signer]) revert BadAttestation();
        usedAttestation[digest] = true;
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        // EIP-2 malleability guard: s must be in the lower half of the curve order.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return address(0);
        }
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
