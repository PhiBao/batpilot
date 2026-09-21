//! Batpilot SessionGuard — Stylus (Rust) port of the execution firewall.
//!
//! Identical semantics to `contracts/src/SessionGuard.sol`:
//! reason codes 0 = ALLOW, 1 = STALE, 2 = PAUSED, 3 = BAND_BREACH, 4 = INVALID_PRICE.
//!
//! Why WASM: keepers scan hundreds of plans per tick through `batch_evaluate`.
//! The loop is integer-heavy (abs-diff + bps ratio per plan) with zero storage
//! I/O — exactly the compute-dense, storage-light shape where Stylus undercuts
//! EVM gas (no SLOADs, native 256-bit arithmetic, single WASM bulk pass).

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

    /// Reason-code constants for off-chain consumers.
    pub fn reason_allow(&self) -> u8 {
        REASON_ALLOW
    }
    pub fn reason_stale(&self) -> u8 {
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
    fn parity_protection_thresholds() {
        // exactly -8% triggers stop
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
}
