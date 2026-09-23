// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {BatpilotVault} from "../src/BatpilotVault.sol";

/// @notice Deploys a vault against EXISTING deps (for logic-only upgrades).
/// Env: PRIVATE_KEY, USDG, GUARD, ROUTER, YIELD, DECIMALS.
contract DeployVaultOnly is Script {
    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(key);
        BatpilotVault vault = new BatpilotVault(
            vm.envAddress("USDG"),
            vm.envAddress("GUARD"),
            vm.envAddress("ROUTER"),
            vm.envAddress("YIELD"),
            uint8(vm.envUint("DECIMALS"))
        );
        vm.stopBroadcast();
        console.log("BatpilotVault:", address(vault));
    }
}
