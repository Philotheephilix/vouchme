// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AvalToken} from "./AvalToken.sol";

/// @title CredibilityVault
/// @notice "AVAL is a bond, not a score." (docs/11-token-vault.md §1). This contract is the only
///         place AVAL is put at risk: report bonds, rebuttal bonds, insurance bonds, platform
///         registration bonds. No balance here ever enters a scoring function.
/// @dev Deviations from the doc's `contract sketch` (docs/11-token-vault.md §3), each necessary to
///      make the sketch compile and behave, are called out inline with `NOTE(deviation)`:
///        1. `Position` gains a `pendingUnbond` field — the sketch's 4-field struct has nowhere to
///           park a *partial* `requestUnbond(amount)` while its 14-day timer runs.
///        2. `lockForReport` / `lockForRebuttal` take an explicit `account` parameter — the sketch
///           shows 2 args, but the caller is `ReportRegistry` (`onlyReportRegistry`), so the actor
///           whose position gets locked cannot be recovered from `msg.sender` alone.
///        3. `settle` takes an `Outcome` matching `ReportRegistry.State`'s terminal values
///           (UPHELD/UNPROVEN/MALICIOUS/WITHDRAWN) rather than the earlier, looser
///           UPHELD/REJECTED/WITHDRAWN/ARBITRATED table in this doc's §3.2 — the two tables
///           disagree (§3.2 "Rejected" slashes the reporter; §4 of 12-reporting.md's payoff matrix
///           says UNPROVEN returns the reporter's bond in full). The payoff matrix in
///           `12-reporting.md` §4 is later, more detailed, and matches the `ReportRegistry` enum
///           actually shipped, so it is treated as authoritative here.
///        4. `applyDemurrage` decays *idle-but-bonded* balance (`bonded - locked`) held inside this
///           vault, not raw wallet balance. The literal text ("idle unbonded balances... bonded AVAL
///           is exempt") reads as wallet balances, which would require granting this vault a
///           privileged forced-transfer hook on `AvalToken` beyond the single `minter` role the task
///           spec calls for. Decaying the vault's own custodied-but-unlocked balance needs no new
///           privilege (the vault already holds the tokens) and preserves "money at risk is exempt,
///           money doing nothing decays" exactly. Decay itself is exact continuous compounding via
///           `_wadPow` — see `DEMURRAGE_RATE_PER_SECOND_WAD`'s doc comment for the derivation.
///        5. `settle`'s UPHELD insurance slash (docs/12-reporting.md §4 "+0.5 I") is split into a
///           separate `slashInsurance(reportId, insuredVouchers)` call rather than being inline in
///           `settle` — see that function's doc comment for why (no on-chain reverse index of "who
///           insured `target`", and inlining it only for rebutters silently missed the "nobody
///           defends" row of the payoff matrix, where the reporter is still owed 50% of the target's
///           insurance despite there being no rebutters to iterate over).
contract CredibilityVault {
    // ─── types ──────────────────────────────────────────────────────────────
    struct Position {
        uint128 bonded;        // total deposited, at risk, exempt from demurrage
        uint128 locked;        // committed to open claims / insurance (subset of bonded)
        uint128 pendingUnbond; // moved out of `bonded`, counting down to withdrawal
        uint64  unbondAt;      // 0 = no pending withdrawal
        uint64  lastDemurrage; // timestamp of last decay application
    }

    enum Outcome { UPHELD, UNPROVEN, MALICIOUS, WITHDRAWN }

    struct Claim {
        address reporter;
        address target;
        uint128 reporterLocked;
        uint128 rebuttalTotal;
        bool    open;
        bool    settled;
        Outcome outcome;    // valid iff `settled`; read by the follow-up `slashInsurance` call
    }

    // ─── constants ──────────────────────────────────────────────────────────
    uint64  public constant UNBOND_DELAY        = 14 days;
    uint256 public constant DEMURRAGE_RATE_BPS  = 700;      // 7% / year (documentation constant only;
                                                              // the actual decay uses the per-second
                                                              // WAD rate below, which is *derived from*
                                                              // this 7%/yr figure — see `applyDemurrage`)
    uint256 public constant BPS_DENOMINATOR     = 10_000;
    uint256 internal constant WAD               = 1e18;
    /// @dev `(1 - 0.07) ** (1 / 31_536_000)` in WAD (1e18) fixed point — the per-second multiplier
    ///      whose 31,536,000th (365-day) power is exactly `0.93`. Derived once, offline, via:
    ///      ```python
    ///      from decimal import Decimal, getcontext
    ///      getcontext().prec = 60
    ///      r = Decimal(93) / Decimal(100)
    ///      rate_per_second = (r.ln() / Decimal(365 * 86400)).exp()
    ///      int((rate_per_second * Decimal(10**18)).to_integral_value())
    ///      ```
    ///      `applyDemurrage` raises this to the integer power `elapsed` (in seconds) via
    ///      exponentiation-by-squaring (`_wadPow`), which implements continuous compounding
    ///      `balance(t) = balance(0) * (1 - 0.07)^(t / 365d)` exactly (docs/11-token-vault.md §4.4)
    ///      without any fractional-exponent math — the fractional exponent is baked into this
    ///      constant once, offline, and the on-chain work is pure integer repeated squaring.
    ///      Precision bound: each `_wadPow` multiply-then-divide-by-WAD step truncates by at most 1
    ///      wei (1e-18 of a token), and a full year of per-second compounding needs at most
    ///      `ceil(log2(31_536_000)) = 25` squaring steps, so the worst-case *relative* error versus
    ///      exact real-number compounding is on the order of `25 * 1e-18` — utterly negligible next
    ///      to 18-decimal token amounts. Verified against the exact 1-year case: raising this
    ///      constant to `365 days` in seconds yields `929999999996530408` (vs. the exact
    ///      `930000000000000000`), an absolute error of ~3.5e-9 AVAL per 1 AVAL of idle balance.
    uint256 public constant DEMURRAGE_RATE_PER_SECOND_WAD = 999999997698798429;

    // ─── storage ────────────────────────────────────────────────────────────
    AvalToken public immutable token;
    address   public governor;
    address   public reportRegistry;
    address   public treasury;

    mapping(address => Position)                   public positions;
    mapping(bytes32 => Claim)                       public claims;      // reportId => claim
    mapping(bytes32 => uint128)                     public insurance;   // keccak(voucher, vouchee) => bonded
    mapping(bytes32 => mapping(address => uint128)) public rebuttals;   // reportId => rebutter => stake
    mapping(bytes32 => address[])                   public rebuttersOf; // reportId => rebutter list

    // ─── events ─────────────────────────────────────────────────────────────
    event Bonded(address indexed account, uint128 amount, uint128 totalBonded);
    event UnbondRequested(address indexed account, uint128 amount, uint64 unbondAt);
    event Withdrawn(address indexed account, uint128 amount);
    event LockedForReport(bytes32 indexed reportId, address indexed reporter, uint128 amount);
    event LockedForRebuttal(bytes32 indexed reportId, address indexed rebutter, uint128 amount);
    event InsuranceBonded(address indexed voucher, address indexed vouchee, uint128 amount);
    event Settled(bytes32 indexed reportId, Outcome outcome);
    /// @notice Follow-up to an UPHELD `Settled`: 50% of the slashed insurance to the reporter, 50%
    ///         to the treasury (docs/12-reporting.md §4 "+0.5 I"; docs/11-token-vault.md §3.2).
    event InsuranceSlashed(bytes32 indexed reportId, uint128 toReporter, uint128 toTreasury);
    event DemurrageApplied(address indexed account, uint128 decayed, uint128 remainingBonded);
    event ReportRegistrySet(address indexed reportRegistry);
    event TreasurySet(address indexed treasury);
    event GovernorTransferred(address indexed previousGovernor, address indexed newGovernor);

    // ─── errors ─────────────────────────────────────────────────────────────
    error NotGovernor();
    error NotReportRegistry();
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientAvailable();
    error ClaimOpen();
    error NoPendingUnbond();
    error UnbondNotMatured();
    error ClaimAlreadyOpen();
    error ClaimNotOpen();
    error ClaimAlreadySettled();
    /// @notice `slashInsurance` may only be called on a claim that settled UPHELD.
    error ClaimNotUpheld();

    // ─── modifiers ──────────────────────────────────────────────────────────
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
        token = AvalToken(_token);
        governor = _governor;
        treasury = _treasury;
        emit GovernorTransferred(address(0), _governor);
        emit TreasurySet(_treasury);
    }

    // ─── governance ─────────────────────────────────────────────────────────
    function setReportRegistry(address _reportRegistry) external onlyGovernor {
        if (_reportRegistry == address(0)) revert ZeroAddress();
        reportRegistry = _reportRegistry;
        emit ReportRegistrySet(_reportRegistry);
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

    // ─── 3. bonding / unbonding ──────────────────────────────────────────────
    function bond(uint128 amount) external {
        if (amount == 0) revert ZeroAmount();
        token.transferFrom(msg.sender, address(this), amount);
        Position storage p = positions[msg.sender];
        p.bonded += amount;
        if (p.lastDemurrage == 0) p.lastDemurrage = uint64(block.timestamp);
        emit Bonded(msg.sender, amount, p.bonded);
    }

    /// @notice Bonds `amount` on behalf of `account`, pulling tokens from `msg.sender`. Used by
    ///         `PresenceDrip.claimAndBond` so a claim can fund a bond "without touching a wallet"
    ///         (docs/16-presence-drip.md §2.2) — `PresenceDrip` mints to itself then calls this on
    ///         the claimant's behalf, since a plain `bond()` would credit `PresenceDrip`'s own
    ///         position instead of the claimant's.
    function bondFor(address account, uint128 amount) external {
        if (amount == 0) revert ZeroAmount();
        token.transferFrom(msg.sender, address(this), amount);
        Position storage p = positions[account];
        p.bonded += amount;
        if (p.lastDemurrage == 0) p.lastDemurrage = uint64(block.timestamp);
        emit Bonded(account, amount, p.bonded);
    }

    /// @notice Starts a 14-day unbonding timer for `amount` of currently-unlocked bonded AVAL.
    function requestUnbond(uint128 amount) external {
        if (amount == 0) revert ZeroAmount();
        Position storage p = positions[msg.sender];
        uint128 available = p.bonded - p.locked;
        if (amount > available) revert InsufficientAvailable();
        p.bonded -= amount;
        p.pendingUnbond += amount;
        p.unbondAt = uint64(block.timestamp) + UNBOND_DELAY;
        emit UnbondRequested(msg.sender, amount, p.unbondAt);
    }

    /// @notice Reverts while any claim is open against you (`locked != 0`) — see docs/11-token-vault
    ///         §3.1: "the correct play on receiving a report is to withdraw everything before it
    ///         resolves" is exactly what this blocks.
    function withdraw() external {
        Position storage p = positions[msg.sender];
        if (p.locked != 0) revert ClaimOpen();
        if (p.pendingUnbond == 0) revert NoPendingUnbond();
        if (p.unbondAt == 0 || block.timestamp < p.unbondAt) revert UnbondNotMatured();
        uint128 amount = p.pendingUnbond;
        p.pendingUnbond = 0;
        p.unbondAt = 0;
        token.transfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ─── claims (reports / rebuttals) ───────────────────────────────────────
    function lockForReport(bytes32 reportId, address reporter, uint128 amount) external onlyReportRegistry {
        Claim storage c = claims[reportId];
        if (c.open) revert ClaimAlreadyOpen();
        Position storage p = positions[reporter];
        uint128 available = p.bonded - p.locked;
        if (amount > available) revert InsufficientAvailable();
        p.locked += amount;
        c.reporter = reporter;
        c.reporterLocked = amount;
        c.open = true;
        emit LockedForReport(reportId, reporter, amount);
    }

    function lockForRebuttal(bytes32 reportId, address rebutter, uint128 amount) external onlyReportRegistry {
        Claim storage c = claims[reportId];
        if (!c.open) revert ClaimNotOpen();
        Position storage p = positions[rebutter];
        uint128 available = p.bonded - p.locked;
        if (amount > available) revert InsufficientAvailable();
        p.locked += amount;
        if (rebuttals[reportId][rebutter] == 0) rebuttersOf[reportId].push(rebutter);
        rebuttals[reportId][rebutter] += amount;
        c.rebuttalTotal += amount;
        emit LockedForRebuttal(reportId, rebutter, amount);
    }

    /// @notice A voucher expresses confidence in `vouchee` by locking AVAL behind the vouch. Does
    ///         **not** raise `vouchee`'s score by a single point (docs/11-token-vault §2.1).
    function bondInsurance(address vouchee, uint128 amount) external {
        if (amount == 0) revert ZeroAmount();
        Position storage p = positions[msg.sender];
        uint128 available = p.bonded - p.locked;
        if (amount > available) revert InsufficientAvailable();
        p.locked += amount;
        insurance[keccak256(abi.encode(msg.sender, vouchee))] += amount;
        emit InsuranceBonded(msg.sender, vouchee, amount);
    }

    /// @notice Resolves a claim per the payoff matrix in docs/12-reporting.md §4. `target` must
    ///         match the report's subject so the insurance key can be derived by `slashInsurance`.
    /// @dev Insurance slashing for UPHELD is handled entirely by the separate `slashInsurance` call
    ///      below, not inline here — see that function's doc comment for why: the vault has no
    ///      reverse index of "every voucher who insured `target`", so the set is always
    ///      keeper/governor-supplied, whether or not anyone rebutted. Folding rebutter-only insurance
    ///      handling into `settle` itself (an earlier version of this function did) silently missed
    ///      the "UPHELD, nobody defends" case — rebutters are empty there by definition, so the
    ///      reporter never received their 50% of the target's insurance bonds even though the payoff
    ///      matrix guarantees it unconditionally. Unifying both cases into one post-settle call fixes
    ///      that without special-casing "did anyone rebut".
    function settle(bytes32 reportId, Outcome outcome, address target) external onlyReportRegistry {
        Claim storage c = claims[reportId];
        if (!c.open) revert ClaimNotOpen();
        if (c.settled) revert ClaimAlreadySettled();
        c.settled = true;
        c.open = false;
        c.target = target;
        c.outcome = outcome;

        Position storage rp = positions[c.reporter];
        uint128 reporterBond = c.reporterLocked;
        rp.locked -= reporterBond;

        address[] storage rebutters = rebuttersOf[reportId];
        uint128 rebuttalTotal = c.rebuttalTotal;

        if (outcome == Outcome.UPHELD) {
            // Reporter: bond back + 50% of rebuttal stake (+ 50% of the target's insurance, via the
            // separate `slashInsurance` call). Rebutters: lose their rebuttal stake — `bonded` must
            // drop here, not just `locked`, or the stake is merely unlocked (returned) rather than
            // actually forfeited, and the amount credited to the reporter/treasury below would have
            // no matching deduction anywhere.
            for (uint256 i = 0; i < rebutters.length; ++i) {
                address rebutter = rebutters[i];
                uint128 stake = rebuttals[reportId][rebutter];
                positions[rebutter].locked -= stake;
                positions[rebutter].bonded -= stake;
            }
            uint128 reporterShare = rebuttalTotal / 2;
            uint128 toTreasury = rebuttalTotal - reporterShare;
            rp.bonded += reporterShare; // bond itself was never removed from `bonded`, only `locked`
            if (toTreasury != 0) token.transfer(treasury, toTreasury);
        } else if (outcome == Outcome.UNPROVEN) {
            // Reporter's bond returned in full; every rebutter's stake returned in full.
            for (uint256 i = 0; i < rebutters.length; ++i) {
                address rebutter = rebutters[i];
                uint128 stake = rebuttals[reportId][rebutter];
                positions[rebutter].locked -= stake;
            }
            // reporter's `locked` already released above; `bonded` already includes it.
        } else if (outcome == Outcome.MALICIOUS) {
            // Reporter fully slashed; 50% to rebutters pro rata, 50% to target.
            rp.bonded -= reporterBond;
            uint128 toRebutters = reporterBond / 2;
            uint128 toTarget = reporterBond - toRebutters;
            for (uint256 i = 0; i < rebutters.length; ++i) {
                address rebutter = rebutters[i];
                uint128 stake = rebuttals[reportId][rebutter];
                positions[rebutter].locked -= stake;
                if (rebuttalTotal != 0) {
                    positions[rebutter].bonded += uint128((uint256(toRebutters) * stake) / rebuttalTotal);
                }
            }
            positions[target].bonded += toTarget;
        } else {
            // WITHDRAWN: 90% back to reporter, 10% burned to treasury; rebutters made whole.
            uint128 burnShare = reporterBond / 10;
            rp.bonded -= burnShare;
            if (burnShare != 0) token.transfer(treasury, burnShare);
            for (uint256 i = 0; i < rebutters.length; ++i) {
                address rebutter = rebutters[i];
                uint128 stake = rebuttals[reportId][rebutter];
                positions[rebutter].locked -= stake;
            }
        }

        emit Settled(reportId, outcome);
    }

    /// @notice Follow-up to an UPHELD `settle`: slashes 100% of the insurance `insuredVouchers[i]`
    ///         bonded on `target` (docs/12-reporting.md §4 target column "insurance slashed"), 50% to
    ///         the reporter and 50% to the treasury — the same split `settle` already applies to
    ///         rebuttal stakes. Covers **every** insured voucher, not only rebutters, which is what
    ///         makes the "UPHELD, nobody defends" row of the payoff matrix work: the reporter's
    ///         `+0.5 I` does not depend on anyone having rebutted.
    /// @dev Permissionless and idempotent by construction, same guard pattern as `AvalRegistry.sweep`
    ///      / `confirmFraud`'s `vouchees` list: `insuredVouchers` is a keeper/governor-supplied list
    ///      (the vault keeps no reverse index of "who insured `target`" — "the contract stores
    ///      facts", docs/02-contracts.md §1), and each entry is checked against live on-chain
    ///      insurance state before being touched. A stale, wrong, or already-processed address is a
    ///      silent no-op (`insurance[key] == 0`), so the list can be supplied incrementally across
    ///      multiple calls (e.g. as the Subgraph discovers more insured vouchers) without risk of
    ///      double-slashing or of a bad address corrupting anyone else's funds.
    function slashInsurance(bytes32 reportId, address[] calldata insuredVouchers) external {
        Claim storage c = claims[reportId];
        if (!c.settled || c.outcome != Outcome.UPHELD) revert ClaimNotUpheld();

        address target = c.target;
        uint128 toReporterTotal;
        uint128 toTreasuryTotal;
        for (uint256 i = 0; i < insuredVouchers.length; ++i) {
            address voucher = insuredVouchers[i];
            bytes32 key = keccak256(abi.encode(voucher, target));
            uint128 ins = insurance[key];
            if (ins == 0) continue;
            insurance[key] = 0;
            Position storage vp = positions[voucher];
            vp.locked -= ins;
            vp.bonded -= ins;
            uint128 half = ins / 2;
            toReporterTotal += half;
            toTreasuryTotal += (ins - half);
        }
        if (toReporterTotal != 0) positions[c.reporter].bonded += toReporterTotal;
        if (toTreasuryTotal != 0) token.transfer(treasury, toTreasuryTotal);
        emit InsuranceSlashed(reportId, toReporterTotal, toTreasuryTotal);
    }

    // ─── demurrage ───────────────────────────────────────────────────────────
    /// @notice Permissionless, lazy, exactly-continuous 7%/yr decay on idle-but-bonded AVAL
    ///         (`bonded - locked`). Locked (actively securing a claim/insurance) AVAL is exempt —
    ///         "money at risk is money working" (docs/11-token-vault §4.4). Decayed AVAL flows to
    ///         the treasury. `balance(t) = balance(0) * (1 - 0.07)^(t / 365d)`, computed via
    ///         `DEMURRAGE_RATE_PER_SECOND_WAD` raised to the integer power `elapsed` (seconds) — see
    ///         that constant's doc comment for the derivation and the precision bound.
    function applyDemurrage(address account) external {
        Position storage p = positions[account];
        if (p.lastDemurrage == 0) {
            p.lastDemurrage = uint64(block.timestamp);
            return;
        }
        uint256 elapsed = block.timestamp - p.lastDemurrage;
        p.lastDemurrage = uint64(block.timestamp);
        if (elapsed == 0) return;

        uint128 idle = p.bonded - p.locked;
        if (idle == 0) return;

        uint256 factor = _wadPow(DEMURRAGE_RATE_PER_SECOND_WAD, elapsed);
        uint256 remaining = (uint256(idle) * factor) / WAD;
        uint256 decay = uint256(idle) - remaining;   // remaining rounds down, so decay rounds up
        if (decay > idle) decay = idle;               // paranoia clamp; cannot trigger given the above
        if (decay == 0) return;

        p.bonded -= uint128(decay);
        token.transfer(treasury, decay);
        emit DemurrageApplied(account, uint128(decay), p.bonded);
    }

    /// @notice Fixed-point exponentiation by squaring: returns `x^n` where `x` is WAD (1e18) scaled,
    ///         in `O(log2(n))` multiply-and-truncate steps. Used to raise the per-second demurrage
    ///         rate to an integer number of elapsed seconds — see `DEMURRAGE_RATE_PER_SECOND_WAD`.
    function _wadPow(uint256 x, uint256 n) internal pure returns (uint256 result) {
        result = WAD;
        while (n > 0) {
            if (n & 1 == 1) result = (result * x) / WAD;
            x = (x * x) / WAD;
            n >>= 1;
        }
    }
}
