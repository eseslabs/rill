/// Package version gate — coordinates in-place upgrades so new rule modules can ship without a
/// forced wallet redeploy. Once the package is upgraded and `migrate` is invoked (Publisher-gated),
/// any call still targeting stale bytecode's logic aborts instead of silently operating on a wallet
/// whose invariants the new code no longer honors.
///
/// **Scope: the AGENT path only, never the owner.** `check_is_valid` gates `agent_wallet::create_wallet`
/// and the agent-facing spend flow (`request_spend`, `confirm_spend`, and every rule's `prove`) — so an
/// upgrade can pause new agent spending until `migrate` runs. It deliberately does NOT gate any
/// owner-only op (`revoke`, `top_up`, `rotate_agent`, `extend_expiry`, `add_rule`, `remove_rule`): an
/// owner's emergency controls — above all `revoke`, the kill-switch that reclaims funds — must never
/// depend on a shared `Version` object that could be sitting stale between an upgrade landing and its
/// `migrate` call. An upgrade can pause the agent; it can never trap the owner. See
/// `agent_wallet::agent_wallet`'s module doc comment for the full rationale.
///
/// Mirrors `narnia-realm/contract/sources/version.move`: a shared `Version` object created at
/// `init`, a `VERSION` compile-time constant bumped on every behavior-changing upgrade, and a
/// `migrate` that only this package's `Publisher` can invoke.
module agent_wallet::version;

use sui::package::Publisher;

/// Bump on every upgrade that changes on-chain behavior. `migrate` moves a live `Version` object's
/// `version` field up to match; callers holding a stale `Version` reference get rejected by
/// `check_is_valid` until they migrate.
const VERSION: u64 = 1;

/// `check_is_valid` was called against a `Version` object whose `version` no longer matches this
/// package's compiled `VERSION` — the caller is targeting stale bytecode/state assumptions.
const E_INVALID_PACKAGE_VERSION: u64 = 0;
/// `migrate` was called with a `Publisher` not claimed by this package.
const E_INVALID_PUBLISHER: u64 = 1;

/// Shared object recording which package version is authoritative. The agent-facing spend path
/// (`create_wallet`, `request_spend`, `confirm_spend`, every rule's `prove`) borrows this and calls
/// `check_is_valid` at its head; owner-only ops deliberately do not (see the module doc comment).
public struct Version has key {
    id: UID,
    version: u64,
}

fun init(ctx: &mut TxContext) {
    transfer::share_object(Version { id: object::new(ctx), version: VERSION });
}

/// Abort unless `self` matches this package's compiled `VERSION`. Call at the head of every
/// agent-facing entry point (`create_wallet`, `request_spend`, `confirm_spend`, rule `prove`s) —
/// never in an owner-only op, so an upgrade can pause the agent but can never trap the owner.
public fun check_is_valid(self: &Version) {
    assert!(self.version == VERSION, E_INVALID_PACKAGE_VERSION);
}

/// Publisher-gated: bump a live shared `Version` up to the current package's `VERSION` after an
/// in-place upgrade ships. Aborts if `publisher` was not claimed by this package (any module in it —
/// `from_package` matches on package address only).
public fun migrate(publisher: &Publisher, self: &mut Version) {
    assert!(publisher.from_package<Version>(), E_INVALID_PUBLISHER);
    self.version = VERSION;
}

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx);
}

#[test_only]
/// Force a live `Version` to an arbitrary value — used to simulate a stale package version in
/// tests without needing an actual upgrade.
public fun set_for_testing(self: &mut Version, version: u64) {
    self.version = version;
}

#[test_only]
public fun current_for_testing(): u64 { VERSION }
