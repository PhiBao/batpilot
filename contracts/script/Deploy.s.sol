// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {BatpilotVault} from "../src/BatpilotVault.sol";
import {SessionGuard} from "../src/SessionGuard.sol";
import {UniswapV3Adapter} from "../src/UniswapV3Adapter.sol";
import {MorphoEarnAdapter} from "../src/MorphoEarnAdapter.sol";
import {MockUSDG, MockStockToken, MockFeed, MockSwapRouter, MockYieldVault} from "../src/Mocks.sol";

/// @notice Batpilot deployment (reads contracts/.env via `set -a; source .env`).
/// Mock mode (local / testnet / Sepolia, DEPLOY_MOCKS=true): full mock stack.
/// Live mode (mainnet, DEPLOY_MOCKS=false): deploys UniswapV3Adapter over
/// SWAP_ROUTER02 + MorphoEarnAdapter over EARN_VAULT, registers real feeds.
contract Deploy is Script {
    // RHC mainnet canonical venues (Teleport-proof constants, override via env).
    address constant MAINNET_TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address constant MAINNET_NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant MAINNET_AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    address constant MAINNET_TSLA_FEED = 0x4A1166a659A55625345e9515b32adECea5547C38;
    address constant MAINNET_NVDA_FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address constant MAINNET_AAPL_FEED = 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0;
    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        bool mocks = vm.envOr("DEPLOY_MOCKS", true);

        address usdg = vm.envOr("USDG", address(0));
        address router = vm.envOr("ROUTER", address(0));
        address yieldVault = vm.envOr("YIELD", address(0));

        vm.startBroadcast(key);

        SessionGuard guard = new SessionGuard();

        if (mocks) {
            MockUSDG mUsdg = new MockUSDG();
            MockSwapRouter mRouter = new MockSwapRouter(address(mUsdg));
            MockYieldVault mYield = new MockYieldVault(address(mUsdg));

            // Demo basket: NVDA @ $180, TSLA @ $250.
            MockStockToken nvda = new MockStockToken("NVDA token", "NVDA");
            MockStockToken tsla = new MockStockToken("TSLA token", "TSLA");
            MockFeed nvdaFeed = new MockFeed(180e8);
            MockFeed tslaFeed = new MockFeed(250e8);
            mRouter.setFeed(address(nvda), address(nvdaFeed));
            mRouter.setFeed(address(tsla), address(tslaFeed));

            // Seed router liquidity + yield reserve (demo subsidy).
            nvda.mint(address(mRouter), 1_000_000e18);
            tsla.mint(address(mRouter), 1_000_000e18);
            mUsdg.mint(address(mRouter), 2_000_000e18);
            mUsdg.mint(address(mYield), 1_000_000e18);

            usdg = address(mUsdg);
            router = address(mRouter);
            yieldVault = address(mYield);

            console.log("mUSDG:      ", usdg);
            console.log("mRouter:    ", router);
            console.log("mYield:     ", yieldVault);
            console.log("NVDA:       ", address(nvda));
            console.log("TSLA:       ", address(tsla));
            console.log("NVDA feed:  ", address(nvdaFeed));
            console.log("TSLA feed:  ", address(tslaFeed));
        }

        if (!mocks) {
            // Production wiring: real AMM + real Earn behind the same interfaces.
            address swapRouter02 = vm.envAddress("SWAP_ROUTER02");
            address earnVault = vm.envAddress("EARN_VAULT");
            UniswapV3Adapter live = new UniswapV3Adapter(swapRouter02, usdg);
            live.setFeed(MAINNET_NVDA, MAINNET_NVDA_FEED);
            live.setFeed(MAINNET_TSLA, MAINNET_TSLA_FEED);
            live.setFeed(MAINNET_AAPL, MAINNET_AAPL_FEED);
            MorphoEarnAdapter earnAdapter = new MorphoEarnAdapter(earnVault);
            router = address(live);
            yieldVault = address(earnAdapter);
            console.log("U3Adapter:  ", router);
            console.log("EarnAdapter:", yieldVault);
        }

        require(
            usdg != address(0) && router != address(0) && yieldVault != address(0),
            "Deploy: missing deps"
        );

        BatpilotVault vault = new BatpilotVault(usdg, address(guard), router, yieldVault);

        vm.stopBroadcast();

        console.log("SessionGuard:", address(guard));
        console.log("BatpilotVault:", address(vault));
    }
}
