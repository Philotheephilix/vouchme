// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IAddressBook
/// @notice World ID Address Book — the on-chain, trustless source of Orb-anchor status.
/// @dev World Chain mainnet address: 0x57b930D551e677CC36e2fA036Ae2fe8FdaE0330D
///      (see docs/10-constants.md §7). Never cached on-chain by callers; read live.
interface IAddressBook {
    /// @notice Returns true if `user` currently holds a live Orb verification.
    function getIsUserVerified(address user) external view returns (bool);
}
