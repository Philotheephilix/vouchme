// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAddressBook} from "../src/interfaces/IAddressBook.sol";

/// @title GenesisAnchorBook — TESTNET ONLY. NOT the World ID Address Book.
///
/// @notice World ID's Address Book is deployed at 0x57b930D551e677CC36e2fA036Ae2fe8FdaE0330D on
///         World Chain **mainnet**. It does not exist on World Chain Sepolia — verified by probing
///         that address on chain 4801 and finding no bytecode, and by the absence of any Sepolia
///         value in World's own documentation. This contract stands in for it so the protocol can
///         be exercised on a testnet.
///
/// @dev    THIS IS THE ONE PLACE WHERE A TESTNET DEPLOYMENT DIFFERS FROM THE REAL PROTOCOL, AND
///         IT IS THE MOST IMPORTANT PLACE TO BE HONEST ABOUT.
///
///         Anchors are the only externally-grounded fact in Aval. Scores are the *least* fixed
///         point of a system of equations that also admits self-supporting cliques
///         (docs/01-trust-math.md §5.1), and a least fixed point needs a bottom. Orb verification
///         is that bottom: it is the only claim in the system that does not depend on any other
///         claim in the system.
///
///         A genesis anchor is therefore NOT proof of personhood. It is an assertion by whoever
///         holds this contract's owner key. Every consumer must be able to tell the difference,
///         so `anchorSource()` returns "genesis-testnet" rather than "world-id-orb", and the UI
///         is required to render it as `anchor: genesis (testnet)`.
///
///         Deploying this to mainnet, or presenting a genesis anchor as an Orb anchor, would
///         forge the only load-bearing fact in the protocol. Don't.
contract GenesisAnchorBook is IAddressBook {
    address public owner;
    mapping(address => bool) public verified;
    uint256 public anchorCount;

    event GenesisAnchorSet(address indexed account, bool isAnchor);
    event OwnerTransferred(address indexed from, address indexed to);

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address[] memory initialAnchors) {
        owner = msg.sender;
        for (uint256 i; i < initialAnchors.length; ++i) {
            if (!verified[initialAnchors[i]]) {
                verified[initialAnchors[i]] = true;
                unchecked {
                    ++anchorCount;
                }
                emit GenesisAnchorSet(initialAnchors[i], true);
            }
        }
    }

    /// @notice Same selector and semantics as the real Address Book, so AvalRegistry needs no
    ///         testnet-specific code path. The difference is in who is asserting, not in the shape.
    ///
    /// @dev    This claim used to be FALSE, and that is errata E-18. The stand-in exposed
    ///         `getIsUserVerified(address) returns (bool)`, which the real Address Book does not
    ///         have at all — it exposes `addressVerifiedUntil(address) returns (uint256)`. Because
    ///         the Address Book is mainnet-only, every test ran against this contract, so the
    ///         mismatch could not surface until `isAnchor()` reverted on real mainnet. A mock that
    ///         is shaped to fit the assumption tests the assumption against itself.
    ///
    ///         Now matching the real shape: an expiry, not a flag. A genesis anchor is returned as
    ///         "verified far into the future" so the same `> block.timestamp` comparison in
    ///         `AvalRegistry.isAnchor` works identically against either contract.
    function addressVerifiedUntil(address user) external view returns (uint256) {
        return verified[user] ? type(uint256).max : 0;
    }

    /// @notice Provenance label. The real Address Book has no such function — its absence is how a
    ///         client tells a real deployment from this one.
    function anchorSource() external pure returns (string memory) {
        return "genesis-testnet";
    }

    function setAnchor(address account, bool isAnchor) external onlyOwner {
        if (verified[account] == isAnchor) return;
        verified[account] = isAnchor;
        unchecked {
            isAnchor ? ++anchorCount : --anchorCount;
        }
        emit GenesisAnchorSet(account, isAnchor);
    }

    function transferOwnership(address to) external onlyOwner {
        emit OwnerTransferred(owner, to);
        owner = to;
    }
}
