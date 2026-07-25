// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IAddressBook
/// @notice World ID Address Book — the on-chain, trustless source of Orb-anchor status.
/// @dev World Chain mainnet address: 0x57b930D551e677CC36e2fA036Ae2fe8FdaE0330D
///      (see docs/10-constants.md §7). Never cached on-chain by callers; read live.
///
///      CORRECTION (errata E-18). This interface previously declared
///      `getIsUserVerified(address) returns (bool)`. That function does not exist on the real
///      contract — calling it reverts. Probed directly against the live Address Book on chain 480:
///
///          addressVerifiedUntil(address)(uint256)  ->  1789813327        ✅
///          getIsUserVerified(address)(bool)        ->  execution reverted ❌
///          isVerified(address)(bool)               ->  execution reverted ❌
///          verifiedUntil(address)(uint256)         ->  execution reverted ❌
///
///      The real Address Book stores an EXPIRY, not a boolean: verification lapses unless renewed.
///      A boolean interface could not have represented that even if the name had been right.
///
///      This was invisible on World Chain Sepolia because the Address Book is mainnet-only, so
///      testing ran against `script/GenesisAnchorBook.sol`, a stand-in written to match this
///      interface — i.e. the mock was shaped to fit the assumption instead of the real contract.
interface IAddressBook {
    /// @notice Unix timestamp until which `user`'s Orb verification is valid. Zero, or any value
    ///         in the past, means not currently verified.
    function addressVerifiedUntil(address user) external view returns (uint256);
}
