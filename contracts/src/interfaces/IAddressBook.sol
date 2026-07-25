// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IAddressBook
/// @notice World ID Address Book — the on-chain, trustless source of Orb-anchor status.
/// @dev World Chain mainnet address: 0x57b930D551e677CC36e2fA036Ae2fe8FdaE0330D
///      (see docs/10-constants.md §7). Never cached on-chain by callers; read live.
///
///      `addressVerifiedUntil` is the only verification function the real contract exposes, and it
///      returns an EXPIRY rather than a boolean: Orb verification lapses unless renewed, so a
///      boolean could not represent anchor status at all.
///
///      The Address Book is deployed on World Chain mainnet only. Testnet deployments point
///      `VouchMeRegistry` at `script/GenesisAnchorBook.sol`, which implements this same interface.
interface IAddressBook {
    /// @notice Unix timestamp until which `user`'s Orb verification is valid. Zero, or any value
    ///         in the past, means not currently verified.
    function addressVerifiedUntil(address user) external view returns (uint256);
}
