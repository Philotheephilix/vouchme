// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VouchMeRegistry} from "./VouchMeRegistry.sol";
import {CredibilityVault} from "./CredibilityVault.sol";
import {PlatformRegistry} from "./PlatformRegistry.sol";

/// @dev Minimal local interface to avoid a circular concrete import with `PresenceDrip`. Used only
///      by the optional post-deploy accrual-pause hook on UPHELD.
interface IPresenceDripPause {
    function pauseAccrual(address account) external;
}

/// @title ReportRegistry
/// @notice Vouching creates standing; reporting removes it. See docs/12-reporting.md.
///         "The target's vouchers are the jury" — silence within the 72h challenge window is an
///         answer (UPHELD); enough rebuttal stake escalates to a 7-day arbitration panel.
/// @dev Deviations from the `contract sketch` in docs/12-reporting.md §5, each necessary to compile
///      and behave, documented inline with `NOTE(deviation)`:
///        1. `file` and the attestation-consuming path add a `nonce` parameter (same reasoning as
///           `VouchMeRegistry`: the EIP-712 struct needs an explicit nonce field, and the doc's
///           `weightPoints` — like `voucherTier` on a vouch — is a whole-graph fact the EVM cannot
///           compute, so it is attested and checked against an `attestors` allowlist here too).
///        2. Juror **selection** (VRF over Tier-2 accounts ≥2 hops from both parties) is a
///           whole-graph, off-chain computation with no on-chain source of truth for "who is Tier 2"
///           — the registry never stores tiers, by design (docs/02-contracts.md §1). `resolve()`
///           transitions PENDING → ARBITRATION on the on-chain-checkable rebuttal-stake condition
///           and emits `Escalated` with a placeholder all-zero panel; `assignJurors` (onlyGovernor,
///           the same "least decentralized surface, stated plainly" pattern as
///           `VouchMeRegistry.confirmFraud`) fills the panel once VRF selection runs off-chain. Juror
///           staking and the 20%-of-loser's-deposit panel payout are TODO — they need their own
///           bonding path in `CredibilityVault`, which the doc's vault sketch does not provide.
///        3. The "-1 slot / 30d" penalty on UPHELD applies to the on-chain-known rebutters
///           automatically; the *silent* majority of the target's vouchers (who did nothing) are
///           penalized via a governor-supplied list in `applySilentPenalty`, for the same
///           no-reverse-index reason as `CredibilityVault.slashInsurance`'s `insuredVouchers` list.
contract ReportRegistry {
    enum State { NONE, PENDING, ARBITRATION, UPHELD, UNPROVEN, MALICIOUS, WITHDRAWN }

    struct Report {
        address reporter;
        address target;
        bytes32 evidenceHash;     // IPFS CID hash; content off-chain
        uint32  weightPoints;     // snapshot of the reporter's weight at filing
        uint128 bond;
        uint64  filedAt;
        uint64  resolvedAt;
        uint128 rebuttalTotal;
        uint8   rebutterCount;
        State   state;
    }

    struct Arbitration {
        address[5] jurors;
        uint8 votesUphold;
        uint8 votesUnproven;
        uint8 votesMalicious;
        uint8 votesTotal;
    }

    // ─── constants (docs/10-constants.md §9) ────────────────────────────────
    uint64  public constant CHALLENGE_WINDOW    = 72 hours;
    uint64  public constant ARBITRATION_WINDOW  = 7 days;
    uint64  public constant SAME_PAIR_COOLDOWN  = 180 days;
    uint256 public constant BOND_PER_WEIGHT     = 10e18;    // 10 VOUCHME / weight point
    uint256 public constant WITHDRAW_BURN_BPS   = 1_000;    // 10%
    uint32  public constant HUMAN_CONCURRENT_CAP = 1;

    // ─── EIP-712 ────────────────────────────────────────────────────────────
    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant REPORT_TYPEHASH = keccak256(
        "ReportAttestation(address reporter,address target,uint32 weightPoints,uint64 deadline,uint256 nonce)"
    );
    bytes32 public immutable domainSeparator;

    // ─── storage ────────────────────────────────────────────────────────────
    VouchMeRegistry      public immutable vouchMeRegistry;
    CredibilityVault  public immutable vault;
    PlatformRegistry  public immutable platformRegistry;
    address public governor;
    /// @dev Post-deploy governor setter — see the `IPresenceDripPause` doc comment above.
    address public presenceDrip;

    mapping(bytes32 => Report)       public reports;
    mapping(bytes32 => Arbitration)  internal _arbitrations;
    /// @notice reportId => juror => already voted. Enforces one vote per assigned juror.
    mapping(bytes32 => mapping(address => bool)) public hasVoted;
    mapping(bytes32 => mapping(address => uint128)) public rebuttalOf; // reportId => rebutter => stake
    mapping(bytes32 => address[])    public rebuttersOf;               // reportId => rebutter list
    mapping(address => uint32)       public openReportCount;           // reporter => open reports
    mapping(bytes32 => uint64)       public lastReportAt;              // keccak(reporter,target) => filedAt
    mapping(address => bool)         public attestors;
    mapping(bytes32 => bool)         public usedAttestation;
    /// @notice MALICIOUS verdict voids every other open/future report from that reporter
    ///         (docs/12-reporting.md §3.2, R-6).
    mapping(address => bool)         public voided;
    uint256 public reportCount;

    // ─── events (exactly as docs/12-reporting.md §5) ────────────────────────
    event ReportFiled(bytes32 indexed id, address indexed reporter, address indexed target,
                      uint32 weightPoints, uint128 bond, bytes32 evidenceHash);
    event Rebutted(bytes32 indexed id, address indexed voucher, uint128 stake);
    event Escalated(bytes32 indexed id, address[5] jurors);
    event Resolved(bytes32 indexed id, State outcome, uint64 at);
    event ReportDecayed(bytes32 indexed id, uint32 remainingPoints);   // keeper, for the Subgraph
    event JurorsAssigned(bytes32 indexed id, address[5] jurors);
    event JuryVoted(bytes32 indexed id, address indexed juror, bool uphold, bool malicious);
    event ReporterVoided(address indexed reporter, bytes32 indexed maliciousReportId);
    event AttestorSet(address indexed attestor, bool enabled);
    event GovernorTransferred(address indexed previousGovernor, address indexed newGovernor);

    // ─── errors ─────────────────────────────────────────────────────────────
    error NotGovernor(); error ZeroAddress(); error ZeroAmount();
    error BadAttestation(); error AttestationExpired(); error AttestationReplayed();
    error NotEnrolledHuman(); error ReporterVoidedErr(); error TooManyOpenReports();
    error CooldownActive(); error NoScoreRequest(); error ZeroWeight();
    error NotPending(); error NotArbitration(); error ChallengeWindowClosed();
    error ChallengeWindowOpen(); error NotActiveVoucher(); error NotReporter();
    error EscalationNotMet(); error NotJuror(); error AlreadyVoted();

    modifier onlyGovernor() {
        if (msg.sender != governor) revert NotGovernor();
        _;
    }

    constructor(address _vouchMeRegistry, address _vault, address _platformRegistry, address _governor) {
        if (_vouchMeRegistry == address(0) || _vault == address(0) || _platformRegistry == address(0) || _governor == address(0)) {
            revert ZeroAddress();
        }
        vouchMeRegistry = VouchMeRegistry(_vouchMeRegistry);
        vault = CredibilityVault(_vault);
        platformRegistry = PlatformRegistry(_platformRegistry);
        governor = _governor;
        emit GovernorTransferred(address(0), _governor);
        domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("ReportRegistry")),
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

    function setPresenceDrip(address _presenceDrip) external onlyGovernor {
        presenceDrip = _presenceDrip;
    }

    // ─── file ───────────────────────────────────────────────────────────────
    function file(
        address target,
        bytes32 evidenceHash,
        uint32  weightPoints,
        uint64  deadline,
        uint256 nonce,
        bytes calldata attestation
    ) external returns (bytes32 id) {
        if (voided[msg.sender]) revert ReporterVoidedErr();
        if (weightPoints == 0) revert ZeroWeight();

        bool isPlatform = platformRegistry.isRegistered(msg.sender);
        if (isPlatform) {
            bytes32 reqKey = keccak256(abi.encode(msg.sender, target));
            if (!platformRegistry.scoreRequests(reqKey)) revert NoScoreRequest();
        } else {
            (, , , , , , bool enrolled, ) = vouchMeRegistry.members(msg.sender);
            if (!enrolled) revert NotEnrolledHuman();
        }

        uint32 limit = isPlatform ? platformRegistry.reportLimitOf(msg.sender) : HUMAN_CONCURRENT_CAP;
        if (openReportCount[msg.sender] >= limit) revert TooManyOpenReports();

        bytes32 pairKey = keccak256(abi.encode(msg.sender, target));
        if (lastReportAt[pairKey] != 0 && block.timestamp < lastReportAt[pairKey] + SAME_PAIR_COOLDOWN) {
            revert CooldownActive();
        }

        // weightPoints (and, implicitly, reporter-tier + graph-connection eligibility, both
        // whole-graph facts) are attested exactly like `voucherTier` on a vouch — see
        // docs/12-reporting.md §5: "weight is a whole-graph property the EVM should not compute."
        bytes32 structHash = keccak256(
            abi.encode(REPORT_TYPEHASH, msg.sender, target, weightPoints, deadline, nonce)
        );
        _consumeAttestation(structHash, deadline, attestation);

        id = keccak256(abi.encode(address(this), reportCount));
        reportCount += 1;
        uint128 bondAmount = uint128(uint256(weightPoints) * BOND_PER_WEIGHT);

        reports[id] = Report({
            reporter: msg.sender,
            target: target,
            evidenceHash: evidenceHash,
            weightPoints: weightPoints,
            bond: bondAmount,
            filedAt: uint64(block.timestamp),
            resolvedAt: 0,
            rebuttalTotal: 0,
            rebutterCount: 0,
            state: State.PENDING
        });
        openReportCount[msg.sender] += 1;
        lastReportAt[pairKey] = uint64(block.timestamp);

        vault.lockForReport(id, msg.sender, bondAmount);
        if (platformRegistry.isRegistered(target)) platformRegistry.noteReportOpened(target);

        emit ReportFiled(id, msg.sender, target, weightPoints, bondAmount, evidenceHash);
    }

    // ─── rebut ──────────────────────────────────────────────────────────────
    /// @notice Only an active (unrevoked, unexpired) voucher of the target may rebut.
    function rebut(bytes32 id, uint128 stake) external {
        Report storage r = reports[id];
        if (r.state != State.PENDING) revert NotPending();
        if (block.timestamp >= r.filedAt + CHALLENGE_WINDOW) revert ChallengeWindowClosed();
        if (!vouchMeRegistry.isActiveVoucher(msg.sender, r.target)) revert NotActiveVoucher();
        if (stake == 0) revert ZeroAmount();

        vault.lockForRebuttal(id, msg.sender, stake);
        if (rebuttalOf[id][msg.sender] == 0) rebuttersOf[id].push(msg.sender);
        rebuttalOf[id][msg.sender] += stake;
        r.rebuttalTotal += stake;
        r.rebutterCount += 1;

        emit Rebutted(id, msg.sender, stake);
    }

    // ─── withdrawReport ─────────────────────────────────────────────────────
    /// @notice 10% burn, only before the 72h challenge window closes (docs/12-reporting.md §4).
    function withdrawReport(bytes32 id) external {
        Report storage r = reports[id];
        if (r.reporter != msg.sender) revert NotReporter();
        if (r.state != State.PENDING) revert NotPending();
        if (block.timestamp >= r.filedAt + CHALLENGE_WINDOW) revert ChallengeWindowClosed();

        r.state = State.WITHDRAWN;
        r.resolvedAt = uint64(block.timestamp);
        openReportCount[msg.sender] -= 1;

        vault.settle(id, CredibilityVault.Outcome.WITHDRAWN, r.target);
        _noteReportClosedIfPlatform(r.target);
        emit Resolved(id, State.WITHDRAWN, uint64(block.timestamp));
    }

    // ─── resolve ────────────────────────────────────────────────────────────
    /// @notice Permissionless after 72h. Silence ⇒ UPHELD. Enough rebuttal ⇒ ARBITRATION.
    function resolve(bytes32 id) external {
        Report storage r = reports[id];
        if (r.state != State.PENDING) revert NotPending();
        if (block.timestamp < r.filedAt + CHALLENGE_WINDOW) revert ChallengeWindowOpen();

        bool escalates = r.rebuttalTotal >= r.bond && r.rebutterCount >= 2;
        if (escalates) {
            r.state = State.ARBITRATION;
            // NOTE(deviation): real juror selection is VRF-over-Tier-2-≥2-hops, computed off-chain;
            // see the contract-level docs. Placeholder empty panel until `assignJurors`.
            address[5] memory placeholder;
            emit Escalated(id, placeholder);
        } else {
            r.state = State.UPHELD;
            r.resolvedAt = uint64(block.timestamp);
            openReportCount[r.reporter] -= 1;
            _applyUpheldRebutterPenalties(id);
            vault.settle(id, CredibilityVault.Outcome.UPHELD, r.target);
            _noteReportClosedIfPlatform(r.target);
            _pauseAccrualIfWired(r.target);
            emit Resolved(id, State.UPHELD, uint64(block.timestamp));
        }
    }

    /// @notice Fills the jury panel once off-chain VRF selection has run. onlyGovernor in v1 —
    ///         the same centralization stated plainly for `VouchMeRegistry.confirmFraud`.
    function assignJurors(bytes32 id, address[5] calldata jurors) external onlyGovernor {
        Report storage r = reports[id];
        if (r.state != State.ARBITRATION) revert NotArbitration();
        _arbitrations[id].jurors = jurors;
        emit JurorsAssigned(id, jurors);
    }

    /// @notice One of the 5 assigned jurors casts a verdict vote. Majority of the 5 resolves the
    ///         report. Juror staking/slashing and the 20%-of-loser's-deposit panel payout
    ///         (docs/12-reporting.md §3.2) are TODO — they need a dedicated bonding path this
    ///         scaffold's `CredibilityVault` does not yet expose.
    function juryVote(bytes32 id, bool uphold, bool malicious) external {
        Report storage r = reports[id];
        if (r.state != State.ARBITRATION) revert NotArbitration();
        Arbitration storage a = _arbitrations[id];

        bool isJuror;
        for (uint256 i = 0; i < 5; ++i) {
            if (a.jurors[i] == msg.sender) { isJuror = true; break; }
        }
        if (!isJuror) revert NotJuror();
        if (hasVoted[id][msg.sender]) revert AlreadyVoted();
        hasVoted[id][msg.sender] = true;

        a.votesTotal += 1;
        if (malicious) {
            a.votesMalicious += 1;
        } else if (uphold) {
            a.votesUphold += 1;
        } else {
            a.votesUnproven += 1;
        }
        emit JuryVoted(id, msg.sender, uphold, malicious);

        if (a.votesTotal >= 3) {
            State outcome;
            CredibilityVault.Outcome vaultOutcome;
            if (a.votesMalicious >= a.votesUphold && a.votesMalicious >= a.votesUnproven) {
                outcome = State.MALICIOUS;
                vaultOutcome = CredibilityVault.Outcome.MALICIOUS;
                voided[r.reporter] = true;
                emit ReporterVoided(r.reporter, id);
            } else if (a.votesUphold >= a.votesUnproven) {
                outcome = State.UPHELD;
                vaultOutcome = CredibilityVault.Outcome.UPHELD;
                _applyUpheldRebutterPenalties(id);
                _pauseAccrualIfWired(r.target);
            } else {
                outcome = State.UNPROVEN;
                vaultOutcome = CredibilityVault.Outcome.UNPROVEN;
            }
            r.state = outcome;
            r.resolvedAt = uint64(block.timestamp);
            openReportCount[r.reporter] -= 1;
            vault.settle(id, vaultOutcome, r.target);
            _noteReportClosedIfPlatform(r.target);
            emit Resolved(id, outcome, uint64(block.timestamp));
        }
    }

    function _noteReportClosedIfPlatform(address target) internal {
        if (platformRegistry.isRegistered(target)) platformRegistry.noteReportClosed(target);
    }

    function _pauseAccrualIfWired(address target) internal {
        if (presenceDrip != address(0)) {
            IPresenceDripPause(presenceDrip).pauseAccrual(target);
        }
    }

    /// @notice Keeper/governor-supplied list of the target's vouchers who neither rebutted nor
    ///         revoked before an UPHELD resolution — "doing nothing costs the same as defending and
    ///         losing" (docs/12-reporting.md §6). The registry has no on-chain reverse index of a
    ///         target's vouchers (deliberately — "the contract stores facts", docs/02-contracts.md
    ///         §1), so this list is supplied the same way `VouchMeRegistry.confirmFraud`'s `vouchees`
    ///         and `CredibilityVault.slashInsurance`'s `insuredVouchers` are.
    function applySilentPenalty(bytes32 id, address[] calldata silentVouchers) external onlyGovernor {
        Report storage r = reports[id];
        if (r.state != State.UPHELD) revert NotPending();
        for (uint256 i = 0; i < silentVouchers.length; ++i) {
            if (rebuttalOf[id][silentVouchers[i]] != 0) continue; // already penalized as a rebutter
        }
        vouchMeRegistry.applyReportPenalty(silentVouchers);
    }

    function _applyUpheldRebutterPenalties(bytes32 id) internal {
        address[] storage rebutters = rebuttersOf[id];
        if (rebutters.length > 0) {
            vouchMeRegistry.applyReportPenalty(rebutters);
        }
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
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return address(0);
        }
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
