/// `per_tx` rule — single-transaction spend ceiling: `request.amount() <= max_mist`. Complements
/// `budget` (lifetime ceiling) and `rate_limit` (rolling-window ceiling) with a flat per-call cap.
///
/// Abort codes:
/// - `E_OVER_PER_TX` (1): the request's amount exceeds the configured `max_mist`.
module agent_wallet::per_tx;

use agent_wallet::agent_wallet::{Self as aw, AgentWallet, SpendRequest};
use agent_wallet::version::Version;

const E_OVER_PER_TX: u64 = 1;

public struct Rule has drop {}

public struct Config has store, drop {
    max_mist: u64,
}

/// Owner-only: attach the per-tx rule with a ceiling of `max_mist` per `request_spend`.
public fun add<T>(wallet: &mut AgentWallet<T>, version: &Version, max_mist: u64, ctx: &TxContext) {
    aw::add_rule<T, Rule, Config>(Rule {}, wallet, version, Config { max_mist }, ctx);
}

/// Owner-only: detach the per-tx rule.
public fun remove<T>(wallet: &mut AgentWallet<T>, version: &Version, ctx: &TxContext) {
    aw::remove_rule<T, Rule, Config>(wallet, version, ctx);
}

/// Check the invariant and stamp a receipt onto `req`. Aborts `E_OVER_PER_TX` if the request's amount
/// exceeds the configured ceiling.
public fun prove<T>(req: &mut SpendRequest, wallet: &AgentWallet<T>, version: &Version) {
    version.check_is_valid();
    let cfg: &Config = aw::rule_config<T, Rule, Config>(Rule {}, wallet);
    assert!(req.request_amount() <= cfg.max_mist, E_OVER_PER_TX);
    aw::add_receipt(Rule {}, req);
}

public fun max_mist(cfg: &Config): u64 { cfg.max_mist }
