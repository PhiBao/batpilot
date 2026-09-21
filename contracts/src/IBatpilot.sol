// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Batpilot shared interfaces
/// @notice Chainlink-compatible feed, ERC-8056 stock token, router, yield vault, guard.

interface IChainlinkFeed {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

interface IStockToken {
    /// @notice ERC-8056 scaled-UI-amount multiplier. Raw balances never rebase;
    /// splits/dividends change this multiplier instead.
    function uiMultiplier() external view returns (uint256);
}

interface ISwapRouter {
    function swapUSDGForStock(address stock, uint256 usdgIn, uint256 minStockOut)
        external
        returns (uint256 stockOut);
    function swapStockForUSDG(address stock, uint256 stockIn, uint256 minUsdgOut)
        external
        returns (uint256 usdgOut);
}

interface IYieldVault {
    function deposit(uint256 assets) external returns (uint256 shares);
    function withdraw(uint256 shares) external returns (uint256 assets);
    function previewRedeem(uint256 shares) external view returns (uint256 assets);
}

interface ISessionGuard {
    function evaluate(
        uint256 price,
        uint256 updatedAt,
        uint256 nowTs,
        uint256 maxStaleSec,
        uint256 refPrice,
        uint256 bandBps,
        bool paused
    ) external pure returns (bool allowed, uint8 reason);
}
