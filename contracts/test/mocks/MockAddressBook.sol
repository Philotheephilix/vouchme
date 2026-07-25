// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAddressBook} from "../../src/interfaces/IAddressBook.sol";

/// @notice Test double for the World ID Address Book. Defaults everyone to unverified; tests can
///         flip individual addresses.
contract MockAddressBook is IAddressBook {
    mapping(address => bool) public verified;

    function setVerified(address user, bool isVerified) external {
        verified[user] = isVerified;
    }

    function getIsUserVerified(address user) external view returns (bool) {
        return verified[user];
    }
}
