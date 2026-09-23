// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IPoolManagerProbe {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
    function getLiquidity(bytes32 poolId) external view returns (uint256);
}

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// @notice Read-only probe: which Uniswap v4 USDG/stock pools exist with liquidity?
/// forge test --match-contract V4Probe --fork-url <RHC mainnet> -vv
contract V4Probe is Test {
    address constant PM = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;
    address constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;

    function poolId(address a, address b, uint24 fee, int24 ts) internal pure returns (bytes32) {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        return keccak256(abi.encode(PoolKey(c0, c1, fee, ts, address(0))));
    }

    function check(address stock, uint24 fee, int24 ts) internal {
        bytes32 id = poolId(USDG, stock, fee, ts);
        try IPoolManagerProbe(PM).getSlot0(id) returns (uint160 sqrtP, int24 tick, uint24, uint24) {
            if (sqrtP == 0) {
                console.log("uninitialized");
                return;
            }
            uint256 liq = IPoolManagerProbe(PM).getLiquidity(id);
            console.log("sqrtPrice:", uint256(sqrtP));
            console.log("tick:", uint256(int256(tick)));
            console.log("liquidity:", liq);
            // token balances held by PM for each currency
            console.log(" kraken0:", IERC20(stock < USDG ? stock : USDG).balanceOf(PM));
        } catch {
            console.log("no pool");
        }
    }

    function test_Probe() public {
        require(block.chainid == 4663, "RHC mainnet fork only");
        address[3] memory stocks = [NVDA, TSLA, AAPL];
        for (uint256 s = 0; s < 3; s++) {
            console.log("=== stock ===");
            console.log(stocks[s]);
            console.log("-- fee500/ts10 --");
            check(stocks[s], 500, 10);
            console.log("-- fee3000/ts60 --");
            check(stocks[s], 3000, 60);
            console.log("-- fee10000/ts200 --");
            check(stocks[s], 10000, 200);
        }
    }
}
