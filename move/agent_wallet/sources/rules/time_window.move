/// `time_window` rule — restricts `request_spend`/`prove` to an owner-configured clock window
/// `[not_before_ms, not_after_ms)`. Distinct from the wallet's hard `expires_at_ms` kill-switch: this
/// is an optional, composable, owner-removable blackout/campaign window (e.g. "only during this
/// week"), whereas `expires_at_ms` is the wallet's permanent lifetime bound regardless of any rule.
///
/// Abort codes:
/// - `E_OUTSIDE_TIME_WINDOW` (1): the current clock time is before `not_before_ms` or at/after
///   `not_after_ms`.
module agent_wallet::time_window;

use sui::clock::Clock;
use agent_wallet::agent_wallet::{Self as aw, AgentWallet, SpendRequest};
use agent_wallet::version::Version;

const E_OUTSIDE_TIME_WINDOW: u64 = 1;

public struct Rule has drop {}

public struct Config has store, drop {
    not_before_ms: u64,
    not_after_ms: u64,
}

/// Owner-only: attach the time-window rule. `not_before_ms` must be strictly less than
/// `not_after_ms` — a zero-width or inverted window can never be satisfied, which is almost always a
/// configuration mistake, not an intentional "always deny."
public fun add<T>(
    wallet: &mut AgentWallet<T>,
    version: &Version,
    not_before_ms: u64,
    not_after_ms: u64,
    ctx: &TxContext,
) {
    assert!(not_before_ms < not_after_ms, E_OUTSIDE_TIME_WINDOW);
    aw::add_rule<T, Rule, Config>(Rule {}, wallet, version, Config { not_before_ms, not_after_ms }, ctx);
}

/// Owner-only: detach the time-window rule.
public fun remove<T>(wallet: &mut AgentWallet<T>, version: &Version, ctx: &TxContext) {
    aw::remove_rule<T, Rule, Config>(wallet, version, ctx);
}

/// Check the invariant and stamp a receipt onto `req`. Aborts `E_OUTSIDE_TIME_WINDOW` if the current
/// clock time falls outside `[not_before_ms, not_after_ms)`.
public fun prove<T>(req: &mut SpendRequest, wallet: &AgentWallet<T>, version: &Version, clock: &Clock) {
    version.check_is_valid();
    let cfg: &Config = aw::rule_config<T, Rule, Config>(Rule {}, wallet);
    let now = clock.timestamp_ms();
    assert!(now >= cfg.not_before_ms && now < cfg.not_after_ms, E_OUTSIDE_TIME_WINDOW);
    aw::add_receipt(Rule {}, req);
}

public fun not_before_ms(cfg: &Config): u64 { cfg.not_before_ms }
public fun not_after_ms(cfg: &Config): u64 { cfg.not_after_ms }
