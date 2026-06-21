/// Rill guard — the on-chain slippage chokepoint for agent swaps.
///
/// Protocol-agnostic: `assert_min_value` aborts if a swap's output coin holds less than the caller's
/// floor. Rill's compiler injects it after every swap output (any protocol, any token), so an agent
/// can never accept a worse-than-`min` fill — even if a sandwich/MEV bot moves the pool. This is the
/// deterministic backstop; price-bound (`sqrt_price_limit`) is defense-in-depth on top.
module rill_guard::guard {
    use sui::coin::Coin;

    /// Output is below the caller's minimum (slippage floor breached).
    const E_SLIPPAGE: u64 = 1;

    /// Abort unless `coin` holds at least `min`. Borrows the coin (immutable), so it stays usable
    /// downstream in the same PTB.
    public fun assert_min_value<T>(coin: &Coin<T>, min: u64) {
        assert!(coin.value() >= min, E_SLIPPAGE);
    }
}
