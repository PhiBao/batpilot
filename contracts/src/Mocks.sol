// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IChainlinkFeed, IStockToken, ISwapRouter, IYieldVault} from "./IBatpilot.sol";

/// @notice Mintable mock USDG (18 decimals).
contract MockUSDG is ERC20 {
    constructor() ERC20("Mock USDG", "mUSDG") {}
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Mock tokenized stock: ERC20 + ERC-8056 uiMultiplier (settable to
/// simulate splits / corporate actions).
contract MockStockToken is ERC20, IStockToken {
    uint256 private _mult = 1e18;

    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}

    function uiMultiplier() external view returns (uint256) {
        return _mult;
    }

    function setMultiplier(uint256 m) external {
        _mult = m;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Mock Chainlink feed (8 decimals) with controllable price + timestamp.
contract MockFeed is IChainlinkFeed {
    int256 public answer;
    uint256 public updatedAt;

    constructor(int256 initialPrice) {
        answer = initialPrice;
        updatedAt = block.timestamp;
    }

    function setPrice(int256 p) external {
        answer = p;
        updatedAt = block.timestamp;
    }

    function setStale(int256 p, uint256 ts) external {
        answer = p;
        updatedAt = ts;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (1, answer, updatedAt, updatedAt, 1);
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }
}

/// @notice Mock AMM router priced off registered feeds.
/// price P (8d) = USD per whole stock token.
/// stockOut = usdgIn * 1e8 / P ; usdgOut = stockIn * P / 1e8.
contract MockSwapRouter is ISwapRouter {
    using SafeERC20 for IERC20;

    IERC20 public immutable USDG;
    mapping(address => address) public feedOf; // stock => feed

    constructor(address usdg) {
        USDG = IERC20(usdg);
    }

    function setFeed(address stock, address feed) external {
        feedOf[stock] = feed;
    }

    function priceOf(address stock) public view returns (uint256) {
        (, int256 answer,,,) = IChainlinkFeed(feedOf[stock]).latestRoundData();
        require(answer > 0, "MockRouter: bad price");
        return uint256(answer);
    }

    function swapUSDGForStock(address stock, uint256 usdgIn, uint256 minStockOut)
        external
        returns (uint256 stockOut)
    {
        stockOut = (usdgIn * 1e8) / priceOf(stock);
        require(stockOut >= minStockOut, "MockRouter: slippage");
        USDG.safeTransferFrom(msg.sender, address(this), usdgIn);
        IERC20(stock).safeTransfer(msg.sender, stockOut);
    }

    function swapStockForUSDG(address stock, uint256 stockIn, uint256 minUsdgOut)
        external
        returns (uint256 usdgOut)
    {
        usdgOut = (stockIn * priceOf(stock)) / 1e8;
        require(usdgOut >= minUsdgOut, "MockRouter: slippage");
        IERC20(stock).safeTransferFrom(msg.sender, address(this), stockIn);
        USDG.safeTransfer(msg.sender, usdgOut);
    }
}

/// @notice Mock yield vault (~7% APR) with ERC4626-style redeem preview.
/// Interest accrues lazily via a growing exchange rate.
contract MockYieldVault is ERC20, IYieldVault {
    using SafeERC20 for IERC20;

    IERC20 public immutable ASSET;
    uint256 public rate = 1e18; // assets per share, 1e18 scale
    uint256 public lastAccrual;
    uint256 public constant APR_BPS = 700; // ~7%

    constructor(address asset) ERC20("Mock Earn USDG", "meUSDG") {
        ASSET = IERC20(asset);
        lastAccrual = block.timestamp;
    }

    function _accrue() internal {
        uint256 dt = block.timestamp - lastAccrual;
        if (dt > 0 && totalSupply() > 0) {
            rate += (rate * APR_BPS * dt) / (10_000 * 365 days);
        }
        lastAccrual = block.timestamp;
    }

    function deposit(uint256 assets) external returns (uint256 shares) {
        _accrue();
        shares = (assets * 1e18) / rate;
        ASSET.safeTransferFrom(msg.sender, address(this), assets);
        _mint(msg.sender, shares);
    }

    function withdraw(uint256 shares) external returns (uint256 assets) {
        _accrue();
        assets = (shares * rate) / 1e18;
        _burn(msg.sender, shares);
        ASSET.safeTransfer(msg.sender, assets);
    }

    function previewRedeem(uint256 shares) external view returns (uint256 assets) {
        uint256 dt = block.timestamp - lastAccrual;
        uint256 r = rate;
        if (dt > 0 && totalSupply() > 0) {
            r += (r * APR_BPS * dt) / (10_000 * 365 days);
        }
        assets = (shares * r) / 1e18;
    }
}
