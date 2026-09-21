// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {SessionGuard} from "../src/SessionGuard.sol";
import {SessionVolEngine} from "../src/SessionVolEngine.sol";
import {MockFeed} from "../src/Mocks.sol";

/// @notice Volatility-adaptive bands: calm markets tighten, regime breaks widen,
/// thin history fails safe to the base band. The money assertion: a move the
/// static guard refuses, the engine allows (or refuses) for a measured reason.
contract VolEngineTest is Test {
    SessionGuard guard;
    SessionVolEngine engine;
    MockFeed feed;

    function setUp() public {
        guard = new SessionGuard();
        engine = new SessionVolEngine(address(guard));
        feed = new MockFeed(180e8);
        // base 2%, 1x vol multiplier, 12-round window, 20% cap, 1h freshness
        engine.setConfig(address(feed), 200, 10_000, 12, 2000, 3600);
    }

    function test_Isqrt() public view {
        assertEq(engine.isqrt(0), 0);
        assertEq(engine.isqrt(1), 1);
        assertEq(engine.isqrt(16), 4);
        assertEq(engine.isqrt(100_00), 100); // 100.00bps -> 100
        assertEq(engine.isqrt(250_000), 500);
    }

    function test_FlatHistoryBandEqualsBase() public {
        int256[] memory h = new int256[](12);
        for (uint256 i = 0; i < 12; i++) h[i] = 180e8;
        feed.pushHistory(h);
        (uint256 band, uint256 vol, uint256 n) = engine.bandFor(address(feed));
        assertEq(vol, 0);
        assertGt(n, 2);
        assertEq(band, 200);
    }

    function test_VolatileHistoryWidensBand() public {
        // Alternating +-5% prints: each step ~500bps of realized move.
        int256[] memory h = new int256[](12);
        for (uint256 i = 0; i < 12; i++) {
            h[i] = i % 2 == 0 ? int256(189e8) : int256(171e8);
        }
        feed.pushHistory(h);
        (uint256 band, uint256 vol, uint256 n) = engine.bandFor(address(feed));
        assertGt(n, 2);
        assertApproxEqAbs(vol, 1000, 120); // ~10% step-to-step
        assertGt(band, 200);
        assertApproxEqAbs(band, 200 + vol, 130);
    }

    function test_EngineAllowsWhatStaticGuardRefuses() public {
        // +8% jump vs $180 ref. Static 5% band refuses.
        (bool okStatic,) = guard.evaluate(194.4e8, block.timestamp, block.timestamp, 3600, 180e8, 500, false);
        assertFalse(okStatic);

        // After a volatile regime the dynamic band covers it.
        int256[] memory h = new int256[](12);
        for (uint256 i = 0; i < 12; i++) {
            h[i] = i % 2 == 0 ? int256(194.4e8) : int256(165.6e8); // +-8% steps
        }
        feed.pushHistory(h);
        (bool ok, uint8 reason, uint256 bandUsed,,) =
            engine.evaluate(address(feed), 194.4e8, block.timestamp, block.timestamp, 180e8, false);
        assertTrue(ok);
        assertEq(reason, 0);
        assertGe(bandUsed, 800);
    }

    function test_CalmEngineRefusesSpike() public {
        int256[] memory h = new int256[](12);
        for (uint256 i = 0; i < 12; i++) h[i] = 180e8;
        feed.pushHistory(h);
        (bool ok, uint8 reason,,,) =
            engine.evaluate(address(feed), 194.4e8, block.timestamp, block.timestamp, 180e8, false);
        assertFalse(ok);
        assertEq(reason, guard.REASON_BAND_BREACH());
    }

    function test_ThinHistoryFallsBackToBase() public {
        // Genesis round only: no usable window -> base band, flagged thin.
        (uint256 band, uint256 vol, uint256 n) = engine.bandFor(address(feed));
        assertEq(band, 200);
        assertEq(vol, 0);
        assertLt(n, 2);
    }

    function test_BadRoundsSkipped() public {
        int256[] memory h = new int256[](6);
        h[0] = 180e8;
        h[1] = int256(0); // bad print
        h[2] = -5e8; // bad print
        h[3] = 180e8;
        h[4] = 180e8;
        h[5] = 180e8;
        feed.pushHistory(h);
        (uint256 band, uint256 vol,) = engine.bandFor(address(feed));
        assertEq(vol, 0); // no valid consecutive pair moved
        assertEq(band, 200);
    }

    function test_BandCapped() public {
        // Extreme +-40% chop would imply ~4000bps vol -> capped at 2000.
        int256[] memory h = new int256[](12);
        for (uint256 i = 0; i < 12; i++) {
            h[i] = i % 2 == 0 ? int256(252e8) : int256(108e8);
        }
        feed.pushHistory(h);
        (uint256 band,,) = engine.bandFor(address(feed));
        assertEq(band, 2000);
    }
}
