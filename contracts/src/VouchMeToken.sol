// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title VouchMeToken
/// @notice The VOUCHME token. A bond, not a score — see docs/11-token-vault.md §1.
///         "Money makes claims cost something. It never makes them true." No code path in this
///         repo lets a VOUCHME balance enter the scoring function; this contract only moves value.
/// @dev Minimal, dependency-free ERC20 (no OpenZeppelin). Capped supply, role-gated minting.
///      Minting is restricted to the emission contracts (surviving-vouch mining, upheld-report
///      mining, platform-vouch mining, PresenceDrip) via the `minters` mapping — never a public
///      mint, never purchasable score.
contract VouchMeToken {
    // ─── ERC20 metadata ─────────────────────────────────────────────────────
    string public constant name = "VouchMe";
    string public constant symbol = "VOUCHME";
    uint8  public constant decimals = 18;

    // ─── supply ─────────────────────────────────────────────────────────────
    /// @notice Hard cap: 1,000,000,000 VOUCHME. No public sale, no path around the cap.
    uint256 public constant CAP = 1_000_000_000e18;
    uint256 public totalSupply;

    // ─── balances ───────────────────────────────────────────────────────────
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // ─── roles ──────────────────────────────────────────────────────────────
    address public governor;
    mapping(address => bool) public minters; // emission/drip contracts only

    // ─── events ─────────────────────────────────────────────────────────────
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event MinterSet(address indexed minter, bool enabled);
    event GovernorTransferred(address indexed previousGovernor, address indexed newGovernor);

    // ─── errors ─────────────────────────────────────────────────────────────
    error NotGovernor();
    error NotMinter();
    error CapExceeded();
    error InsufficientBalance();
    error InsufficientAllowance();
    error ZeroAddress();

    // ─── modifiers ──────────────────────────────────────────────────────────
    modifier onlyGovernor() {
        if (msg.sender != governor) revert NotGovernor();
        _;
    }

    modifier onlyMinter() {
        if (!minters[msg.sender]) revert NotMinter();
        _;
    }

    constructor(address _governor) {
        if (_governor == address(0)) revert ZeroAddress();
        governor = _governor;
        emit GovernorTransferred(address(0), _governor);
    }

    // ─── governance ─────────────────────────────────────────────────────────
    function setMinter(address minter, bool enabled) external onlyGovernor {
        minters[minter] = enabled;
        emit MinterSet(minter, enabled);
    }

    function transferGovernor(address newGovernor) external onlyGovernor {
        if (newGovernor == address(0)) revert ZeroAddress();
        emit GovernorTransferred(governor, newGovernor);
        governor = newGovernor;
    }

    // ─── mint / burn ────────────────────────────────────────────────────────
    /// @notice Mints emission to `to`. Restricted to the credibility-mining, report-mining,
    ///         platform-vouch-mining and PresenceDrip contracts (docs/11-token-vault.md §4).
    function mint(address to, uint256 amount) external onlyMinter {
        if (to == address(0)) revert ZeroAddress();
        if (totalSupply + amount > CAP) revert CapExceeded();
        totalSupply += amount;
        unchecked {
            balanceOf[to] += amount;
        }
        emit Transfer(address(0), to, amount);
    }

    /// @notice Burns `amount` from the caller. Used for the 10% withdrawal burn
    ///         (docs/12-reporting.md §5) and other slashing paths that route through the vault.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    function burnFrom(address account, uint256 amount) external {
        uint256 allowed = allowance[account][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance();
            unchecked {
                allowance[account][msg.sender] = allowed - amount;
            }
        }
        _burn(account, amount);
    }

    function _burn(address account, uint256 amount) internal {
        uint256 bal = balanceOf[account];
        if (bal < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[account] = bal - amount;
            totalSupply -= amount;
        }
        emit Transfer(account, address(0), amount);
    }

    // ─── ERC20 standard ─────────────────────────────────────────────────────
    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance();
            unchecked {
                allowance[from][msg.sender] = allowed - amount;
            }
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = balanceOf[from];
        if (bal < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = bal - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }
}
