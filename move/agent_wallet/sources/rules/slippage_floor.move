/// `slippage_floor` rule — the on-chain slippage backstop, wired as a composable rule rather than a
/// standalone assert. `prove` is a thin dispatch to `rill_guard::guard::assert_min_value`: it borrows
/// the swap's actual output coin (produced elsewhere in the same PTB, e.g. by a Cetus/Haedal swap
/// adapter — NOT the wallet's own budget coin, which hasn't been released yet at prove-time) and
/// aborts unless it holds at least the owner-configured `min`. Generic over both the wallet's coin
/// type `T` and the swap output's coin type `OutT`, since a spend routed through a swap commonly
/// changes coin type.
///
/// Abort codes: none of its own — this rule deliberately does not duplicate `rill_guard::guard`'s
/// abort code. It aborts with `rill_guard::guard::E_SLIPPAGE` (module `rill_guard::guard`, code `1`)
/// via the dispatched call.
module agent_wallet::slippage_floor;

use sui::coin::Coin;
use agent_wallet::agent_wallet::{Self as aw, AgentWallet, SpendRequest};
use agent_wallet::version::Version;
use rill_guard::guard;

public struct Rule has drop {}

public struct Config has store, drop {
    min: u64,
}

/// Owner-only: attach the slippage-floor rule with a minimum acceptable output amount.
public fun add<T>(wallet: &mut AgentWallet<T>, version: &Version, min: u64, ctx: &TxContext) {
    aw::add_rule<T, Rule, Config>(Rule {}, wallet, version, Config { min }, ctx);
}

/// Owner-only: detach the slippage-floor rule.
public fun remove<T>(wallet: &mut AgentWallet<T>, version: &Version, ctx: &TxContext) {
    aw::remove_rule<T, Rule, Config>(wallet, version, ctx);
}

/// Dispatch to `rill_guard::guard::assert_min_value` against `coin_out` (borrowed, so it stays usable
/// downstream in the same PTB) and stamp a receipt onto `req`. Aborts with
/// `rill_guard::guard::E_SLIPPAGE` if `coin_out` holds less than the configured `min`.
public fun prove<T, OutT>(
    req: &mut SpendRequest,
    wallet: &AgentWallet<T>,
    version: &Version,
    coin_out: &Coin<OutT>,
) {
    version.check_is_valid();
    let cfg: &Config = aw::rule_config<T, Rule, Config>(Rule {}, wallet);
    guard::assert_min_value<OutT>(coin_out, cfg.min);
    aw::add_receipt(Rule {}, req);
}

public fun min(cfg: &Config): u64 { cfg.min }
