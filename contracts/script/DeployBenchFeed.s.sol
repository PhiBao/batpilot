// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {MockFeed} from "../src/Mocks.sol";
import {SessionVolEngine} from "../src/SessionVolEngine.sol";

/// @notice Deploys a history-rich MockFeed for benchmarking + wires the engine.
/// Env: PRIVATE_KEY, ENGINE, plus hardcoded 13-price window (~1% steps).
contract DeployBenchFeed is Script {
    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address engine = vm.envAddress("ENGINE");
        vm.startBroadcast(key);
        MockFeed feed = new MockFeed(180e8);
        int256[] memory h = new int256[](12);
        h[0] = int256(181e8);
        h[1] = int256(179e8);
        h[2] = int256(182e8);
        h[3] = int256(178e8);
        h[4] = int256(181e8);
        h[5] = int256(180e8);
        h[6] = int256(183e8);
        h[7] = int256(179e8);
        h[8] = int256(180e8);
        h[9] = int256(181e8);
        h[10] = int256(180e8);
        h[11] = int256(182e8);
        feed.pushHistory(h);
        SessionVolEngine(engine).setConfig(address(feed), 200, 10_000, 12, 2000, 3600);
        vm.stopBroadcast();
        console.log("BenchFeed:", address(feed));
    }
}
