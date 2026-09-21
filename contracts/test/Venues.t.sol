// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {UniswapV3Adapter} from "../src/UniswapV3Adapter.sol";
import {MorphoEarnAdapter} from "../src/MorphoEarnAdapter.sol";

/// @notice Production adapters vs REAL Robinhood Chain mainnet state.
/// forge test --match-contract BatpilotVenuesTest --fork-url <RHC mainnet QN>
/// Proves: real USDG -> NVDA swap through the real Uniswap v3 pool with
/// oracle-anchored slippage guard, + real deposit into the Steakhouse Earn vault.
contract BatpilotVenuesTest is Test {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant NVDA_FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address constant SWAP_ROUTER_02 = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant STEAKHOUSE_USDG = 0xBeEff033F34C046626B8D0A041844C5d1A5409dd;

    UniswapV3Adapter adapter;
    MorphoEarnAdapter earn;
    address user = makeAddr("venueuser");

    function setUp() public {
        require(block.chainid == 4663, "needs RHC mainnet fork");
        adapter = new UniswapV3Adapter(SWAP_ROUTER_02, USDG);
        adapter.setFeed(NVDA, NVDA_FEED);
        earn = new MorphoEarnAdapter(STEAKHOUSE_USDG);
        deal(USDG, user, 10_000e6);
    }

    function test_RealSwapUSDGForNVDA() public {
        uint256 usdgIn = 50e6; // $50 real USDG
        vm.startPrank(user);
        IERC20(USDG).approve(address(adapter), usdgIn);
        uint256 out = adapter.swapUSDGForStock(NVDA, usdgIn, 0);
        vm.stopPrank();

        assertGt(out, 0);
        // Sanity: within 5% of feed-implied amount (pool is thin, guard band is 2%).
        (, int256 price,,,) = IFeedLike(NVDA_FEED).latestRoundData();
        uint256 fair = (usdgIn * 1e8 * 1e12) / uint256(price);
        assertApproxEqRel(out, fair, 0.05e18);
        assertEq(IERC20(NVDA).balanceOf(user), out);
    }

    function test_RealSwapNVDABackToUSDG() public {
        uint256 usdgIn = 50e6;
        vm.startPrank(user);
        IERC20(USDG).approve(address(adapter), usdgIn);
        uint256 stock = adapter.swapUSDGForStock(NVDA, usdgIn, 0);
        IERC20(NVDA).approve(address(adapter), stock);
        uint256 back = adapter.swapStockForUSDG(NVDA, stock, 0);
        vm.stopPrank();

        // Round-trip through a thin pool: expect most of the $50 back.
        assertApproxEqRel(back, usdgIn, 0.10e18);
    }

    function test_RealEarnDepositAndWithdraw() public {
        uint256 amt = 100e6;
        vm.startPrank(user);
        IERC20(USDG).approve(address(earn), amt);
        uint256 shares = earn.deposit(amt);
        vm.stopPrank();

        assertGt(shares, 0);
        assertGe(earn.previewRedeem(shares), amt - 1); // no haircut on entry

        uint256 before = IERC20(USDG).balanceOf(user);
        vm.prank(user);
        earn.withdraw(shares);
        assertGe(IERC20(USDG).balanceOf(user) - before, amt - 2);
    }
}

interface IFeedLike {
    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80);
}
