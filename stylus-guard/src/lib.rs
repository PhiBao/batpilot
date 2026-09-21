//! Batpilot guards — Stylus (Rust) ports of the execution firewall.
//!
//! `evaluate` / `batch_evaluate` mirror `contracts/src/SessionGuard.sol`
//! (reason codes 0 = ALLOW, 1 = STALE, 2 = PAUSED, 3 = BAND_BREACH, 4 = INVALID_PRICE).
//!
//! `vol_band` mirrors `contracts/src/SessionVolEngine.sol`: realized-volatility
//! bands from price history. THIS is the honest WASM workload — per-round
//! ratios, variance accumulation, and an iterative integer square root over a
//! window, all branchy 256-bit integer math with zero storage I/O. The EVM
//! pays ~100+ gas per MUL/DIV plus loop overhead per round; WASM executes the
//! same arithmetic natively in a single bulk pass.

#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;

use stylus_sdk::{alloy_primitives::{Address, U256}, prelude::*};
use alloc::vec::Vec;

sol_storage! {
    #[entrypoint]
    pub struct SessionGuard {
        /// Vault this guard is bound to (informational; evaluation stays pure
        /// so any keeper can screen plans off-chain with identical semantics).
        address vault;
    }
}

const REASON_ALLOW: u8 = 0;
const REASON_STALE: u8 = 1;
const REASON_PAUSED: u8 = 2;
const REASON_BAND_BREACH: u8 = 3;
const REASON_INVALID_PRICE: u8 = 4;

const BPS: U256 = U256::from_limbs([10_000, 0, 0, 0]);

/// Babylonian integer square root (mirrors SessionVolEngine.isqrt).
fn isqrt(x: U256) -> U256 {
    if x.is_zero() {
        return U256::ZERO;
    }
    let mut z = (x + U256::from(1)) / U256::from(2);
    let mut y = x;
    while z < y {
        y = z;
        z = (x / z + z) / U256::from(2);
    }
    y
}

/// Realized-volatility band from a price window (oldest-first).
/// Returns (band_bps, vol_bps, rounds_used). Mirrors bandFor() fallback:
/// fewer than 2 usable steps -> base band.
fn vol_band_calc(
    prices: &[U256],
    base_band: U256,
    vol_mult: U256,
    max_band: U256,
) -> (U256, U256, U256) {
    let mut sum_sq = U256::ZERO;
    let mut n = U256::ZERO;
    let mut prev: Option<U256> = None;
    for &p in prices {
        if p.is_zero() {
            prev = None; // break continuity across bad prints
            continue;
        }
        if let Some(q) = prev {
            let diff = if p >= q { p - q } else { q - p };
            let ret = diff * BPS / q;
            sum_sq += ret * ret;
            n += U256::from(1);
        }
        prev = Some(p);
    }
    if n < U256::from(2) {
        return (base_band, U256::ZERO, n);
    }
    let vol = isqrt(sum_sq / n);
    let mut band = base_band + vol_mult * vol / BPS;
    if band > max_band {
        band = max_band;
    }
    (band, vol, n)
}

fn eval(
    price: U256,
    updated_at: U256,
    now_ts: U256,
    max_stale: U256,
    ref_price: U256,
    band_bps: U256,
    paused: bool,
) -> (bool, u8) {
    if paused {
        return (false, REASON_PAUSED);
    }
    if price.is_zero() {
        return (false, REASON_INVALID_PRICE);
    }
    if updated_at.is_zero() || now_ts > updated_at + max_stale {
        return (false, REASON_STALE);
    }
    if !ref_price.is_zero() && !band_bps.is_zero() {
        let diff = if price >= ref_price {
            price - ref_price
        } else {
            ref_price - price
        };
        if diff * BPS > ref_price * band_bps {
            return (false, REASON_BAND_BREACH);
        }
    }
    (true, REASON_ALLOW)
}

#[public]
impl SessionGuard {
    /// Bind the guard to its vault once at deployment.
    pub fn bind_vault(&mut self, vault: Address) {
        assert!(self.vault.get().is_zero());
        self.vault.set(vault);
    }

