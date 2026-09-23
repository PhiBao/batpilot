// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IChainlinkFeed, IStockToken, ISwapRouter, IYieldVault, ISessionGuard} from "./IBatpilot.sol";
import {SessionGuard} from "./SessionGuard.sol";

/// @title BatpilotVault — non-custodial stock autopilot
/// @notice Recurring USDG -> stock-token buys + stop-loss / take-profit
/// protection, enforced by a session-aware guard, settled in USDG, with idle
/// USDG sweepable to yield. Execution is permissionless: anyone (keeper,
/// user, judge) may call executeDCA / executeProtection when conditions are
/// met — the contracts, not the caller, decide. The keeper is untrusted.
contract BatpilotVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Plan {
        address owner;
        address stock;
        address feed;
        uint256 amountPerFill; // USDG wei per scheduled buy
        uint256 cadenceSec; // seconds between fills
        uint256 stopLossBps; // 0 = disabled
        uint256 takeProfitBps; // 0 = disabled
        uint256 maxStaleSec; // oracle freshness requirement
        uint256 bandBps; // max move vs last price per fill, 0 = disabled
        uint256 slipBps; // max slippage vs oracle on execution, e.g. 200 = 2%
        uint256 usdgBalance; // free USDG in plan
        uint256 stockBalance; // stock wei held for plan
        uint256 entryAvg; // weighted avg fill price, feed decimals
        uint256 lastFill;
        uint256 uiSnapshot; // ERC-8056 multiplier at plan creation
        uint256 yieldShares; // shares in yield vault
        bool active;
        bool paused; // corporate-action pause
        uint256 cooldownUntil; // no buys before this (set on protection sale)
        uint256 cooldownSec; // pause length after each protection sale
    }

    IERC20 public immutable USDG;
    ISessionGuard public immutable GUARD;
    ISwapRouter public immutable ROUTER;
    IYieldVault public immutable YIELD;
    uint8 public immutable USDG_DECIMALS; // 18 (mocks) or 6 (real USDG)

    uint256 public planCount;

    mapping(uint256 => Plan) public plans;

    event PlanCreated(uint256 indexed planId, address indexed owner, address stock, uint256 amountPerFill);
    event Funded(uint256 indexed planId, uint256 amount);
    event Fill(
        uint256 indexed planId, uint256 usdgIn, uint256 stockOut, uint256 price, uint256 feedTs
    );
    event GuardRejected(uint256 indexed planId, uint8 reason, uint256 price, uint256 feedTs);
    event Protected(uint256 indexed planId, uint8 kind, uint256 stockSold, uint256 usdgOut, uint256 price);
    event ProtectionSkipped(uint256 indexed planId, uint8 reason);
    event Swept(uint256 indexed planId, uint256 assets, uint256 shares);
    event Unswept(uint256 indexed planId, uint256 shares, uint256 assets);
    event CorporateActionPause(uint256 indexed planId, uint256 oldMultiplier, uint256 newMultiplier);
    event Cancelled(uint256 indexed planId, uint256 usdgReturned);

    error NotOwner();
    error Inactive();
    error ZeroAmount();
    error InsufficientBalance();

    constructor(address usdg, address guard, address router, address yieldVault, uint8 usdgDecimals) {
        USDG = IERC20(usdg);
        GUARD = ISessionGuard(guard);
        ROUTER = ISwapRouter(router);
        YIELD = IYieldVault(yieldVault);
        USDG_DECIMALS = usdgDecimals;
    }

    /// @notice Create a plan. Caller must have approved nothing yet; funding is separate.
    function createPlan(
        address stock,
        address feed,
        uint256 amountPerFill,
        uint256 cadenceSec,
        uint256 stopLossBps,
        uint256 takeProfitBps,
        uint256 maxStaleSec,
        uint256 bandBps,
        uint256 slipBps,
        uint256 cooldownSec
    ) external returns (uint256 planId) {
        if (amountPerFill == 0) revert ZeroAmount();
        if (cadenceSec == 0) revert ZeroAmount();
        require(stockLossSane(stopLossBps) && takeProfitSane(takeProfitBps), "Batpilot: bad bps");
        require(slipBps <= 2000, "Batpilot: slip too wide");
        require(cooldownSec <= 30 days, "Batpilot: cooldown too long");

        planId = planCount++;
        uint256 mult = 1e18;
        try IStockToken(stock).uiMultiplier() returns (uint256 m) {
            if (m > 0) mult = m;
        } catch {}

        plans[planId] = Plan({
            owner: msg.sender,
            stock: stock,
            feed: feed,
            amountPerFill: amountPerFill,
            cadenceSec: cadenceSec,
            stopLossBps: stopLossBps,
            takeProfitBps: takeProfitBps,
            maxStaleSec: maxStaleSec,
            bandBps: bandBps,
            slipBps: slipBps,
            usdgBalance: 0,
            stockBalance: 0,
            entryAvg: 0,
            lastFill: block.timestamp,
            uiSnapshot: mult,
            yieldShares: 0,
            active: true,
            paused: false,
            cooldownUntil: 0,
            cooldownSec: cooldownSec
        });
        emit PlanCreated(planId, msg.sender, stock, amountPerFill);
    }

    function fundPlan(uint256 planId, uint256 amount) external nonReentrant {
        Plan storage p = plans[planId];
        if (!p.active) revert Inactive();
        if (amount == 0) revert ZeroAmount();
        USDG.safeTransferFrom(msg.sender, address(this), amount);
        p.usdgBalance += amount;
        emit Funded(planId, amount);
    }

    /// @notice Execute one scheduled buy. Permissionless.
    /// @return executed True when a fill happened.
    /// @return reason Guard reason code (0 on success or not-due).
    function executeDCA(uint256 planId) external nonReentrant returns (bool executed, uint8 reason) {
        Plan storage p = plans[planId];
        if (!p.active) revert Inactive();
        // Cooling down after a protection sale: never buy straight back
        // into the crash that just stopped us out.
        if (block.timestamp < p.cooldownUntil) {
            (, int256 cdAnswer,, uint256 cdTs,) =
                IChainlinkFeed(p.feed).latestRoundData();
            uint256 cdPrice = cdAnswer > 0 ? uint256(cdAnswer) : 0;
            emit GuardRejected(planId, SessionGuard(address(GUARD)).REASON_COOLDOWN(), cdPrice, cdTs);
            return (false, 5);
        }
        if (block.timestamp < p.lastFill + p.cadenceSec) return (false, 0); // not due yet
        if (p.usdgBalance < p.amountPerFill) revert InsufficientBalance();

        (, int256 answer,, uint256 updatedAt,) =
            IChainlinkFeed(p.feed).latestRoundData();
        uint256 price = answer > 0 ? uint256(answer) : 0;

        // Corporate-action tripwire: ERC-8056 multiplier changed -> pause, never fill blind.
        uint256 mult = 1e18;
        try IStockToken(p.stock).uiMultiplier() returns (uint256 m) {
            if (m > 0) mult = m;
        } catch {}
        if (mult != p.uiSnapshot) {
            p.paused = true;
            emit CorporateActionPause(planId, p.uiSnapshot, mult);
            emit GuardRejected(planId, SessionGuard(address(GUARD)).REASON_PAUSED(), price, updatedAt);
            return (false, 2);
        }

        uint256 refPrice = p.entryAvg; // 0 on first fill -> band check disabled
        (bool ok, uint8 r) = GUARD.evaluate(
            price, updatedAt, block.timestamp, p.maxStaleSec, refPrice, p.bandBps, p.paused
        );
        if (!ok) {
            emit GuardRejected(planId, r, price, updatedAt);
            return (false, r);
        }

        USDG.forceApprove(address(ROUTER), p.amountPerFill);
        uint256 stockOut =
            ROUTER.swapUSDGForStock(p.stock, p.amountPerFill, minStockOut(p.amountPerFill, price, p.slipBps));

        // Weighted average entry price.
        uint256 prevValue = p.stockBalance * p.entryAvg;
        uint256 newValue = stockOut * price;
        p.stockBalance += stockOut;
        p.entryAvg = p.stockBalance > 0 ? (prevValue + newValue) / p.stockBalance : price;
        p.usdgBalance -= p.amountPerFill;
        p.lastFill = block.timestamp;

        emit Fill(planId, p.amountPerFill, stockOut, price, updatedAt);
        return (true, 0);
    }

    /// @notice Check + execute stop-loss / take-profit. Permissionless.
    /// @return code 0 = nothing, 1 = stopped, 2 = profited, 3 = skipped (stale/invalid).
    function executeProtection(uint256 planId) external nonReentrant returns (uint8 code) {
        Plan storage p = plans[planId];
        if (!p.active) revert Inactive();
        if (p.stockBalance == 0 || p.entryAvg == 0) return 0;

        (, int256 answer,, uint256 updatedAt,) =
            IChainlinkFeed(p.feed).latestRoundData();
        uint256 price = answer > 0 ? uint256(answer) : 0;

        // Protection NEVER acts on stale or invalid prices.
        if (price == 0 || updatedAt == 0 || block.timestamp > updatedAt + p.maxStaleSec) {
            emit ProtectionSkipped(planId, 1);
            return 3;
        }
        if (p.paused) {
            emit ProtectionSkipped(planId, 2);
            return 3;
        }

        (bool stopHit, bool takeHit) = SessionGuard(address(GUARD)).evaluateProtection(
            price, p.entryAvg, p.stopLossBps, p.takeProfitBps
        );
        if (!stopHit && !takeHit) return 0;

        uint256 stockIn = p.stockBalance;
        IERC20(p.stock).forceApprove(address(ROUTER), stockIn);
        uint256 usdgOut =
            ROUTER.swapStockForUSDG(p.stock, stockIn, minUsdgOut(stockIn, price, p.slipBps));
        p.stockBalance = 0;
        p.usdgBalance += usdgOut;
        // Reset entry so a later re-entry starts clean; keep plan active for DCA to resume.
        p.entryAvg = 0;
        // Cool down: don't buy straight back into the move that stopped us out.
        if (p.cooldownSec > 0) p.cooldownUntil = block.timestamp + p.cooldownSec;

        uint8 kind = stopHit ? 1 : 2;
        emit Protected(planId, kind, stockIn, usdgOut, price);
        return kind;
    }

    /// @notice Sweep idle plan USDG into the yield vault (e.g. USDG Earn).
    function sweepToYield(uint256 planId, uint256 amount) external nonReentrant {
        Plan storage p = plans[planId];
        if (msg.sender != p.owner) revert NotOwner();
        if (!p.active) revert Inactive();
        if (amount == 0 || amount > p.usdgBalance) revert InsufficientBalance();
        p.usdgBalance -= amount;
        USDG.forceApprove(address(YIELD), amount);
        uint256 shares = YIELD.deposit(amount);
        p.yieldShares += shares;
        emit Swept(planId, amount, shares);
    }

    function withdrawFromYield(uint256 planId, uint256 shares) external nonReentrant {
        Plan storage p = plans[planId];
        if (msg.sender != p.owner) revert NotOwner();
        if (shares == 0 || shares > p.yieldShares) revert InsufficientBalance();
        p.yieldShares -= shares;
        uint256 assets = YIELD.withdraw(shares);
        p.usdgBalance += assets;
        emit Unswept(planId, shares, assets);
    }

    /// @notice Full exit: sell stock, redeem yield, return all USDG. Owner only.
    function cancelPlan(uint256 planId) external nonReentrant {
        Plan storage p = plans[planId];
        if (msg.sender != p.owner) revert NotOwner();
        if (!p.active) revert Inactive();

        if (p.stockBalance > 0) {
            IERC20(p.stock).forceApprove(address(ROUTER), p.stockBalance);
            (, int256 exitAnswer,,,) = IChainlinkFeed(p.feed).latestRoundData();
            uint256 exitFloor = exitAnswer > 0
                ? minUsdgOut(p.stockBalance, uint256(exitAnswer), 500)
                : 0;
            uint256 out = ROUTER.swapStockForUSDG(p.stock, p.stockBalance, exitFloor);
            p.usdgBalance += out;
            p.stockBalance = 0;
        }
        if (p.yieldShares > 0) {
            uint256 assets = YIELD.withdraw(p.yieldShares);
            p.usdgBalance += assets;
            p.yieldShares = 0;
        }
        uint256 ret = p.usdgBalance;
        p.usdgBalance = 0;
        p.active = false;
        USDG.safeTransfer(p.owner, ret);
        emit Cancelled(planId, ret);
    }

    /// @notice Plan equity snapshot: (free USDG, stock wei, stock USD value @feed, yield USD value).
    function planEquity(uint256 planId)
        external
        view
        returns (uint256 usdg, uint256 stock, uint256 stockValue, uint256 yieldValue)
    {
        Plan storage p = plans[planId];
        usdg = p.usdgBalance;
        stock = p.stockBalance;
        (, int256 answer,,,) = IChainlinkFeed(p.feed).latestRoundData();
        if (answer > 0 && stock > 0) {
            // feed has 8 decimals: value(1e18 USDG wei) = stock * price / 1e8
            stockValue = (stock * uint256(answer)) / 1e8;
        }
        if (p.yieldShares > 0) {
            yieldValue = YIELD.previewRedeem(p.yieldShares);
        }
    }

    function stockLossSane(uint256 bps) internal pure returns (bool) {
        return bps <= 10_000;
    }

    /// @notice Oracle-implied minimum stock out for a USDG spend, haircut by
    /// slipBps. Scales 6-decimal USDG up to 18-decimal stock math.
    function minStockOut(uint256 usdgIn, uint256 price, uint256 slipBps)
        public
        view
        returns (uint256)
    {
        uint256 fair = (usdgIn * 1e8) / price;
        if (USDG_DECIMALS == 6) fair *= 1e12;
        return (fair * (10_000 - slipBps)) / 10_000;
    }

    /// @notice Oracle-implied minimum USDG out for a stock sale, haircut by
    /// slipBps. Scales 18-decimal stock math down to 6-decimal USDG.
    function minUsdgOut(uint256 stockIn, uint256 price, uint256 slipBps)
        public
        view
        returns (uint256)
    {
        uint256 fair = (stockIn * price) / 1e8;
        if (USDG_DECIMALS == 6) fair /= 1e12;
        return (fair * (10_000 - slipBps)) / 10_000;
    }

    function takeProfitSane(uint256 bps) internal pure returns (bool) {
        return bps <= 100_000; // up to 10x
    }
}
