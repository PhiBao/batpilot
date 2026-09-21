// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IChainlinkFeed, ISwapRouter} from "./IBatpilot.sol";

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

/// @title UniswapV3Adapter — production ISwapRouter over Uniswap v3 pools
/// @notice Routes USDG <-> stock-token swaps through SwapRouter02 single-hop
/// pools, with oracle-anchored slippage protection: every fill is checked
/// against the stock's Chainlink feed, so a sandwich or stale pool can't move
/// execution beyond `slippageBps` of fair value. Fee tier per stock is
/// owner-configurable (default 500 = 0.05%).
contract UniswapV3Adapter is ISwapRouter {
    using SafeERC20 for IERC20;

    ISwapRouter02 public immutable ROUTER02;
    IERC20 public immutable USDG;

    address public owner;
    mapping(address => address) public feedOf; // stock => chainlink feed
    mapping(address => uint24) public feeOf; // stock => pool fee (default 500)
    uint256 public slippageBps = 200; // 2% default guard band

    event FeedSet(address indexed stock, address indexed feed);
    event FeeSet(address indexed stock, uint24 fee);
    event SlippageSet(uint256 bps);
    event OwnerSet(address indexed owner);

    modifier onlyOwner() {
        require(msg.sender == owner, "U3Adapter: not owner");
        _;
    }

    constructor(address router02, address usdg) {
        ROUTER02 = ISwapRouter02(router02);
        USDG = IERC20(usdg);
        owner = msg.sender;
    }

    function setOwner(address o) external onlyOwner {
        owner = o;
        emit OwnerSet(o);
    }

    function setFeed(address stock, address feed) external onlyOwner {
        feedOf[stock] = feed;
        emit FeedSet(stock, feed);
    }

    function setFee(address stock, uint24 fee) external onlyOwner {
        feeOf[stock] = fee;
        emit FeeSet(stock, fee);
    }

    function setSlippage(uint256 bps) external onlyOwner {
        require(bps <= 1000, "U3Adapter: band too wide");
        slippageBps = bps;
        emit SlippageSet(bps);
    }

    function poolFee(address stock) public view returns (uint24) {
        uint24 f = feeOf[stock];
        return f == 0 ? 500 : f;
    }

    /// @notice Fair-value floor/ceiling from the feed, scaled to token decimals.
    function minOut(address tokenOut, uint256 amountIn, uint256 feedPrice, uint8 dir)
        internal
        view
        returns (uint256)
    {
        // dir 0: USDG -> stock (stockOut = usdgIn * 1e8 / price, 18d stock)
        // dir 1: stock -> USDG (usdgOut = stockIn * price / 1e8, 6d USDG)
        uint256 fair;
        if (dir == 0) {
            fair = (amountIn * 1e8) / feedPrice;
            fair = (fair * 1e12); // 6d USDG in -> 18d stock out
        } else {
            fair = (amountIn * feedPrice) / 1e8;
            fair = fair / 1e12; // 18d stock in -> 6d USDG out
        }
        return (fair * (10_000 - slippageBps)) / 10_000;
    }

    function readPrice(address stock) internal view returns (uint256) {
        (, int256 answer,,,) = IChainlinkFeed(feedOf[stock]).latestRoundData();
        require(answer > 0, "U3Adapter: bad oracle");
        return uint256(answer);
    }

    function swapUSDGForStock(address stock, uint256 usdgIn, uint256 minStockOut)
        external
        returns (uint256 stockOut)
    {
        require(feedOf[stock] != address(0), "U3Adapter: no feed");
        uint256 floor = minOut(stock, usdgIn, readPrice(stock), 0);
        if (minStockOut > floor) floor = minStockOut;

        USDG.safeTransferFrom(msg.sender, address(this), usdgIn);
        USDG.forceApprove(address(ROUTER02), usdgIn);

        stockOut = ROUTER02.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: address(USDG),
                tokenOut: stock,
                fee: poolFee(stock),
                recipient: msg.sender,
                amountIn: usdgIn,
                amountOutMinimum: floor,
                sqrtPriceLimitX96: 0
            })
        );
    }

    function swapStockForUSDG(address stock, uint256 stockIn, uint256 minUsdgOut)
        external
        returns (uint256 usdgOut)
    {
        require(feedOf[stock] != address(0), "U3Adapter: no feed");
        uint256 floor = minOut(stock, stockIn, readPrice(stock), 1);
        if (minUsdgOut > floor) floor = minUsdgOut;

        IERC20(stock).safeTransferFrom(msg.sender, address(this), stockIn);
        IERC20(stock).forceApprove(address(ROUTER02), stockIn);

        usdgOut = ROUTER02.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: stock,
                tokenOut: address(USDG),
                fee: poolFee(stock),
                recipient: msg.sender,
                amountIn: stockIn,
                amountOutMinimum: floor,
                sqrtPriceLimitX96: 0
            })
        );
    }
}
