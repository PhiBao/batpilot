// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {BatpilotVault} from "../src/BatpilotVault.sol";
import {SessionGuard} from "../src/SessionGuard.sol";
import {SessionVolEngine} from "../src/SessionVolEngine.sol";
import {MockSwapRouter, MockYieldVault} from "../src/Mocks.sol";
import {IChainlinkFeed, IStockToken} from "../src/IBatpilot.sol";

/// @notice Batpilot vs REAL Robinhood Chain mainnet state (chain 4663).
/// Run: forge test --match-contract BatpilotForkTest --fork-url https://rpc.mainnet.chain.robinhood.com
/// Uses the real NVDA stock token + Chainlink feed + USDG. Fills settle through
/// a local mock router priced off the REAL feed (mainnet AMM wiring is a
/// deployment parameter, not vault logic). Real USDG has 6 decimals — the
/// vault is decimals-agnostic (all accounting in wei), which this test proves.
contract BatpilotForkTest is Test {
    // Canonical mainnet addresses (docs.robinhood.com/chain/contracts,
    // hummusonrails/robinhood-chain-dapp-example).
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant NVDA_FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    BatpilotVault vault;
    SessionGuard guard;
    MockSwapRouter router;
    MockYieldVault earn;

    address user = makeAddr("forkuser");

    function setUp() public {
        require(block.chainid == 4663, "fork test needs RHC mainnet fork");
        guard = new SessionGuard();
        router = new MockSwapRouter(USDG);
        router.setFeed(NVDA, NVDA_FEED);
        earn = new MockYieldVault(USDG);
        vault = new BatpilotVault(USDG, address(guard), address(router), address(earn), 6);

        // Real NVDA inventory for the pricing router + real USDG bankroll.
        deal(NVDA, address(router), 100e18);
        deal(USDG, address(router), 1_000_000e6);
        deal(USDG, address(earn), 1_000_000e6);
        deal(USDG, user, 10_000e6);
    }

    function test_RealInterfacesAnswer() public view {
        (, int256 price,, uint256 updatedAt,) =
            IChainlinkFeed(NVDA_FEED).latestRoundData();
        assertGt(price, 0);
        assertGt(updatedAt, 0);
        assertGt(IStockToken(NVDA).uiMultiplier(), 0);
        assertEq(IERC20Metadata(NVDA).decimals(), 18);
        assertEq(IERC20Metadata(USDG).decimals(), 6);
    }

    function test_FillAgainstRealFeed() public {
        uint256 fill = 50e6; // $50 in real 6-decimal USDG
        vm.startPrank(user);
        IERC20(USDG).approve(address(vault), type(uint256).max);
        uint256 id = vault.createPlan(NVDA, NVDA_FEED, fill, 60, 800, 2000, 7 days, 0, 200, 7200);
        vault.fundPlan(id, 1000e6);
        vm.stopPrank();

        // First fill may be stale if markets are closed (24/5 feeds) — assert
        // EITHER a real fill at the real price OR an honest stale refusal.
        vm.warp(block.timestamp + 61);
        (bool executed, uint8 reason) = vault.executeDCA(id);

        (, int256 price,, uint256 updatedAt,) =
            IChainlinkFeed(NVDA_FEED).latestRoundData();
        if (executed) {
            (,,,,,,,,,, uint256 usdgBal, uint256 stockBal, uint256 entryAvg,,,,,,,) =
                vault.plans(id);
            assertEq(usdgBal, 1000e6 - fill);
            assertGt(stockBal, 0);
            assertEq(entryAvg, uint256(price)); // filled AT the real feed price
        } else {
            assertEq(reason, guard.REASON_STALE());
            assertLt(updatedAt + 7 days, block.timestamp); // proves WHY: feed older than bound
        }
    }

    function test_StaleRefusalOnAgedFeed() public {        uint256 fill = 50e6;
        vm.startPrank(user);
        IERC20(USDG).approve(address(vault), type(uint256).max);
        uint256 id = vault.createPlan(NVDA, NVDA_FEED, fill, 60, 800, 2000, 1 hours, 0, 200, 7200);
        vault.fundPlan(id, 1000e6);
        vm.stopPrank();

        // Age past the 1h freshness bound no matter when the test runs
        // (anchor on the later of chain time vs feed time — feeds can lag
        // chain time over weekends, and warp must move forward).
        (, , , uint256 updatedAt,) = IChainlinkFeed(NVDA_FEED).latestRoundData();
        uint256 anchor = block.timestamp > updatedAt ? block.timestamp : updatedAt;
        vm.warp(anchor + 2 hours + 61);
        (bool executed, uint8 reason) = vault.executeDCA(id);
        assertFalse(executed);
        assertEq(reason, guard.REASON_STALE());
    }

    function test_VolEngineOnRealHistory() public {
        SessionVolEngine engine = new SessionVolEngine(address(guard));
        engine.setConfig(NVDA_FEED, 200, 10_000, 12, 2000, 7 days);

        (uint256 band, uint256 vol, uint256 n) = engine.bandFor(NVDA_FEED);
        // Holds whatever the market gives: real vol with real history, or an
        // honest base-band fallback when the proxy exposes no past rounds.
        assertGe(band, 200);
        assertLe(band, 2000);
        if (n >= 2) {
            assertGe(vol, 0);
            // Band must equal base + vol under the cap.
            uint256 expect = 200 + vol > 2000 ? 2000 : 200 + vol;
            assertEq(band, expect);
        } else {
            assertEq(band, 200);
        }

        // Self-evaluation at the real price: allow iff the real feed is fresh.
        (, int256 price,, uint256 updatedAt,) =
            IChainlinkFeed(NVDA_FEED).latestRoundData();
        (bool ok, uint8 reason,,,) = engine.evaluate(
            NVDA_FEED, uint256(price), updatedAt, block.timestamp, uint256(price), false
        );
        if (block.timestamp <= updatedAt + 7 days) {
            assertTrue(ok);
            assertEq(reason, 0);
        } else {
            assertFalse(ok);
            assertEq(reason, guard.REASON_STALE());
        }
    }
}
