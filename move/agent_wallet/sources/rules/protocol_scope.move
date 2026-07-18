/// `protocol_scope` rule — restricts `request_spend`'s `target_package` to an owner-configured
/// allowlist. Unlike v2's `allowed_packages` field (where an empty vector meant "allow all" — a
/// permissive default), attaching this rule with an empty `allowed` list denies every target: the
/// rule is opt-in, so its absence (not attaching it) is what means "no protocol restriction," and its
/// presence always means "only these."
///
/// Abort codes:
/// - `E_PROTOCOL_NOT_ALLOWED` (1): `target_package` is not in the configured allowlist.
module agent_wallet::protocol_scope;

use agent_wallet::agent_wallet::{Self as aw, AgentWallet, SpendRequest};
use agent_wallet::version::Version;

const E_PROTOCOL_NOT_ALLOWED: u64 = 1;

public struct Rule has drop {}

public struct Config has store, drop {
    allowed: vector<address>,
}

/// Owner-only: attach the protocol-scope rule with an allowlist of target package addresses.
public fun add<T>(wallet: &mut AgentWallet<T>, version: &Version, allowed: vector<address>, ctx: &TxContext) {
    aw::add_rule<T, Rule, Config>(Rule {}, wallet, version, Config { allowed }, ctx);
}

/// Owner-only: detach the protocol-scope rule.
public fun remove<T>(wallet: &mut AgentWallet<T>, version: &Version, ctx: &TxContext) {
    aw::remove_rule<T, Rule, Config>(wallet, version, ctx);
}

/// Check the invariant and stamp a receipt onto `req`. Aborts `E_PROTOCOL_NOT_ALLOWED` if
/// `req.target_package()` is not in the configured allowlist.
public fun prove<T>(req: &mut SpendRequest, wallet: &AgentWallet<T>, version: &Version) {
    version.check_is_valid();
    let cfg: &Config = aw::rule_config<T, Rule, Config>(Rule {}, wallet);
    assert!(cfg.allowed.contains(&req.request_target_package()), E_PROTOCOL_NOT_ALLOWED);
    aw::add_receipt(Rule {}, req);
}

public fun allowed(cfg: &Config): vector<address> { cfg.allowed }
