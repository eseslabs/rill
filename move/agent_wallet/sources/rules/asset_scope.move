/// `asset_scope` rule — restricts which coin types a spend may move: both `request_spend`'s
/// `coin_in` and `coin_out` must be in the owner-configured allowlist of `TypeName`s. Opt-in like
/// `protocol_scope`: an attached rule with an empty `allowed` list denies every asset; not attaching
/// the rule means no asset restriction.
///
/// Abort codes:
/// - `E_ASSET_NOT_ALLOWED` (1): `coin_in` or `coin_out` is not in the configured allowlist.
module agent_wallet::asset_scope;

use std::type_name::TypeName;
use agent_wallet::agent_wallet::{Self as aw, AgentWallet, SpendRequest};
use agent_wallet::version::Version;

const E_ASSET_NOT_ALLOWED: u64 = 1;

public struct Rule has drop {}

public struct Config has store, drop {
    allowed: vector<TypeName>,
}

/// Owner-only: attach the asset-scope rule with an allowlist of coin `TypeName`s.
public fun add<T>(wallet: &mut AgentWallet<T>, version: &Version, allowed: vector<TypeName>, ctx: &TxContext) {
    aw::add_rule<T, Rule, Config>(Rule {}, wallet, version, Config { allowed }, ctx);
}

/// Owner-only: detach the asset-scope rule.
public fun remove<T>(wallet: &mut AgentWallet<T>, version: &Version, ctx: &TxContext) {
    aw::remove_rule<T, Rule, Config>(wallet, version, ctx);
}

/// Check the invariant and stamp a receipt onto `req`. Aborts `E_ASSET_NOT_ALLOWED` if either
/// `req.coin_in()` or `req.coin_out()` is not in the configured allowlist.
public fun prove<T>(req: &mut SpendRequest, wallet: &AgentWallet<T>, version: &Version) {
    version.check_is_valid();
    let cfg: &Config = aw::rule_config<T, Rule, Config>(Rule {}, wallet);
    assert!(cfg.allowed.contains(&req.request_coin_in()), E_ASSET_NOT_ALLOWED);
    assert!(cfg.allowed.contains(&req.request_coin_out()), E_ASSET_NOT_ALLOWED);
    aw::add_receipt(Rule {}, wallet, req);
}

public fun allowed(cfg: &Config): vector<TypeName> { cfg.allowed }
