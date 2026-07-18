/// `recipient_allowlist` rule — restricts `request_spend`'s `recipient` to an owner-configured
/// allowlist of addresses. Opt-in like `protocol_scope`/`asset_scope`: an attached rule with an empty
/// `allowed` list denies every recipient; not attaching the rule means no recipient restriction.
///
/// Abort codes:
/// - `E_RECIPIENT_NOT_ALLOWED` (1): `recipient` is not in the configured allowlist.
module agent_wallet::recipient_allowlist;

use agent_wallet::agent_wallet::{Self as aw, AgentWallet, SpendRequest};
use agent_wallet::version::Version;

const E_RECIPIENT_NOT_ALLOWED: u64 = 1;

public struct Rule has drop {}

public struct Config has store, drop {
    allowed: vector<address>,
}

/// Owner-only: attach the recipient-allowlist rule.
public fun add<T>(wallet: &mut AgentWallet<T>, version: &Version, allowed: vector<address>, ctx: &TxContext) {
    aw::add_rule<T, Rule, Config>(Rule {}, wallet, version, Config { allowed }, ctx);
}

/// Owner-only: detach the recipient-allowlist rule.
public fun remove<T>(wallet: &mut AgentWallet<T>, version: &Version, ctx: &TxContext) {
    aw::remove_rule<T, Rule, Config>(wallet, version, ctx);
}

/// Check the invariant and stamp a receipt onto `req`. Aborts `E_RECIPIENT_NOT_ALLOWED` if
/// `req.recipient()` is not in the configured allowlist.
public fun prove<T>(req: &mut SpendRequest, wallet: &AgentWallet<T>, version: &Version) {
    version.check_is_valid();
    let cfg: &Config = aw::rule_config<T, Rule, Config>(Rule {}, wallet);
    assert!(cfg.allowed.contains(&req.request_recipient()), E_RECIPIENT_NOT_ALLOWED);
    aw::add_receipt(Rule {}, req);
}

public fun allowed(cfg: &Config): vector<address> { cfg.allowed }
