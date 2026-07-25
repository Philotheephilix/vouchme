// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AvalToken} from "./AvalToken.sol";
import {CredibilityVault} from "./CredibilityVault.sol";
import {AvalRegistry} from "./AvalRegistry.sol";

/// @title PresenceDrip
/// @notice "Claiming is how the protocol observes that you are still here." docs/16-presence-drip.md.
///         Lazy per-6h-epoch accrual, capped at 30 days unclaimed, feeding a hard-capped tenure
///         bonus that can never by itself promote anyone (`base + T_MAX = 15 < T1 = 30`, invariant
///         I-17).
/// @dev Deviations from the doc's §6 `contract sketch`, documented inline with `NOTE(deviation)`:
///        1. `claim()` / `claimAndBond()` gain `(tier, deadline, nonce, attestation)` parameters.
///           The doc's own rate table (§3) makes the *actual minted amount* depend on tier
///           (25% at Tier 0, 100% at Tier 1/2) — tier is a whole-graph fact the EVM cannot compute
///           (same reasoning as `voucherTier` on `AvalRegistry.vouch`, which the task brief calls
///           out by name as the pattern to follow), so it is attested and checked against
///           `attestors`, exactly like every other whole-graph fact in this repo.
///        2. `accrued(address)` stays parameterless and returns the *nominal*, tier-blind amount
///           (capped epochs × 0.25 AVAL) — it is the epoch-counting primitive `claim` builds on, not
///           the final payable amount. The tier discount is applied only where it can be attested,
///           inside `claim`/`claimAndBond`.
///        3. `tenureCenti` computes each band edge as `T_MAX_CENTI * (2^k - 1) / 2^k` (multiply
///           before dividing) rather than the doc's literal `T_MAX_CENTI - (T_MAX_CENTI >> k)`
///           (subtract a pre-truncated shift). The two are identical as real numbers but diverge
///           once integer-truncated: at k=3 the doc's text gives 438 (`500 - 500>>3` = `500-62`)
///           where the doc's own §4 table — and this file's test — say **437**; at k=4 it gives 469
///           vs the table's **468**. `500>>k` truncates *before* the subtraction, which is wrong by
///           one centi-point exactly where `500/2^k` has a fractional remainder (k≥3). Multiplying
///           first avoids the double-truncation and reproduces the doc's own table bit-for-bit.
///        4. `zeroTenure` / `pauseAccrual` are exposed for `AvalRegistry.confirmFraud` /
///           `ReportRegistry`'s UPHELD path to call, but those two contracts only hold this
///           contract's address via a post-deploy governor setter (constructor-time circular
///           dependency: this contract needs `AvalRegistry`'s and `CredibilityVault`'s addresses, so
///           neither of *them* can also require this one's address at construction). Both setters
///           (`AvalRegistry.setPresenceDrip`, `ReportRegistry.setPresenceDrip`) already exist and are
///           exercised by the deploy flow in `script/Deploy.s.sol`, which performs the full post-
///           deploy wiring dance (this contract, plus the `AvalRegistry` <-> `PlatformRegistry`
///           dual-role cross-reference from docs/02-contracts.md §0) in the one place deployment
///           order allows it.
contract PresenceDrip {
    struct Presence {
        uint64 lastClaimAt;
        uint64 epochsClaimed;     // monotone (except on confirmed fraud); feeds tenure
        uint64 accrualPausedUntil;
    }
    mapping(address => Presence) public presence;

    // ─── constants (docs/16-presence-drip.md §2, §4, §6) ────────────────────
    uint64  public constant EPOCH          = 6 hours;
    uint64  public constant MAX_UNCLAIMED  = 120;      // 30 days, in epochs
    uint64  public constant E_HALF         = 720;      // 180 days, in epochs
    uint32  public constant T_MAX_CENTI    = 500;      // 5.00 points
    uint256 public constant DRIP_NOMINAL   = 0.25e18;  // AVAL per epoch = 1 AVAL/day at full rate
    uint256 public constant TIER0_RATE_BPS = 2_500;    // 25%
    uint256 public constant FULL_RATE_BPS  = 10_000;
    uint64  public constant REPORT_PAUSE   = 90 days;
    /// @dev Fast-path saturation band: beyond k=9, `500 >> k == 0` under any interpretation, and
    ///      under this file's multiply-first formula `500*(2^k-1)/2^k` floors to a constant 499 for
    ///      every k ≥ 9 (since `0 < 500/2^k < 1` throughout that range). Capping k avoids a `1 << k`
    ///      overflow for accounts with very large `epochsClaimed` while returning the exact same
    ///      answer the uncapped formula would.
    uint64  public constant SATURATION_K   = 9;

    // ─── EIP-712 ────────────────────────────────────────────────────────────
    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant TIER_TYPEHASH = keccak256(
        "TierAttestation(address account,uint8 tier,uint64 deadline,uint256 nonce)"
    );
    bytes32 public immutable domainSeparator;

    // ─── storage ────────────────────────────────────────────────────────────
    AvalToken        public immutable token;
    CredibilityVault public immutable vault;
    AvalRegistry     public immutable avalRegistry;
    address public governor;
    address public reportRegistry; // authorized to call `pauseAccrual`
    mapping(address => bool) public attestors;
    mapping(bytes32 => bool) public usedAttestation;

    // ─── events (docs/16-presence-drip.md §6, plus necessary additions) ─────
    event Claimed(address indexed account, uint256 amount, uint64 epochs, uint64 totalEpochs);
    event TenureZeroed(address indexed account, bytes32 reason);
    event DripRateChanged(uint256 poolPerEpoch, uint32 activeClaimants);
    event AccrualPaused(address indexed account, uint64 until);
    event AttestorSet(address indexed attestor, bool enabled);
    event GovernorTransferred(address indexed previousGovernor, address indexed newGovernor);
    event ReportRegistrySet(address indexed reportRegistry);

    // ─── errors ─────────────────────────────────────────────────────────────
    error NotGovernor(); error NotReportRegistry(); error ZeroAddress();
    error NotEnrolled(); error NothingToClaim();
    error BadAttestation(); error AttestationExpired(); error AttestationReplayed();

    modifier onlyGovernor() {
        if (msg.sender != governor) revert NotGovernor();
        _;
    }

    modifier onlyReportRegistry() {
        if (msg.sender != reportRegistry) revert NotReportRegistry();
        _;
    }

    constructor(address _token, address _vault, address _avalRegistry, address _governor) {
        if (_token == address(0) || _vault == address(0) || _avalRegistry == address(0) || _governor == address(0)) {
            revert ZeroAddress();
        }
        token = AvalToken(_token);
        vault = CredibilityVault(_vault);
        avalRegistry = AvalRegistry(_avalRegistry);
        governor = _governor;
        emit GovernorTransferred(address(0), _governor);
        domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("PresenceDrip")),
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

    function transferGovernor(address newGovernor) external onlyGovernor {
        if (newGovernor == address(0)) revert ZeroAddress();
        emit GovernorTransferred(governor, newGovernor);
        governor = newGovernor;
    }

    // ─── §2 accrual (nominal, tier-blind — see NOTE(deviation) 2) ───────────
    function accrued(address a) public view returns (uint256) {
        uint64 e = _epochsSinceLastTouch(a);
        return uint256(e) * DRIP_NOMINAL;
    }

    function _startTime(address a) internal view returns (uint64) {
        uint64 last = presence[a].lastClaimAt;
        if (last != 0) return last;
        (uint64 enrolledAt,,,,,,,) = avalRegistry.members(a);
        return enrolledAt;
    }

    function _epochsSinceLastTouch(address a) internal view returns (uint64) {
        uint64 start = _startTime(a);
        if (start == 0 || block.timestamp <= start) return 0;
        uint64 e = uint64((block.timestamp - start) / EPOCH);
        if (e > MAX_UNCLAIMED) e = MAX_UNCLAIMED;   // ← the presence requirement
        return e;
    }

    function _effectiveRateBps(address account, uint8 tier) internal view returns (uint256) {
        if (avalRegistry.isSuspended(account)) return 0;
        if (block.timestamp < presence[account].accrualPausedUntil) return 0;
        return tier == 0 ? TIER0_RATE_BPS : FULL_RATE_BPS;
    }

    // ─── §2 claim ────────────────────────────────────────────────────────────
    function claim(uint8 tier, uint64 deadline, uint256 nonce, bytes calldata attestation) external {
        _claim(msg.sender, tier, deadline, nonce, attestation, false);
    }

    /// @notice Claims straight into the `CredibilityVault`, never touching a wallet — "the defence
    ///         path never leaves the app" (docs/16-presence-drip.md §2.2).
    function claimAndBond(uint8 tier, uint64 deadline, uint256 nonce, bytes calldata attestation) external {
        _claim(msg.sender, tier, deadline, nonce, attestation, true);
    }

    function _claim(
        address account,
        uint8   tier,
        uint64  deadline,
        uint256 nonce,
        bytes calldata attestation,
        bool toBond
    ) internal {
        uint64 start = _startTime(account);
        if (start == 0) revert NotEnrolled();

        bytes32 structHash = keccak256(abi.encode(TIER_TYPEHASH, account, tier, deadline, nonce));
        _consumeAttestation(structHash, deadline, attestation);

        uint64 e = _epochsSinceLastTouch(account);
        if (e == 0) revert NothingToClaim();

        uint256 rateBps = _effectiveRateBps(account, tier);
        uint256 amount = (uint256(e) * DRIP_NOMINAL * rateBps) / FULL_RATE_BPS;

        Presence storage p = presence[account];
        p.lastClaimAt = uint64(block.timestamp);
        if (tier >= 1) {
            p.epochsClaimed += e;   // Tier 0 gains zero tenure epochs (D-2)
        }

        if (amount != 0) {
            if (toBond) {
                token.mint(address(this), amount);
                token.approve(address(vault), amount);
                vault.bondFor(account, uint128(amount));
            } else {
                token.mint(account, amount);
            }
        }

        emit Claimed(account, amount, e, p.epochsClaimed);
    }

    // ─── §4 tenure ───────────────────────────────────────────────────────────
    function tenureCenti(address a) public view returns (uint32) {
        return _tenureCentiFromEpochs(presence[a].epochsClaimed);
    }

    function _tenureCentiFromEpochs(uint64 E) internal pure returns (uint32) {
        uint64 k = E / E_HALF;
        uint64 r = E % E_HALF;
        uint64 kc = k > SATURATION_K ? SATURATION_K : k;
        uint256 pow = uint256(1) << kc;
        uint256 lo = (uint256(T_MAX_CENTI) * (pow - 1)) / pow;
        if (k >= SATURATION_K) {
            return uint32(lo);
        }
        uint256 powNext = pow << 1;
        uint256 hi = (uint256(T_MAX_CENTI) * (powNext - 1)) / powNext;
        uint256 centi = lo + ((hi - lo) * r) / E_HALF;
        return uint32(centi);
    }

    // ─── report / fraud hooks ────────────────────────────────────────────────
    /// @notice Upheld report ⇒ accrual pauses 90 days; existing tenure is retained, the clock stops
    ///         (docs/16-presence-drip.md §4.3).
    function pauseAccrual(address account) external onlyReportRegistry {
        uint64 until_ = uint64(block.timestamp) + REPORT_PAUSE;
        presence[account].accrualPausedUntil = until_;
        emit AccrualPaused(account, until_);
    }

    /// @notice The one irreversible tenure penalty: confirmed fraud zeroes `epochsClaimed`.
    ///         Restricted to `avalRegistry` itself so only `AvalRegistry.confirmFraud` can trigger
    ///         it. `AvalRegistry.presenceDrip` must be wired (governor `setPresenceDrip`, done in
    ///         `script/Deploy.s.sol`'s post-deploy step) for `confirmFraud` to actually call this —
    ///         it no-ops the hook while unset, same convention as every other post-deploy address.
    function zeroTenure(address account) external {
        if (msg.sender != address(avalRegistry)) revert NotGovernor();
        presence[account].epochsClaimed = 0;
        emit TenureZeroed(account, keccak256("confirmed-fraud"));
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
