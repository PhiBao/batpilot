// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IChainlinkFeed} from "./IBatpilot.sol";
import {SessionGuard} from "./SessionGuard.sol";

/// @title SessionVolEngine — volatility-adaptive execution firewall
/// @notice Static bands fail in both directions: they false-refuse calm trends
/// and wave through regime breaks. This engine derives the per-fill band from
/// realized volatility measured trustlessly from the feed's own round history
/// (getRoundData walk, no keeper-supplied data), so bands breathe with the
/// market: tight mid-session, wide at the open, refused when history is thin.
///
/// band = min(maxBand, baseBand + volMult * volBps / 10_000)
/// where volBps = sqrt(mean squared simple returns in bps) over the window.
///
/// The integer math (per-round ratios, variance accumulation, Babylonian
/// square root) is the compute-dense core the Stylus port accelerates;
/// see stylus-guard vol_band with published benchmarks.
contract SessionVolEngine {
    struct Cfg {
        uint256 baseBandBps; // floor band, e.g. 200 = 2%
        uint256 volMultBps; // band widening per unit vol, e.g. 100_00 = 1x
        uint256 windowRounds; // lookback, e.g. 12
        uint256 maxBandBps; // ceiling, e.g. 2000 = 20%
        uint256 maxStaleSec; // freshness bound (same semantics as SessionGuard)
    }

    SessionGuard public immutable GUARD;
    address public owner;
    mapping(address => Cfg) public cfgOf; // feed => config

    event ConfigSet(address indexed feed, uint256 base, uint256 mult, uint256 window, uint256 max);
    event OwnerSet(address indexed owner);

    modifier onlyOwner() {
        require(msg.sender == owner, "VolEngine: not owner");
        _;
    }

    constructor(address guard) {
        GUARD = SessionGuard(guard);
        owner = msg.sender;
    }

    function setOwner(address o) external onlyOwner {
        owner = o;
        emit OwnerSet(o);
    }

    function setConfig(
        address feed,
        uint256 baseBandBps,
        uint256 volMultBps,
        uint256 windowRounds,
        uint256 maxBandBps,
        uint256 maxStaleSec
    ) external onlyOwner {
        require(windowRounds >= 2 && windowRounds <= 48, "VolEngine: bad window");
        require(maxBandBps <= 10_000, "VolEngine: band too wide");
        cfgOf[feed] = Cfg(baseBandBps, volMultBps, windowRounds, maxBandBps, maxStaleSec);
        emit ConfigSet(feed, baseBandBps, volMultBps, windowRounds, maxBandBps);
    }

    /// @notice Babylonian integer square root.
    function isqrt(uint256 x) public pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        uint256 y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
        return y;
    }

    /// @notice Realized volatility in bps over the trailing window, read purely
    /// from round history. Skips invalid rounds; returns (volBps, roundsUsed).
    function realizedVol(address feed, uint256 window)
        public
        view
        returns (uint256 volBps, uint256 roundsUsed)
    {
        (uint80 latest,,,,) = IChainlinkFeed(feed).latestRoundData();
        if (latest < 2) return (0, 0);
        uint256 start = latest > window ? uint256(latest) - window : 1;
        uint256 prevPrice = 0;
        uint256 sumSq = 0;
        uint256 n = 0;
        for (uint80 r = uint80(start); r <= latest; r++) {
            (, int256 a,,,) = _round(feed, r);
            if (a <= 0) {
                prevPrice = 0; // break continuity across bad prints
                continue;
            }
            uint256 p = uint256(a);
            if (prevPrice > 0) {
                uint256 diff = p > prevPrice ? p - prevPrice : prevPrice - p;
                uint256 retBps = (diff * 10_000) / prevPrice;
                sumSq += retBps * retBps;
                n += 1;
            }
            prevPrice = p;
        }
        if (n == 0) return (0, 0);
        return (isqrt(sumSq / n), n);
    }

    function _round(address feed, uint80 r)
        internal
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        try IChainlinkFeed(feed).getRoundData(r) returns (
            uint80 rid, int256 a, uint256 s, uint256 u, uint80 air
        ) {
            return (rid, a, s, u, air);
        } catch {
            return (r, int256(0), 0, 0, r);
        }
    }

    /// @notice Dynamic band for a feed under its config. Falls back to base
    /// band when history is thin (roundsUsed < 2) — fail-safe, never blind.
    function bandFor(address feed) public view returns (uint256 bandBps, uint256 volBps, uint256 roundsUsed) {
        Cfg memory c = cfgOf[feed];
        require(c.windowRounds >= 2, "VolEngine: unconfigured");
        (volBps, roundsUsed) = realizedVol(feed, c.windowRounds);
        if (roundsUsed < 2) return (c.baseBandBps, 0, roundsUsed);
        uint256 band = c.baseBandBps + (c.volMultBps * volBps) / 10_000;
        if (band > c.maxBandBps) band = c.maxBandBps;
        return (band, volBps, roundsUsed);
    }

    /// @notice Full evaluation: freshness via SessionGuard semantics + dynamic
    /// band vs refPrice. Returns (allowed, reason, bandUsed, volBps, roundsUsed).
    function evaluate(
        address feed,
        uint256 price,
        uint256 updatedAt,
        uint256 nowTs,
        uint256 refPrice,
        bool paused
    )
        external
        view
        returns (bool allowed, uint8 reason, uint256 bandUsed, uint256 volBps, uint256 roundsUsed)
    {
        Cfg memory c = cfgOf[feed];
        require(c.windowRounds >= 2, "VolEngine: unconfigured");
        (bandUsed, volBps, roundsUsed) = bandFor(feed);
        (allowed, reason) =
            GUARD.evaluate(price, updatedAt, nowTs, c.maxStaleSec, refPrice, bandUsed, paused);
    }
}
