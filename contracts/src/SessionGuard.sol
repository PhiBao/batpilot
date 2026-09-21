// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ISessionGuard} from "./IBatpilot.sol";

/// @title SessionGuard — reference implementation of Batpilot's execution firewall
/// @notice Decides whether an automated fill may proceed given oracle freshness,
/// session bands, and pause state. NEVER fills blind: stale or invalid prices
/// are rejected, never acted on. A gas-optimized Stylus (Rust) port with
/// identical semantics is the production engine; this contract is the
/// auditable reference + testnet deployment.
contract SessionGuard is ISessionGuard {
    uint8 public constant REASON_ALLOW = 0;
    uint8 public constant REASON_STALE = 1;
    uint8 public constant REASON_PAUSED = 2;
    uint8 public constant REASON_BAND_BREACH = 3;
    uint8 public constant REASON_INVALID_PRICE = 4;

    /// @notice Evaluate a single fill.
    /// @param price Feed answer, already validated > 0 by caller convention.
    /// @param updatedAt Feed updatedAt timestamp.
    /// @param nowTs Current block timestamp (passed in for testability / Stylus parity).
    /// @param maxStaleSec Max acceptable feed age. Equity feeds follow market
    /// hours — fills outside fresh sessions are rejected, not guessed.
    /// @param refPrice Reference price (last fill / entry avg). 0 disables band check.
    /// @param bandBps Max allowed move vs refPrice, in bps. 0 disables band check.
    /// @param paused Corporate-action or owner pause flag.
    function evaluate(
        uint256 price,
        uint256 updatedAt,
        uint256 nowTs,
        uint256 maxStaleSec,
        uint256 refPrice,
        uint256 bandBps,
        bool paused
    ) public pure returns (bool allowed, uint8 reason) {
        if (paused) return (false, REASON_PAUSED);
        if (price == 0) return (false, REASON_INVALID_PRICE);
        if (updatedAt == 0 || nowTs > updatedAt + maxStaleSec) {
            return (false, REASON_STALE);
        }
        if (refPrice > 0 && bandBps > 0) {
            uint256 diff = price > refPrice ? price - refPrice : refPrice - price;
            // diff/refPrice > bandBps  <=>  diff*10000 > refPrice*bandBps
            if (diff * 10_000 > refPrice * bandBps) {
                return (false, REASON_BAND_BREACH);
            }
        }
        return (true, REASON_ALLOW);
    }

    /// @notice Protection evaluation: has price breached stop-loss or take-profit
    /// relative to the position's average entry?
    /// @return stopHit True when loss >= stopLossBps.
    /// @return takeHit True when gain >= takeProfitBps.
    function evaluateProtection(
        uint256 current,
        uint256 entryAvg,
        uint256 stopLossBps,
        uint256 takeProfitBps
    ) public pure returns (bool stopHit, bool takeHit) {
        if (current == 0 || entryAvg == 0) return (false, false);
        if (current < entryAvg && stopLossBps > 0) {
            if ((entryAvg - current) * 10_000 >= entryAvg * stopLossBps) stopHit = true;
        } else if (current > entryAvg && takeProfitBps > 0) {
            if ((current - entryAvg) * 10_000 >= entryAvg * takeProfitBps) takeHit = true;
        }
    }

    /// @notice Batch-guard for keepers scanning many plans in one call.
    /// This loop is the compute-heavy path the Stylus port accelerates.
    function batchEvaluate(
        uint256[] calldata prices,
        uint256[] calldata updatedAts,
        uint256 nowTs,
        uint256 maxStaleSec,
        uint256[] calldata refPrices,
        uint256 bandBps,
        bool paused
    ) external pure returns (bool[] memory allowed, uint8[] memory reasons) {
        uint256 n = prices.length;
        require(
            updatedAts.length == n && refPrices.length == n,
            "SessionGuard: length mismatch"
        );
        allowed = new bool[](n);
        reasons = new uint8[](n);
        for (uint256 i = 0; i < n; i++) {
            (allowed[i], reasons[i]) =
                evaluate(prices[i], updatedAts[i], nowTs, maxStaleSec, refPrices[i], bandBps, paused);
        }
    }
}
