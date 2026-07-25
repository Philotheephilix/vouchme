// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAddressBook} from "../../src/interfaces/IAddressBook.sol";

/// @notice Test double for the World ID Address Book. Defaults everyone to unverified; tests can
///         flip individual addresses, or set a precise expiry.
///
/// @dev    Mirrors the real Address Book's `addressVerifiedUntil(address) -> uint256`. Storing an
///         expiry rather than a bool is what makes the lapse case testable: Orb verification
///         EXPIRES, and `isAnchor` must stop being true when it does.
contract MockAddressBook is IAddressBook {
    mapping(address => uint256) public verifiedUntil;

    /// @notice Convenience for the common case — verified "forever", or not at all.
    function setVerified(address user, bool isVerified) external {
        verifiedUntil[user] = isVerified ? type(uint256).max : 0;
    }

    /// @notice Set a precise expiry, so a test can warp past it and assert anchor status drops.
    function setVerifiedUntil(address user, uint256 until) external {
        verifiedUntil[user] = until;
    }

    function addressVerifiedUntil(address user) external view returns (uint256) {
        return verifiedUntil[user];
    }
}
