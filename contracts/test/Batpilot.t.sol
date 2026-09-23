// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BatpilotVault} from "../src/BatpilotVault.sol";
import {SessionGuard} from "../src/SessionGuard.sol";
import {MockUSDG, MockUSDG6, MockStockToken, MockFeed, MockSwapRouter, MockYieldVault} from "../src/Mocks.sol";
/// @notice End-to-end tests for the Batpilot MVP loop:
/// create -> fund -> DCA fills -> protection -> yield sweep -> cancel,
/// plus every guard-rejection path (the demo's proof-of-safety moments).
contract BatpilotTest is Test {
    MockUSDG usdg;
    MockStockToken nvda;
    MockFeed feed;
    MockSwapRouter router;
    MockYieldVault earn;
    SessionGuard guard;
    BatpilotVault vault;

    address user = makeAddr("user");
    address keeper = makeAddr("keeper");

    // $180, 8 decimals
    int256 constant P0 = 180e8;
    uint256 constant FILL = 50e18; // $50 per fill
    uint256 constant CADENCE = 60; // 60s demo cadence

    function setUp() public {
        usdg = new MockUSDG();
        nvda = new MockStockToken("NVDA token", "NVDA");
        feed = new MockFeed(P0);
        router = new MockSwapRouter(address(usdg));
        router.setFeed(address(nvda), address(feed));
        earn = new MockYieldVault(address(usdg));
        guard = new SessionGuard();
        vault = new BatpilotVault(address(usdg), address(guard), address(router), address(earn), 18);

        // Liquidity for the mock router + user bankroll + yield subsidy.
        nvda.mint(address(router), 1_000_000e18);
        usdg.mint(address(router), 1_000_000e18);
        usdg.mint(address(earn), 1_000_000e18); // mock interest reserve
        usdg.mint(user, 10_000e18);

        vm.startPrank(user);
        usdg.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    function makePlan() internal returns (uint256 planId) {
        vm.prank(user);
        planId = vault.createPlan(
            address(nvda), address(feed), FILL, CADENCE, 800, 2000, 3600, 500, 200, 7200
        );
        vm.prank(user);
        vault.fundPlan(planId, 1000e18);
    }

    function test_CreateAndFund() public {
        uint256 id = makePlan();
        (address owner,,,,,,,,,,,,,,,, bool active, bool paused,,) = vault.plans(id);
        assertEq(owner, user);
        assertTrue(active);
        assertFalse(paused);
    }

    function test_DCAFillHappyPath() public {
        uint256 id = makePlan();
        skip(CADENCE + 1);
        vm.prank(keeper); // permissionless: anyone may execute
        (bool executed, uint8 reason) = vault.executeDCA(id);
        assertTrue(executed);
        assertEq(reason, 0);

        (,,,,,,,,,, uint256 usdgBal, uint256 stockBal, uint256 entryAvg,,,,,,,) = vault.plans(id);
        assertEq(usdgBal, 1000e18 - FILL);
        assertEq(stockBal, (FILL * 1e8) / uint256(P0));
        assertEq(entryAvg, uint256(P0));
    }

    function test_DCANotDue() public {
        uint256 id = makePlan();
        vm.prank(keeper);
        (bool executed,) = vault.executeDCA(id);
        assertFalse(executed); // cadence not elapsed
    }

    function test_GuardRejectsStaleFeed() public {
        uint256 id = makePlan();
        feed.setStale(P0, block.timestamp); // freeze timestamp...
        skip(7200); // ...then let 2h pass (maxStale = 1h)
        vm.prank(keeper);
        (bool executed, uint8 reason) = vault.executeDCA(id);
        assertFalse(executed);
        assertEq(reason, guard.REASON_STALE());
    }

    function test_GuardRejectsBandBreach() public {
        uint256 id = makePlan();
        skip(CADENCE + 1);
        vm.prank(keeper);
        vault.executeDCA(id); // entry @ $180
        // +10% gap while band is 5% -> reject, never buy the spike.
        feed.setPrice(198e8);
        skip(CADENCE + 1);
        vm.prank(keeper);
        (bool executed, uint8 reason) = vault.executeDCA(id);
        assertFalse(executed);
        assertEq(reason, guard.REASON_BAND_BREACH());
    }

    function test_StopLossFiresAndSettlesUSDG() public {
        uint256 id = makePlan();
        skip(CADENCE + 1);
        vm.prank(keeper);
        vault.executeDCA(id); // long @ $180
        // -10% crash, stop at -8% -> fire.
        feed.setPrice(162e8);
        vm.prank(keeper);
        uint8 code = vault.executeProtection(id);
        assertEq(code, 1);

        (,,,,,,,,,, uint256 usdgBal, uint256 stockBal,,,,,,,,) = vault.plans(id);
        assertEq(stockBal, 0);
        // $50 of NVDA bought @180, sold @162 = $45 back.
        assertApproxEqAbs(usdgBal, 1000e18 - FILL + 45e18, 1e12);
    }

    function test_TakeProfitFires() public {
        uint256 id = makePlan();
        skip(CADENCE + 1);
        vm.prank(keeper);
        vault.executeDCA(id);
        feed.setPrice(225e8); // +25%, take at +20%
        vm.prank(keeper);
        uint8 code = vault.executeProtection(id);
        assertEq(code, 2);
    }

    function test_ProtectionSkipsWhenStale() public {
        uint256 id = makePlan();
        skip(CADENCE + 1);
        vm.prank(keeper);
        vault.executeDCA(id);
        // Crash on a dead feed: protection must NOT act blind.
        feed.setStale(100e8, block.timestamp);
        skip(7200);
        vm.prank(keeper);
        uint8 code = vault.executeProtection(id);
        assertEq(code, 3);
        (,,,,,,,,,,, uint256 stockBal,,,,,,,,) = vault.plans(id);
        assertGt(stockBal, 0); // position untouched
    }

    function test_CorporateActionPausesPlan() public {
        uint256 id = makePlan();
        nvda.setMultiplier(2e18); // 2:1 split event
        skip(CADENCE + 1);
        vm.prank(keeper);
        (bool executed, uint8 reason) = vault.executeDCA(id);
        assertFalse(executed);
        assertEq(reason, guard.REASON_PAUSED());
        (,,,,,,,,,,,,,,,, bool active, bool paused,,) = vault.plans(id);
        assertTrue(active);
        assertTrue(paused);
    }

    function test_SweepAndWithdrawYield() public {
        uint256 id = makePlan();
        vm.prank(user);
        vault.sweepToYield(id, 500e18);
        skip(365 days);
        // ~7% APR on $500 = ~$35.
        (uint256 usdgBal,,,) = vault.planEquity(id);
        assertEq(usdgBal, 500e18);
        (,,, uint256 yieldValue) = vault.planEquity(id);
        assertApproxEqAbs(yieldValue, 535e18, 1e18);

        (,,,,,,,,,,,,,,, uint256 shares,,,,) = vault.plans(id);
        vm.prank(user);
        vault.withdrawFromYield(id, shares);
        (uint256 usdgAfter,,,) = vault.planEquity(id);
        assertApproxEqAbs(usdgAfter, 1035e18, 1e18);
    }

    function test_CancelSellsAndReturns() public {
        uint256 id = makePlan();
        skip(CADENCE + 1);
        vm.prank(keeper);
        vault.executeDCA(id);
        uint256 before = usdg.balanceOf(user);
        vm.prank(user);
        vault.cancelPlan(id);
        // $950 untouched + ~$50 stock value back.
        assertApproxEqAbs(usdg.balanceOf(user), before + 1000e18, 1e12);
        (,,,,,,,,,,,,,,,, bool active,,,) = vault.plans(id);
        assertFalse(active);
    }

    function test_PlanEquityView() public {
        uint256 id = makePlan();
        skip(CADENCE + 1);
        vm.prank(keeper);
        vault.executeDCA(id);
        (uint256 u, uint256 s, uint256 sv, uint256 y) = vault.planEquity(id);
        assertEq(u, 950e18);
        assertGt(s, 0);
        assertApproxEqAbs(sv, FILL, 1e12);
        assertEq(y, 0);
    }

    function test_CooldownAfterProtection() public {
        uint256 id = makePlan(); // cooldown 7200s
        skip(CADENCE + 1);
        vm.prank(keeper);
        vault.executeDCA(id); // long @ $180
        feed.setPrice(162e8); // -10% crash
        vm.prank(keeper);
        assertEq(vault.executeProtection(id), 1); // stopped
        // Must NOT buy straight back into the crash.
        skip(CADENCE + 1);
        vm.prank(keeper);
        (bool executed, uint8 reason) = vault.executeDCA(id);
        assertFalse(executed);
        assertEq(reason, guard.REASON_COOLDOWN());
        // After cooldown elapses, DCA resumes.
        skip(7200);
        feed.setPrice(162e8); // fresh print at same level
        vm.prank(keeper);
        (executed,) = vault.executeDCA(id);
        assertTrue(executed);
    }

    function test_SlippageCapRejected() public {
        vm.prank(user);
        vm.expectRevert("Batpilot: slip too wide");
        vault.createPlan(address(nvda), address(feed), FILL, CADENCE, 800, 2000, 3600, 500, 2001, 7200);
    }

    function test_MinOutViews() public {
        // $50 @ $180, 2% slip, 18d USDG: 50e18*1e8/180e8 = 0.2777e18 -> 0.2722e18.
        uint256 m = vault.minStockOut(50e18, uint256(P0), 200);
        assertApproxEqAbs(m, (50e18 * 1e8) / uint256(P0) * 9800 / 10_000, 1);
        uint256 u = vault.minUsdgOut(1e18, uint256(P0), 200);
        assertApproxEqAbs(u, (1e18 * uint256(P0)) / 1e8 * 9800 / 10_000, 1);
    }

    function test_SixDecimalVaultFill() public {
        // Production-shaped stack: 6-decimal USDG end to end.
        MockUSDG6 u6 = new MockUSDG6();
        MockSwapRouter r6 = new MockSwapRouter(address(u6));
        r6.setFeed(address(nvda), address(feed));
        MockYieldVault y6 = new MockYieldVault(address(u6));
        BatpilotVault v6 = new BatpilotVault(address(u6), address(guard), address(r6), address(y6), 6);
        nvda.mint(address(r6), 1_000_000e18);
        u6.mint(address(r6), 1_000_000e6);
        u6.mint(user, 10_000e6);

        vm.startPrank(user);
        u6.approve(address(v6), type(uint256).max);
        uint256 id = v6.createPlan(address(nvda), address(feed), 50e6, CADENCE, 800, 2000, 3600, 0, 200, 7200);
        v6.fundPlan(id, 1000e6);
        vm.stopPrank();

        skip(CADENCE + 1);
        (bool executed,) = v6.executeDCA(id);
        assertTrue(executed);
        (,,,,,,,,,, uint256 usdgBal, uint256 stockBal,,,,,,,,) = v6.plans(id);
        assertEq(usdgBal, 950e6);
        assertGt(stockBal, 0);
        // minOut view matches the 6d scaling the vault used.
        assertEq(v6.minStockOut(50e6, uint256(P0), 200), (50e6 * 1e8) / uint256(P0) * 1e12 * 9800 / 10_000);
    }
}