    pub fn bound_vault(&self) -> Address {
        self.vault.get()
    }

    /// Single-plan guard evaluation. Pure: no storage reads.
    pub fn evaluate(
        &self,
        price: U256,
        updated_at: U256,
        now_ts: U256,
        max_stale: U256,
        ref_price: U256,
        band_bps: U256,
        paused: bool,
    ) -> (bool, u8) {
        eval(price, updated_at, now_ts, max_stale, ref_price, band_bps, paused)
    }

    /// Protection evaluation: (stop_hit, take_hit) vs average entry.
    pub fn evaluate_protection(
        &self,
        current: U256,
        entry_avg: U256,
        stop_loss_bps: U256,
        take_profit_bps: U256,
    ) -> (bool, bool) {
        if current.is_zero() || entry_avg.is_zero() {
            return (false, false);
        }
        if current < entry_avg && !stop_loss_bps.is_zero() {
            let loss = entry_avg - current;
            if loss * BPS >= entry_avg * stop_loss_bps {
                return (true, false);
            }
        } else if current > entry_avg && !take_profit_bps.is_zero() {
            let gain = current - entry_avg;
            if gain * BPS >= entry_avg * take_profit_bps {
                return (false, true);
            }
        }
        (false, false)
    }

    /// Keeper fast path: screen N plans in one call. Returns parallel arrays
    /// (allowed[i], reason[i]). Reverts on length mismatch.
    pub fn batch_evaluate(
        &self,
        prices: Vec<U256>,
        updated_ats: Vec<U256>,
        now_ts: U256,
        max_stale: U256,
        ref_prices: Vec<U256>,
        band_bps: U256,
        paused: bool,
    ) -> (Vec<bool>, Vec<u8>) {
        assert!(prices.len() == updated_ats.len() && prices.len() == ref_prices.len());
        let mut allowed: Vec<bool> = Vec::with_capacity(prices.len());
        let mut reasons: Vec<u8> = Vec::with_capacity(prices.len());
        for i in 0..prices.len() {
            let (a, r) = eval(
                prices[i],
                updated_ats[i],
                now_ts,
                max_stale,
                ref_prices[i],
                band_bps,
                paused,
            );
            allowed.push(a);
            reasons.push(r);
        }
        (allowed, reasons)
    }

    /// Volatility-adaptive band from a price window (oldest-first, feed
    /// decimals, e.g. 8). Returns (band_bps, vol_bps, rounds_used).
    /// Pure compute: the WASM showcase — ratios + variance + isqrt in one pass.
    pub fn vol_band(
        &self,
        prices: Vec<U256>,
        base_band: U256,
        vol_mult: U256,
        max_band: U256,
    ) -> (U256, U256, U256) {
        vol_band_calc(&prices, base_band, vol_mult, max_band)
    }

    /// Reason-code constants for off-chain consumers.
    pub fn reason_allow(&self) -> u8 {
        REASON_ALLOW
    }    pub fn reason_stale(&self) -> u8 {
        REASON_STALE
    }
    pub fn reason_paused(&self) -> u8 {
        REASON_PAUSED
    }
    pub fn reason_band_breach(&self) -> u8 {
        REASON_BAND_BREACH
    }
    pub fn reason_invalid_price(&self) -> u8 {
        REASON_INVALID_PRICE
    }
}

#[cfg(test)]
mod test {
    use super::*;

    fn u(v: u64) -> U256 {
        U256::from(v)
    }

    /// Host-testable mirror of `evaluate_protection` (same arithmetic).
    fn prot(current: U256, entry_avg: U256, sl: U256, tp: U256) -> (bool, bool) {
        if current.is_zero() || entry_avg.is_zero() {
            return (false, false);
        }
        if current < entry_avg && !sl.is_zero() {
            if (entry_avg - current) * BPS >= entry_avg * sl {
                return (true, false);
            }
        } else if current > entry_avg && !tp.is_zero() {
            if (current - entry_avg) * BPS >= entry_avg * tp {
                return (false, true);
            }
        }
        (false, false)
    }

