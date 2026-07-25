// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {VouchMeToken} from "../src/VouchMeToken.sol";
import {VouchMeRegistry} from "../src/VouchMeRegistry.sol";
import {CredibilityVault} from "../src/CredibilityVault.sol";
import {PlatformRegistry} from "../src/PlatformRegistry.sol";
import {ReportRegistry} from "../src/ReportRegistry.sol";
import {PresenceDrip} from "../src/PresenceDrip.sol";

/// @title Deploy
/// @notice Deploys all six VouchMe contracts (docs/02-contracts.md §0) in dependency order and performs
///         every post-deploy wiring step the individual contracts leave to a governor setter because
///         their constructors would otherwise need each other's not-yet-existing address:
///
///           VouchMeToken     — no dependencies
///           VouchMeRegistry  — needs the World ID Address Book (external)
///           CredibilityVault — needs VouchMeToken
///           PlatformRegistry — needs VouchMeToken
///           ReportRegistry   — needs VouchMeRegistry, CredibilityVault, PlatformRegistry
///           PresenceDrip     — needs VouchMeToken, CredibilityVault, VouchMeRegistry
///
///         Post-deploy wiring (all governor-only setters, all safe no-ops until called — see each
///         contract's own doc comments for the constructor-order reasoning):
///           VouchMeRegistry.setReportRegistry(ReportRegistry)     — UPHELD slot penalty
///           VouchMeRegistry.setPresenceDrip(PresenceDrip)         — confirmed-fraud tenure zero
///           VouchMeRegistry.setPlatformRegistry(PlatformRegistry) — dual-role guard
///           PlatformRegistry.setReportRegistry(ReportRegistry)    — open-report bond lock
///           PlatformRegistry.setVouchMeRegistry(VouchMeRegistry)  — dual-role guard
///           CredibilityVault.setReportRegistry(ReportRegistry)    — lockForReport/Rebuttal/settle
///           ReportRegistry.setPresenceDrip(PresenceDrip)          — UPHELD accrual pause
///           VouchMeToken.setMinter(PresenceDrip, true)            — PresenceDrip mints the drip
///
///         Run with `forge script script/Deploy.s.sol --rpc-url <...> --broadcast`. Reads
///         PRIVATE_KEY / ADDRESS_BOOK_ADDRESS / ATTESTOR_ADDRESS / GOVERNOR_ADDRESS from the
///         environment per `.env.example`; TREASURY_ADDRESS is optional and defaults to the governor
///         if unset (fine for a testnet demo, not for mainnet — a real deployment sets a dedicated
///         treasury/multisig).
/// @dev The wiring calls only run when the deploying key *is* the governor (true for a local/testnet
///      run where one EOA plays both roles). In a real deployment `governor` is a 2-of-3 multisig
///      (docs/02-contracts.md §6 checklist) that does not hold this script's private key, so the
///      eight setter calls above are submitted separately through the multisig after this script
///      deploys the contracts — this script prints their addresses either way.
contract Deploy is Script {
    function run()
        external
        returns (
            VouchMeToken token,
            VouchMeRegistry vouchMeRegistry,
            CredibilityVault vault,
            PlatformRegistry platformRegistry,
            ReportRegistry reportRegistry,
            PresenceDrip presenceDrip
        )
    {
        uint256 deployerPk = vm.envUint("PRIVATE_KEY");
        address addressBook = vm.envAddress("ADDRESS_BOOK_ADDRESS");
        address attestor = vm.envAddress("ATTESTOR_ADDRESS");
        address governor = vm.envAddress("GOVERNOR_ADDRESS");
        address treasury = vm.envOr("TREASURY_ADDRESS", governor);
        address deployer = vm.addr(deployerPk);

        vm.startBroadcast(deployerPk);

        token = new VouchMeToken(governor);
        vouchMeRegistry = new VouchMeRegistry(addressBook, governor, attestor);
        vault = new CredibilityVault(address(token), governor, treasury);
        platformRegistry = new PlatformRegistry(address(token), governor, treasury);
        reportRegistry = new ReportRegistry(
            address(vouchMeRegistry), address(vault), address(platformRegistry), governor
        );
        presenceDrip = new PresenceDrip(address(token), address(vault), address(vouchMeRegistry), governor);

        // Post-deploy wiring. Every setter above is `onlyGovernor`, so this only succeeds when the
        // deploying key doubles as governor (local/testnet). Against a real multisig governor these
        // calls simply revert and are skipped here — see the contract-level doc comment.
        if (governor == deployer) {
            vouchMeRegistry.setReportRegistry(address(reportRegistry));
            vouchMeRegistry.setPresenceDrip(address(presenceDrip));
            vouchMeRegistry.setPlatformRegistry(address(platformRegistry));
            platformRegistry.setReportRegistry(address(reportRegistry));
            platformRegistry.setVouchMeRegistry(address(vouchMeRegistry));
            vault.setReportRegistry(address(reportRegistry));
            reportRegistry.setPresenceDrip(address(presenceDrip));
            token.setMinter(address(presenceDrip), true);
        }

        vm.stopBroadcast();
    }
}
