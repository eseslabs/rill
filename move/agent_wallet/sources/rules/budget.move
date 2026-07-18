/// `budget` rule — cumulative lifetime spend ceiling: `wallet.spent() + request.amount() <=
/// total_mist`. Distinct from the wallet's physical `Balance<T>`: the owner can attach a `budget`
/// tighter than the actual funds on hand (e.g. fund the wallet with 10 SUI but cap the agent's
/// lifetime spend at 2 SUI). Detaching the rule removes the ceiling; the physical balance remains the
/// only hard limit.
///
/// Abort codes:
/// - `E_OVER_BUDGET` (1): proving would push lifetime spend past the configured `total_mist`.
module agent_wallet::budget;

use agent_wallet::agent_wallet::{Self as aw, AgentWallet, SpendRequest};
use agent_wallet::version::Version;

const E_OVER_BUDGET: u64 = 1;

public struct Rule has drop {}

public struct Config has store, drop {
    total_mist: u64,
}

/// Owner-only: attach the budget rule with a lifetime spend ceiling of `total_mist`.
public fun add<T>(wallet: &mut AgentWallet<T>, version: &Version, total_mist: u64, ctx: &TxContext) {
    aw::add_rule<T, Rule, Config>(Rule {}, wallet, version, Config { total_mist }, ctx);
}

/// Owner-only: detach the budget rule.
public fun remove<T>(wallet: &mut AgentWallet<T>, version: &Version, ctx: &TxContext) {
    aw::remove_rule<T, Rule, Config>(wallet, version, ctx);
}

/// Check the invariant and stamp a receipt onto `req`. Aborts `E_OVER_BUDGET` if this spend would
/// push lifetime spend past the configured ceiling.
public fun prove<T>(req: &mut SpendRequest, wallet: &AgentWallet<T>, version: &Version) {
    version.check_is_valid();
    let cfg: &Config = aw::rule_config<T, Rule, Config>(Rule {}, wallet);
    assert!(wallet.spent() + req.request_amount() <= cfg.total_mist, E_OVER_BUDGET);
    aw::add_receipt(Rule {}, req);
}

public fun total_mist(cfg: &Config): u64 { cfg.total_mist }