    #[test]
    fn parity_allow_and_stale() {
        // price $180e8, fresh
        let (ok, r) = eval(u(180_00000000), u(1000), u(1100), u(3600), u(0), u(500), false);
        assert!(ok && r == REASON_ALLOW);
        // stale: now far past updated_at + max_stale
        let (ok, r) = eval(u(180_00000000), u(1000), u(10000), u(3600), u(0), u(500), false);
        assert!(!ok && r == REASON_STALE);
    }

    #[test]
    fn parity_band_and_pause() {
        // +10% vs 5% band -> breach
        let (ok, r) = eval(u(198_00000000), u(1000), u(1100), u(3600), u(180_00000000), u(500), false);
        assert!(!ok && r == REASON_BAND_BREACH);
        // in-band passes
        let (ok, _) = eval(u(183_00000000), u(1000), u(1100), u(3600), u(180_00000000), u(500), false);
        assert!(ok);
        // paused + zero price
        let (_, r) = eval(u(1), u(1000), u(1100), u(3600), u(0), u(0), true);
        assert_eq!(r, REASON_PAUSED);
        let (_, r) = eval(U256::ZERO, u(1000), u(1100), u(3600), u(0), u(0), false);
        assert_eq!(r, REASON_INVALID_PRICE);
    }

    #[test]
    fn parity_protection_thresholds() {        // exactly -8% triggers stop
        let entry = u(180_00000000);
        let at_stop = entry * U256::from(92) / U256::from(100);
        let (s, t) = prot(at_stop, entry, u(800), u(2000));
        assert!(s && !t);
        // just above stop does not trigger
        let (s, _) = prot(at_stop + u(1), entry, u(800), u(2000));
        assert!(!s);
        // +20% triggers take
        let at_take = entry * U256::from(120) / U256::from(100);
        let (s, t) = prot(at_take, entry, u(800), u(2000));
        assert!(!s && t);
    }

    fn px(v: u64) -> U256 {
        U256::from(v) * U256::from(100_000000)
    }

    #[test]
    fn parity_vol_flat_is_base() {
        let flat = alloc::vec![px(180); 13];
        let (band, vol, n) = vol_band_calc(&flat, u(200), u(10_000), u(2000));
        assert_eq!(vol, U256::ZERO);
        assert_eq!(band, u(200));
        assert!(n >= U256::from(2));
    }

    #[test]
    fn parity_vol_chop_widens() {
        // +-5% chop: vol ~= 1000bps, band = 200 + 1000 = 1200.
        let mut v: Vec<U256> = Vec::new();
        for i in 0..13 {
            v.push(if i % 2 == 0 { px(189) } else { px(171) });
        }
        let (band, vol, _) = vol_band_calc(&v, u(200), u(10_000), u(2000));
        assert!(vol >= U256::from(900) && vol <= U256::from(1120));
        assert_eq!(band, U256::from(200) + vol);
    }

    #[test]
    fn parity_vol_thin_falls_back() {
        let (band, vol, n) = vol_band_calc(&alloc::vec![px(180)], u(200), u(10_000), u(2000));
        assert_eq!(band, u(200));
        assert_eq!(vol, U256::ZERO);
        assert!(n < U256::from(2));
    }

    #[test]
    fn parity_vol_caps_and_skips() {
        // +-40% chop would imply ~4000bps+ -> capped at 2000.
        let mut v: Vec<U256> = Vec::new();
        for i in 0..13 {
            v.push(if i % 2 == 0 { px(252) } else { px(108) });
        }
        // Inject a bad print mid-window: continuity must break, not poison.
        v[6] = U256::ZERO;
        let (band, _, _) = vol_band_calc(&v, u(200), u(10_000), u(2000));
        assert_eq!(band, u(2000));
        // isqrt sanity
        assert_eq!(isqrt(U256::ZERO), U256::ZERO);
        assert_eq!(isqrt(u(16)), u(4));
    }
}
