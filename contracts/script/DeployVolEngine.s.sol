// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {SessionVolEngine} from "../src/SessionVolEngine.sol";

/// @notice Deploys SessionVolEngine bound to an existing guard.
/// Env: PRIVATE_KEY, GUARD, FEED (optional: configures base 200 / 1x / 12 / cap 2000 / 1h).
contract DeployVolEngine is Script {
    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address guard = vm.envAddress("GUARD");
        vm.startBroadcast(key);
        SessionVolEngine engine = new SessionVolEngine(guard);
        try vm.envAddress("FEED") returns (address feed) {
            engine.setConfig(feed, 200, 10_000, 12, 2000, 3600);
            console.log("configured feed:", feed);
        } catch {}
        vm.stopBroadcast();
        console.log("SessionVolEngine:", address(engine));
    }
}
