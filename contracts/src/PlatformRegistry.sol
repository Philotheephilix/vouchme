// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VouchMeToken} from "./VouchMeToken.sol";

/// @dev Minimal local interface mirroring `VouchMeRegistry.isEnrolled`, used only for the dual-role
///      guard in `registerPlatform` (docs/02-contracts.md §0). Settable post-deploy
///      by governor — see `VouchMeRegistry.platformRegistry` for the matching reasoning in reverse.
interface IVouchMeRegistryCheck {
    function isEnrolled(address account) external view returns (bool);
}

/// @title PlatformRegistry
/// @notice "Humans add trust. Platforms only subtract it." (docs/13-platforms.md §1). A platform is
///         a first-class account with its own score, granted by humans who vouch for it, starting
///         at base 0 rather than a human's base 20. There is, by construction, **no function
///         anywhere in this contract that lets a platform vouch for a human** — that absence is a
///         spec requirement (docs/13-platforms.md §1, test P-3; docs/10-constants.md §10 "can vouch
///         humans: never — no such function"). Platforms live in an entirely separate contract from
///         `VouchMeRegistry`, so even if a platform address called `VouchMeRegistry.vouch`, it would
///         revert `NotEnrolled` — platforms never hold a `VouchMeRegistry.Member` record.
/// @dev Deviations from the doc's §8 "contract sketch" (which shows only storage + events, no
///      functions beyond the §2/§5 code blocks), documented inline with `NOTE(deviation)`:
///        1. The registration bond is custodied directly by this contract (its own `transferFrom`
///           + 14-day unbond timer) rather than routed through `CredibilityVault`. The vault's
///           lock/settle machinery is built around `ReportRegistry` claims; reusing it here would
///           require a third `onlyPlatformRegistry` lock path with none of the report/rebuttal
///           semantics it exists for. Keeping bond custody local keeps this contract independently
///           deployable and testable. A v2 could unify custody.
///        2. `ensName` resolution-to-caller and `voucherTier` are whole-graph / off-chain facts
///           (ENS resolution *could* be checked live via the ENS registry, but this repo stays
///           dependency-free beyond forge-std, so it is attested like everything else off-chain —
///           same EIP-712 + `attestors` pattern as `VouchMeRegistry`).
contract PlatformRegistry {
    // ─── types ──────────────────────────────────────────────────────────────
    struct Platform {
        string  ensName;
        bytes32 metadataURI;
        bytes32 policyURI;
        uint128 bond;
        uint64  registeredAt;
        uint32  openReports;   // reports currently open with this platform as the TARGET (P-8)
        bool    active;
    }

    struct PlatformVouch {
        uint64 issuedAt;
        uint64 expiresAt;      // issuedAt + 180d
        bool   revoked;
    }

    struct HumanActivity {
        uint32 activeOutbound;     // platform vouches issued by this human, incrementally maintained
        uint64 rateWindowStart;
        uint8  rateWindowCount;    // vouches issued within the current 24h window
    }

    // ─── constants (docs/10-constants.md §10, docs/13-platforms.md §2/§4) ──
    uint256 public constant MIN_REGISTRATION_BOND = 5_000e18;
    uint64  public constant UNBOND_DELAY          = 14 days;
    uint64  public constant PLATFORM_VOUCH_EXPIRY = 180 days;
    uint64  public constant VOUCH_RATE_WINDOW     = 24 hours;
    uint8   public constant VOUCH_RATE_LIMIT      = 3;
    uint32  public constant SLOTS_TIER1           = 5;
    uint32  public constant SLOTS_TIER2           = 20;
    uint256 public constant REPORT_LIMIT_PER_BOND = 1_000e18; // bond / 1000 => concurrent report cap
    uint32  public constant REPORT_LIMIT_MIN      = 1;
    uint32  public constant REPORT_LIMIT_MAX      = 50;

    // ─── EIP-712 ────────────────────────────────────────────────────────────
    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant REGISTER_TYPEHASH = keccak256(
        "RegisterAttestation(address platform,bytes32 ensNameHash,uint64 deadline,uint256 nonce)"
    );
    bytes32 public constant VOUCH_TYPEHASH = keccak256(
        "PlatformVouchAttestation(address human,address platform,uint8 voucherTier,uint64 deadline,uint256 nonce)"
    );
    bytes32 public immutable domainSeparator;

    // ─── storage ────────────────────────────────────────────────────────────
    VouchMeToken public immutable token;
    address   public governor;
    address   public treasury;
    address   public reportRegistry;
    /// @dev Dual-role guard counterpart: `registerPlatform` reverts if this address reports
    ///      the caller as an enrolled human. No-ops (permits registration) while unset.
    address   public vouchMeRegistry;

    mapping(address => Platform) public platforms;
    mapping(bytes32 => bool)     public scoreRequests;         // keccak(platform, subject) => queried
    mapping(address => mapping(address => PlatformVouch)) public platformVouches; // human => platform
    mapping(address => HumanActivity) public humanActivity;
    mapping(address => uint64)        public deregisterAt;     // 0 = not deregistering
    mapping(address => bool)          public attestors;
    mapping(bytes32 => bool)          public usedAttestation;

    // ─── events (docs/13-platforms.md §8, plus necessary additions) ─────────
    event PlatformRegistered(address indexed platform, string ensName, uint128 bond);
    event PlatformVouched(address indexed human, address indexed platform, uint64 expiresAt);
    event PlatformVouchRevoked(address indexed human, address indexed platform);
    event ScoreRequested(bytes32 indexed id, address indexed platform,
                         address indexed subject, bytes32 purposeHash, uint64 at);
    event PlatformBondSlashed(address indexed platform, uint128 amount, bytes32 reason);
    event PlatformDeregisterRequested(address indexed platform, uint64 withdrawableAt);
    event PlatformBondWithdrawn(address indexed platform, uint128 amount);
    event AttestorSet(address indexed attestor, bool enabled);
    event GovernorTransferred(address indexed previousGovernor, address indexed newGovernor);
    event TreasurySet(address indexed treasury);
    event ReportRegistrySet(address indexed reportRegistry);
    event VouchMeRegistrySet(address indexed vouchMeRegistry);

    // ─── errors ─────────────────────────────────────────────────────────────
    error NotGovernor(); error NotReportRegistry(); error ZeroAddress();
    error AlreadyRegistered(); error NotRegistered(); error InsufficientBond();
    error BadAttestation(); error AttestationExpired(); error AttestationReplayed();
    error NoSlots(); error RateLimited(); error VouchExists(); error NoSuchVouch();
    error InsufficientTier(); error OpenReportsExist(); error UnbondNotMatured();
    error NotDeregistering();
    /// @notice Dual-role guard: raised by `registerPlatform` when `msg.sender` is already
    ///         enrolled as a human in the wired `VouchMeRegistry`.
    error AlreadyEnrolledHuman();

    modifier onlyGovernor() {
        if (msg.sender != governor) revert NotGovernor();
        _;
    }

    modifier onlyReportRegistry() {
        if (msg.sender != reportRegistry) revert NotReportRegistry();
        _;
    }

    constructor(address _token, address _governor, address _treasury) {
        if (_token == address(0) || _governor == address(0) || _treasury == address(0)) revert ZeroAddress();
        token = VouchMeToken(_token);
        governor = _governor;
        treasury = _treasury;
        emit GovernorTransferred(address(0), _governor);
        emit TreasurySet(_treasury);
        domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("PlatformRegistry")),
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

    function setReportRegistry(address _reportRegistry) external onlyGovernor {
        reportRegistry = _reportRegistry;
        emit ReportRegistrySet(_reportRegistry);
    }

    /// @notice Wires the `VouchMeRegistry` address for the dual-role guard in `registerPlatform`
    ///         (docs/02-contracts.md §0). Governor-only, post-deploy, same reasoning as
    ///         `setReportRegistry`.
    function setVouchMeRegistry(address _vouchMeRegistry) external onlyGovernor {
        vouchMeRegistry = _vouchMeRegistry;
        emit VouchMeRegistrySet(_vouchMeRegistry);
    }

    function setTreasury(address _treasury) external onlyGovernor {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
        emit TreasurySet(_treasury);
    }

    function transferGovernor(address newGovernor) external onlyGovernor {
        if (newGovernor == address(0)) revert ZeroAddress();
        emit GovernorTransferred(governor, newGovernor);
        governor = newGovernor;
    }

    // ─── §2 registration ─────────────────────────────────────────────────────
    function registerPlatform(
        string calldata ensName,        // app.vouchme.eth — must resolve to the caller
        bytes32 metadataURI,            // description, contact, policy
        bytes32 policyURI,
        uint128 bond,                   // ≥ 5 000 VOUCHME
        uint64  deadline,
        uint256 nonce,
        bytes calldata attestation      // attests `ensName` resolves to msg.sender
    ) external {
        if (platforms[msg.sender].active) revert AlreadyRegistered();
        if (bond < MIN_REGISTRATION_BOND) revert InsufficientBond();
        // Dual-role guard: no-ops (permits registration) until governor wires `vouchMeRegistry`
        // post-deploy — same convention as `VouchMeRegistry.enroll`'s mirror-image check.
        if (vouchMeRegistry != address(0) && IVouchMeRegistryCheck(vouchMeRegistry).isEnrolled(msg.sender)) {
            revert AlreadyEnrolledHuman();
        }

        bytes32 structHash = keccak256(
            abi.encode(REGISTER_TYPEHASH, msg.sender, keccak256(bytes(ensName)), deadline, nonce)
        );
        _consumeAttestation(structHash, deadline, attestation);

        token.transferFrom(msg.sender, address(this), bond);
        platforms[msg.sender] = Platform({
            ensName: ensName,
            metadataURI: metadataURI,
            policyURI: policyURI,
            bond: bond,
            registeredAt: uint64(block.timestamp),
            openReports: 0,
            active: true
        });
        emit PlatformRegistered(msg.sender, ensName, bond);
    }

    function requestDeregister() external {
        Platform storage p = platforms[msg.sender];
        if (!p.active) revert NotRegistered();
        if (p.openReports > 0) revert OpenReportsExist();
        p.active = false;
        uint64 at = uint64(block.timestamp) + UNBOND_DELAY;
        deregisterAt[msg.sender] = at;
        emit PlatformDeregisterRequested(msg.sender, at);
    }

    function withdrawBond() external {
        uint64 at = deregisterAt[msg.sender];
        if (at == 0) revert NotDeregistering();
        if (block.timestamp < at) revert UnbondNotMatured();
        if (platforms[msg.sender].openReports > 0) revert OpenReportsExist();
        uint128 amount = platforms[msg.sender].bond;
        platforms[msg.sender].bond = 0;
        deregisterAt[msg.sender] = 0;
        if (amount != 0) token.transfer(msg.sender, amount);
        emit PlatformBondWithdrawn(msg.sender, amount);
    }

    function slashBond(address platform, uint128 amount, bytes32 reason) external onlyGovernor {
        Platform storage p = platforms[platform];
        if (amount > p.bond) amount = p.bond;
        p.bond -= amount;
        if (amount != 0) token.transfer(treasury, amount);
        emit PlatformBondSlashed(platform, amount, reason);
    }

    // ─── §4 platform vouching (separate slot pool — never the other direction) ──
    function vouchPlatform(
        address platform,
        uint8   voucherTier,       // asserted by attestor, same pattern as VouchMeRegistry.vouch
        uint64  deadline,
        uint256 nonce,
        bytes calldata attestation
    ) external {
        if (!platforms[platform].active) revert NotRegistered();
        if (voucherTier == 0) revert InsufficientTier();

        PlatformVouch storage v = platformVouches[msg.sender][platform];
        if (v.issuedAt != 0 && !_dead(v)) revert VouchExists();

        HumanActivity storage h = humanActivity[msg.sender];
        if (block.timestamp >= h.rateWindowStart + VOUCH_RATE_WINDOW) {
            h.rateWindowStart = uint64(block.timestamp);
            h.rateWindowCount = 0;
        }
        if (h.rateWindowCount >= VOUCH_RATE_LIMIT) revert RateLimited();

        uint32 base = voucherTier == 2 ? SLOTS_TIER2 : voucherTier == 1 ? SLOTS_TIER1 : 0;
        if (h.activeOutbound >= base) revert NoSlots();

        bytes32 structHash = keccak256(
            abi.encode(VOUCH_TYPEHASH, msg.sender, platform, voucherTier, deadline, nonce)
        );
        _consumeAttestation(structHash, deadline, attestation);

        uint64 exp = uint64(block.timestamp) + PLATFORM_VOUCH_EXPIRY;
        platformVouches[msg.sender][platform] = PlatformVouch(uint64(block.timestamp), exp, false);
        h.activeOutbound += 1;
        h.rateWindowCount += 1;
        emit PlatformVouched(msg.sender, platform, exp);
    }

    function revokePlatformVouch(address platform) external {
        PlatformVouch storage v = platformVouches[msg.sender][platform];
        if (v.issuedAt == 0 || v.revoked) revert NoSuchVouch();
        v.revoked = true;
        HumanActivity storage h = humanActivity[msg.sender];
        if (h.activeOutbound > 0) h.activeOutbound -= 1;
        emit PlatformVouchRevoked(msg.sender, platform);
    }

    // NOTE(deviation, intentional absence): there is deliberately no `vouchHuman`,
    // `platformVouchHuman`, or any function taking a human `vouchee` from a platform `msg.sender`
    // anywhere in this file. See `PlatformRegistry.t.sol` (P-3) for the compile-time assertion.

    // ─── §5 score requests / transparency log ───────────────────────────────
    function requestScore(address subject, bytes32 purposeHash) external returns (bytes32 requestId) {
        if (!platforms[msg.sender].active) revert NotRegistered();
        bytes32 key = keccak256(abi.encode(msg.sender, subject));
        scoreRequests[key] = true;
        requestId = keccak256(abi.encode(msg.sender, subject, purposeHash, block.timestamp, block.number));
        emit ScoreRequested(requestId, msg.sender, subject, purposeHash, uint64(block.timestamp));
    }

    function isRegistered(address platform) external view returns (bool) {
        return platforms[platform].active;
    }

    /// @notice `bond / 1000`, clamped to [1, 50] — the concurrent-open-report throughput a
    ///         platform's bond buys (docs/12-reporting.md §2.1). 0 if not an active platform.
    function reportLimitOf(address platform) external view returns (uint32) {
        Platform storage p = platforms[platform];
        if (!p.active) return 0;
        uint256 limit = uint256(p.bond) / REPORT_LIMIT_PER_BOND;
        if (limit < REPORT_LIMIT_MIN) limit = REPORT_LIMIT_MIN;
        if (limit > REPORT_LIMIT_MAX) limit = REPORT_LIMIT_MAX;
        return uint32(limit);
    }

    // ─── ReportRegistry hooks (P-8: bond withdrawal blocked while reported) ─
    function noteReportOpened(address platform) external onlyReportRegistry {
        if (platforms[platform].active || deregisterAt[platform] != 0) {
            platforms[platform].openReports += 1;
        }
    }

    function noteReportClosed(address platform) external onlyReportRegistry {
        if (platforms[platform].openReports > 0) platforms[platform].openReports -= 1;
    }

    // ─── internal ────────────────────────────────────────────────────────────
    function _dead(PlatformVouch storage v) internal view returns (bool) {
        return v.revoked || block.timestamp >= v.expiresAt;
    }

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
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return address(0);
        }
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
