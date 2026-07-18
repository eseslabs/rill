/// `rate_limit` rule — rolling spend-window quota, ported from v2's `window_ms`/`window_max` logic:
/// at most `window_max` may be spent within any `window_ms`-long rolling window. The window lazily
/// rolls forward the first time `prove` is called after it elapses (no separate "reset" call needed).
///
/// This is the one rule with genuinely mutable per-spend state (the window's start time and running
/// total), so — unlike the other rules — `prove` takes `wallet: &mut AgentWallet<T>` to commit that
/// state via `rule_config_mut`.
///
/// Abort codes:
/// - `E_OVER_WINDOW` (1): this spend would exceed `window_max` within the current window.
module agent_wallet::rate_limit;

use sui::clock::Clock;
use agent_wallet::agent_wallet::{Self as aw, AgentWallet, SpendRequest};
use agent_wallet::version::Version;

const E_OVER_WINDOW: u64 = 1;

public struct Rule has drop {}

public struct Config has store, drop {
    window_ms: u64,
    window_max: u64,
    window_start_ms: u64,
    spent_in_window: u64,
}

/// Owner-only: attach the rolling-window rule. `window_start_ms`/`spent_in_window` start at 0 — the
/// first `prove` call establishes the first window.
public fun add<T>(
    wallet: &mut AgentWallet<T>,
    version: &Version,
    window_ms: u64,
    window_max: u64,
    ctx: &TxContext,
) {
    aw::add_rule<T, Rule, Config>(
        Rule {},
        wallet,
        version,
        Config { window_ms, window_max, window_start_ms: 0, spent_in_window: 0 },
        ctx,
    );
}

/// Owner-only: detach the rolling-window rule.
public fun remove<T>(wallet: &mut AgentWallet<T>, version: &Version, ctx: &TxContext) {
    aw::remove_rule<T, Rule, Config>(wallet, version, ctx);
}

/// Check the invariant, roll the window forward if elapsed, commit the new running total, and stamp
/// a receipt onto `req`. Aborts `E_OVER_WINDOW` if this spend would exceed `window_max` in the
/// current (possibly just-rolled) window.
public fun prove<T>(req: &mut SpendRequest, wallet: &mut AgentWallet<T>, version: &Version, clock: &Clock) {
    version.check_is_valid();
    let amount = req.request_amount();
    let cfg: &mut Config = aw::rule_config_mut<T, Rule, Config>(Rule {}, wallet);

    let now = clock.timestamp_ms();
    if (now >= cfg.window_start_ms + cfg.window_ms) {
        cfg.window_start_ms = now;
        cfg.spent_in_window = 0;
    };
    assert!(cfg.spent_in_window + amount <= cfg.window_max, E_OVER_WINDOW);
    cfg.spent_in_window = cfg.spent_in_window + amount;

    aw::add_receipt(Rule {}, req);
}

public fun window_ms(cfg: &Config): u64 { cfg.window_ms }
public fun window_max(cfg: &Config): u64 { cfg.window_max }
public fun window_start_ms(cfg: &Config): u64 { cfg.window_start_ms }
public fun spent_in_window(cfg: &Config): u64 { cfg.spent_in_window }

/// Read-only view of a wallet's current rolling-window state, for off-chain callers.
public fun view<T>(wallet: &AgentWallet<T>): &Config {
    aw::rule_config<T, Rule, Config>(Rule {}, wallet)
}
