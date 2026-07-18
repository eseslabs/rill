/// `budget` rule — cumulative lifetime spend ceiling: `cfg.spent + request.amount() <= total_mist`.
/// Distinct from the wallet's physical `Balance<T>`: the owner can attach a `budget` tighter than the
/// actual funds on hand (e.g. fund the wallet with 10 SUI but cap the agent's lifetime spend at 2
/// SUI). Detaching the rule removes the ceiling; the physical balance remains the only hard limit.
///
/// Stateful + eager, mirroring `rate_limit`: `Config` carries its own running `spent` counter,
/// committed inside `prove` itself (via `rule_config_mut`) rather than read lazily from
/// `wallet.spent()` at prove-time. A wallet's `spent` field only advances at `confirm_spend`, so two
/// `request_spend` + `budget::prove` pairs minted in the same PTB before either is confirmed would
/// otherwise both observe the same stale `wallet.spent()` baseline and could jointly push lifetime
/// spend past `total_mist` (TOCTOU). Committing `cfg.spent` eagerly at `prove`-time closes that gap —
/// the second `prove` in a batch sees the first's reservation immediately.
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
    spent: u64,
}

/// Owner-only: attach the budget rule with a lifetime spend ceiling of `total_mist`. Seeds `spent`
/// from `wallet.spent()` (preserving lifetime-from-creation spend; normally 0 at onboarding, but this
/// keeps the invariant correct even if `budget` is attached after some spending has already
/// happened).
public fun add<T>(wallet: &mut AgentWallet<T>, version: &Version, total_mist: u64, ctx: &TxContext) {
    let spent = wallet.spent();
    aw::add_rule<T, Rule, Config>(Rule {}, wallet, version, Config { total_mist, spent }, ctx);
}

/// Owner-only: detach the budget rule.
public fun remove<T>(wallet: &mut AgentWallet<T>, version: &Version, ctx: &TxContext) {
    aw::remove_rule<T, Rule, Config>(wallet, version, ctx);
}

/// Check the invariant, eagerly commit the new running total, and stamp a receipt onto `req`. Aborts
/// `E_OVER_BUDGET` if this spend would push lifetime spend past the configured ceiling.
public fun prove<T>(req: &mut SpendRequest, wallet: &mut AgentWallet<T>, version: &Version) {
    version.check_is_valid();
    let amount = req.request_amount();
    let cfg = aw::rule_config_mut<T, Rule, Config>(Rule {}, wallet);
    assert!(cfg.spent + amount <= cfg.total_mist, E_OVER_BUDGET);
    cfg.spent = cfg.spent + amount;

    aw::add_receipt(Rule {}, wallet, req);
}

public fun total_mist(cfg: &Config): u64 { cfg.total_mist }
public fun spent(cfg: &Config): u64 { cfg.spent }
