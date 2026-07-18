/// Rill agent wallet — an on-chain, capped, revocable budget for an AI agent, gated by a composable
/// set of owner-attached restriction rules.
///
/// v3 redesign: replaces v2's hardcoded `spend()` asserts (flat budget/per-tx/window/allowed-packages
/// fields baked into the wallet struct) with the Sui Kiosk `TransferPolicy` **Rule + Hot Potato**
/// pattern. `request_spend` mints a `SpendRequest` — a hot potato with NO abilities (no `drop`,
/// `store`, `key`, or `copy`) — carrying the spend's metadata. Every rule attached to the wallet's
/// `SpendPolicy` must stamp a receipt onto the request (via its own `prove` entry, which checks its
/// invariant then calls `add_receipt`) before `confirm_spend` will unpack the potato and release the
/// coin. This is unbypassable by construction: a `SpendRequest` with abilities `{}` cannot be dropped,
/// stored, or discarded — the transaction can only succeed by routing it through `confirm_spend`,
/// which asserts every attached rule's receipt is present.
///
/// Rules are independent modules (`agent_wallet::budget`, `::per_tx`, `::rate_limit`,
/// `::protocol_scope`, `::slippage_floor`, `::asset_scope`, `::recipient_allowlist`, `::time_window`)
/// that attach their config as a dynamic field on `SpendPolicy`, keyed by their own witness type —
/// mirroring `sui::transfer_policy::add_rule`. Because rule configs live in dynamic fields rather than
/// `AgentWallet`/`SpendPolicy` struct fields, new rule types ship via in-place package upgrade
/// (guarded by `agent_wallet::version`) without ever touching the wallet's struct layout — no forced
/// redeploy.
///
/// Owner-only surface: `add_rule`/`remove_rule` (and every setter) assert `ctx.sender() == owner`.
/// The agent holds only an `AgentCap`, which authorizes `request_spend` within whatever rules are
/// currently composed — it can never see or touch `add_rule`/`remove_rule` (R4: the agent can never
/// change its own restrictions).
///
/// **Version gate scope — an upgrade can pause the agent, but must never trap the owner.**
/// `agent_wallet::version::check_is_valid` gates `create_wallet` and the agent-facing spend path
/// (`request_spend`/`confirm_spend`, and every rule's `prove`) — so an in-place upgrade can pause new
/// spending until `migrate` runs. It deliberately does NOT gate any owner-only op (`revoke`, `top_up`,
/// `rotate_agent`, `extend_expiry`, `add_rule`, `remove_rule`): if the owner's emergency controls —
/// above all `revoke`, the kill-switch that reclaims funds — required a fresh `Version` too, a stale
/// shared `Version` object between an upgrade and its `migrate` call would fund-trap the owner out of
/// their own wallet. Owner ops stay live across any package version; only the agent's ability to move
/// money is what an upgrade can pause.
///
/// This is a fresh package (struct layout changed from v2; Sui upgrade compatibility forbids changing
/// existing struct fields in-place), so v3 ships as a new deploy rather than an upgrade of v2.
module agent_wallet::agent_wallet {
    use std::type_name::{Self, TypeName};
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::clock::Clock;
    use sui::dynamic_field as df;
    use sui::event;
    use sui::vec_set::{Self, VecSet};
    use agent_wallet::version::Version;

    // ── abort codes ──
    const E_NOT_OWNER: u64 = 1;
    const E_REVOKED: u64 = 2;
    const E_EXPIRED: u64 = 3;
    /// The wallet's physical `Balance<T>` holds less than the requested amount. Distinct from any
    /// `budget` *rule*'s configured ceiling — this is the hard, always-enforced custody limit.
    const E_INSUFFICIENT_FUNDS: u64 = 4;
    const E_BAD_CAP: u64 = 5;
    const E_ZERO_AMOUNT: u64 = 6;
    /// `request_spend`'s caller (`ctx.sender()`) is not the wallet's current `agent` — defense in
    /// depth alongside the `AgentCap` possession check, so a leaked cap alone is not sufficient.
    const E_NOT_AGENT: u64 = 7;
    /// `extend_expiry` was called with a timestamp that does not move expiry strictly forward.
    const E_EXPIRY_NOT_FORWARD: u64 = 8;
    /// `confirm_spend` was called with a `SpendRequest` minted against a different wallet.
    const E_WRONG_WALLET: u64 = 9;
    /// `confirm_spend`'s `SpendRequest` does not carry a receipt for every rule currently attached to
    /// the wallet's `SpendPolicy` (or carries a receipt for a rule that is no longer attached). This
    /// is the hot-potato invariant: every attached rule must `prove` before the coin releases.
    const E_RULE_NOT_SATISFIED: u64 = 10;
    /// `add_rule` was called for a `Rule` type already attached to this wallet's policy.
    const E_RULE_ALREADY_SET: u64 = 11;

    /// Shared object: the agent's capped, revocable wallet. `T` = the budget coin type (any token).
    /// Deliberately minimal — custody + identity + hard kill-switch only. Every *composable*
    /// restriction (budget ceiling, per-tx cap, rolling window, protocol/asset/recipient scope,
    /// slippage floor, time window) lives in `policy` as a dynamic field, never as a struct field
    /// here, so this struct's layout never needs to change to add a new rule type.
    public struct AgentWallet<phantom T> has key {
        id: UID,
        owner: address,
        agent: address,
        /// The currently active `AgentCap`'s id. `request_spend` requires the caller's cap to match
        /// this — `rotate_agent` mints a fresh cap and updates this field, instantly invalidating the
        /// previous cap even though its holder still physically owns that object.
        cap_id: ID,
        budget: Balance<T>,
        /// Lifetime total spent from this wallet (observability + read by the `budget` rule).
        spent: u64,
        /// Hard kill-date, distinct from the optional `time_window` *rule*: once past this timestamp
        /// the wallet can never spend again until the owner calls `extend_expiry`. Always enforced,
        /// with or without any rules attached.
        expires_at_ms: u64,
        revoked: bool,
        policy: SpendPolicy,
    }

    /// The set of restriction rules currently attached to a wallet. `rules` names which rule
    /// Witnesses must stamp a receipt for `confirm_spend` to succeed; each rule's own configuration
    /// (limits, allowlists, ...) is stored as a dynamic field on `id`, keyed by `RuleKey<Rule>` —
    /// mirrors `sui::transfer_policy::TransferPolicy`. Not a standalone Sui object (no `key`): it
    /// lives nested inside `AgentWallet`, the same shape as `sui::table::Table`.
    #[allow(lint(missing_key))]
    public struct SpendPolicy has store {
        id: UID,
        rules: VecSet<TypeName>,
    }

    /// Dynamic-field key for a rule's stored config on `SpendPolicy.id`. Phantom `Rule` scopes one
    /// slot per rule witness type — only that rule's own module can construct a `Rule` value, so only
    /// that module can name this key (via `add_rule`/`remove_rule`/`rule_config`/`rule_config_mut`,
    /// all of which require a witness value).
    public struct RuleKey<phantom Rule: drop> has copy, drop, store {}

    /// Capability minted to the agent — possession authorizes `request_spend`, but only alongside a
    /// matching `ctx.sender() == wallet.agent` and `object::id(cap) == wallet.cap_id`.
    public struct AgentCap has key, store {
        id: UID,
        wallet: ID,
    }

    /// A "Hot Potato" forcing every attached rule to `prove` before the coin it authorizes can be
    /// released. No abilities (`drop`/`store`/`key`/`copy`) — the only way to consume a `SpendRequest`
    /// is `confirm_spend`, which requires `receipts` to cover every rule in the wallet's `SpendPolicy`.
    /// Not generic over the coin type: `confirm_spend<T>` supplies `T` explicitly at the call site.
    public struct SpendRequest {
        wallet: ID,
        amount: u64,
        target_package: address,
        coin_in: TypeName,
        coin_out: TypeName,
        recipient: address,
        receipts: VecSet<TypeName>,
    }

    // ── events ──
    public struct WalletCreated has copy, drop {
        wallet: ID,
        owner: address,
        agent: address,
        budget: u64,
        expires_at_ms: u64,
    }
    public struct Spent has copy, drop { wallet: ID, amount: u64, spent_total: u64, remaining: u64 }
    public struct ToppedUp has copy, drop { wallet: ID, amount: u64, remaining: u64 }
    public struct Revoked has copy, drop { wallet: ID, reclaimed: u64 }
    /// Emitted when the owner rotates which agent (and which `AgentCap`) can spend from the wallet.
    public struct AgentRotated has copy, drop {
        wallet: ID,
        old_agent: address,
        new_agent: address,
        old_cap: ID,
        new_cap: ID,
    }
    /// Emitted by owner-only config setters that aren't rule attach/detach (currently: `extend_expiry`
    /// only, since per-tx/window/scope/etc. moved to rules). `field` names the changed field.
    public struct ConfigChanged has copy, drop {
        wallet: ID,
        field: vector<u8>,
        old_value: u64,
        new_value: u64,
    }
    /// Emitted when the owner attaches a restriction rule to the wallet's `SpendPolicy`.
    public struct RuleAdded has copy, drop { wallet: ID, rule: TypeName }
    /// Emitted when the owner detaches a restriction rule from the wallet's `SpendPolicy`.
    public struct RuleRemoved has copy, drop { wallet: ID, rule: TypeName }

    /// Owner creates + funds a wallet and mints the `AgentCap` to `agent`. The wallet is shared with
    /// an EMPTY `SpendPolicy` (no rules attached, so `confirm_spend` requires zero receipts) — the
    /// owner is expected to follow with `add_rule` calls (via each rule module's `add`) in the SAME
    /// PTB before ever handing the cap to the agent. `request_spend`/`confirm_spend` do not refuse to
    /// operate on an empty policy; composing at least one restriction is an owner/SDK responsibility
    /// (see `@rill/sdk`'s `CapabilityManifest`, which rejects an empty rule set as unsafe).
    public fun create_wallet<T>(
        version: &Version,
        funds: Coin<T>,
        agent: address,
        expires_at_ms: u64,
        ctx: &mut TxContext,
    ) {
        version.check_is_valid();
        let owner = ctx.sender();
        let budget = funds.into_balance();
        let amount = budget.value();

        let wallet_uid = object::new(ctx);
        let wallet_id = object::uid_to_inner(&wallet_uid);
        let cap = AgentCap { id: object::new(ctx), wallet: wallet_id };
        let cap_id = object::id(&cap);

        let wallet = AgentWallet<T> {
            id: wallet_uid,
            owner,
            agent,
            cap_id,
            budget,
            spent: 0,
            expires_at_ms,
            revoked: false,
            policy: SpendPolicy { id: object::new(ctx), rules: vec_set::empty() },
        };
        event::emit(WalletCreated { wallet: wallet_id, owner, agent, budget: amount, expires_at_ms });
        transfer::transfer(cap, agent);
        transfer::share_object(wallet);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Rule + Hot Potato spend flow
    // ══════════════════════════════════════════════════════════════════════

    /// Mint a `SpendRequest` hot potato. Checks cap validity, agent-sender, revocation, expiry, and a
    /// non-zero amount within physical funds — but does NOT release any coin and does NOT touch any
    /// rule. The caller must then route the request through every attached rule's `prove` (in any
    /// order) and finally `confirm_spend`, or the transaction aborts (the potato cannot be dropped).
    public fun request_spend<T>(
        wallet: &AgentWallet<T>,
        cap: &AgentCap,
        version: &Version,
        amount: u64,
        target_package: address,
        coin_in: TypeName,
        coin_out: TypeName,
        recipient: address,
        clock: &Clock,
        ctx: &TxContext,
    ): SpendRequest {
        version.check_is_valid();
        assert!(cap.wallet == object::id(wallet), E_BAD_CAP);
        assert!(object::id(cap) == wallet.cap_id, E_BAD_CAP);
        assert!(ctx.sender() == wallet.agent, E_NOT_AGENT);
        assert!(!wallet.revoked, E_REVOKED);
        assert!(clock.timestamp_ms() < wallet.expires_at_ms, E_EXPIRED);
        assert!(amount > 0, E_ZERO_AMOUNT);
        assert!(amount <= wallet.budget.value(), E_INSUFFICIENT_FUNDS);

        SpendRequest {
            wallet: object::id(wallet),
            amount,
            target_package,
            coin_in,
            coin_out,
            recipient,
            receipts: vec_set::empty(),
        }
    }

    /// Adds a rule's receipt to the request, unblocking it — called by a rule module's own `prove`
    /// after that rule's invariant check passes. `_: Rule` can only be constructed inside the rule's
    /// own module, so no other code can forge a receipt for a rule it doesn't own.
    public fun add_receipt<Rule: drop>(_: Rule, req: &mut SpendRequest) {
        req.receipts.insert(type_name::with_defining_ids<Rule>());
    }

    /// Unpack the hot potato and release the coin — but only if `req` carries a receipt for every
    /// rule attached to `wallet`'s `SpendPolicy` (set-equality, order-independent; mirrors
    /// `sui::transfer_policy::confirm_request`). `clock` is re-checked against `expires_at_ms` as
    /// defense-in-depth (a `SpendRequest` cannot outlive the PTB that minted it, so within one
    /// transaction this always matches `request_spend`'s check, but the redundancy costs nothing and
    /// guards any future flow where the two calls are no longer adjacent).
    public fun confirm_spend<T>(
        wallet: &mut AgentWallet<T>,
        req: SpendRequest,
        version: &Version,
        clock: &Clock,
        ctx: &mut TxContext,
    ): Coin<T> {
        version.check_is_valid();
        let SpendRequest {
            wallet: req_wallet,
            amount,
            target_package: _,
            coin_in: _,
            coin_out: _,
            recipient: _,
            receipts,
        } = req;
        assert!(req_wallet == object::id(wallet), E_WRONG_WALLET);
        assert!(!wallet.revoked, E_REVOKED);
        assert!(clock.timestamp_ms() < wallet.expires_at_ms, E_EXPIRED);

        let required = &wallet.policy.rules;
        let mut satisfied = receipts.into_keys();
        assert!(satisfied.length() == required.length(), E_RULE_NOT_SATISFIED);
        while (!satisfied.is_empty()) {
            let rule_type = satisfied.pop_back();
            assert!(required.contains(&rule_type), E_RULE_NOT_SATISFIED);
        };

        assert!(amount <= wallet.budget.value(), E_INSUFFICIENT_FUNDS);
        let out = coin::take(&mut wallet.budget, amount, ctx);
        wallet.spent = wallet.spent + amount;
        event::emit(Spent {
            wallet: object::id(wallet),
            amount,
            spent_total: wallet.spent,
            remaining: wallet.budget.value(),
        });
        out
    }

    // ── SpendRequest views (used by rule modules' `prove`) ──
    public fun request_wallet(req: &SpendRequest): ID { req.wallet }
    public fun request_amount(req: &SpendRequest): u64 { req.amount }
    public fun request_target_package(req: &SpendRequest): address { req.target_package }
    public fun request_coin_in(req: &SpendRequest): TypeName { req.coin_in }
    public fun request_coin_out(req: &SpendRequest): TypeName { req.coin_out }
    public fun request_recipient(req: &SpendRequest): address { req.recipient }

    // ══════════════════════════════════════════════════════════════════════
    // Rule attach/detach — owner-only (R4: the agent can never mutate rules)
    // ══════════════════════════════════════════════════════════════════════

    /// Attach a rule: only the wallet owner may call this (checked here, not delegated to the rule
    /// module), and `_: Rule` can only be constructed by the rule's own module — so a rule can only be
    /// attached by cooperation of both the owner (transaction sender) and that rule's code. Aborts if
    /// the rule is already attached.
    ///
    /// Deliberately NOT version-gated (see the module doc comment): owner-only ops must never be
    /// trapped by a pending upgrade. `_version` is kept in the signature — unused — purely so every
    /// rule module's `add<T>(wallet, version, cfg, ctx)` wrapper keeps its existing shape; dropping the
    /// parameter here would cascade into all 8 rule modules' `add`/`remove` for no safety benefit,
    /// since none of them do anything with it beyond forwarding it to this call.
    #[allow(lint(unused_object_with_fields))]
    public fun add_rule<T, Rule: drop, Config: store + drop>(
        _: Rule,
        wallet: &mut AgentWallet<T>,
        _version: &Version,
        cfg: Config,
        ctx: &TxContext,
    ) {
        assert!(ctx.sender() == wallet.owner, E_NOT_OWNER);
        let rule_type = type_name::with_defining_ids<Rule>();
        assert!(!wallet.policy.rules.contains(&rule_type), E_RULE_ALREADY_SET);
        df::add(&mut wallet.policy.id, RuleKey<Rule> {}, cfg);
        wallet.policy.rules.insert(rule_type);
        event::emit(RuleAdded { wallet: object::id(wallet), rule: rule_type });
    }

    /// Detach a rule and drop its config. Owner-only. Aborts (via the underlying `dynamic_field`
    /// remove) if the rule isn't currently attached.
    ///
    /// Deliberately NOT version-gated — see `add_rule`'s doc comment: an owner must always be able to
    /// detach a rule, even mid-upgrade, and `_version` stays only so rule modules' `remove` wrappers
    /// keep their existing shape.
    #[allow(lint(unused_object_with_fields))]
    public fun remove_rule<T, Rule: drop, Config: store + drop>(
        wallet: &mut AgentWallet<T>,
        _version: &Version,
        ctx: &TxContext,
    ) {
        assert!(ctx.sender() == wallet.owner, E_NOT_OWNER);
        let rule_type = type_name::with_defining_ids<Rule>();
        let _cfg: Config = df::remove(&mut wallet.policy.id, RuleKey<Rule> {});
        wallet.policy.rules.remove(&rule_type);
        event::emit(RuleRemoved { wallet: object::id(wallet), rule: rule_type });
    }

    /// Read-only borrow of a rule's stored config. Witness-gated (mirrors
    /// `sui::transfer_policy::get_rule`) so only that rule's own module can read its config.
    public fun rule_config<T, Rule: drop, Config: store + drop>(
        _: Rule,
        wallet: &AgentWallet<T>,
    ): &Config {
        df::borrow(&wallet.policy.id, RuleKey<Rule> {})
    }

    /// Mutable borrow of a rule's stored config — for rules with rolling/mutable state (e.g.
    /// `rate_limit`'s window bookkeeping). Witness-gated: only that rule's own module can construct
    /// `Rule`, so no other code (including the agent) can reach in and mutate a rule's state directly.
    public fun rule_config_mut<T, Rule: drop, Config: store + drop>(
        _: Rule,
        wallet: &mut AgentWallet<T>,
    ): &mut Config {
        df::borrow_mut(&mut wallet.policy.id, RuleKey<Rule> {})
    }

    /// Whether `Rule` is currently attached to `wallet`'s policy.
    public fun has_rule<T, Rule: drop>(wallet: &AgentWallet<T>): bool {
        df::exists(&wallet.policy.id, RuleKey<Rule> {})
    }

    /// The set of rule witnesses currently attached (insertion order, not sorted).
    public fun policy_rules<T>(wallet: &AgentWallet<T>): vector<TypeName> {
        *wallet.policy.rules.keys()
    }

    // ══════════════════════════════════════════════════════════════════════
    // Wallet lifecycle — owner-only
    // ══════════════════════════════════════════════════════════════════════

    /// Owner adds more funds to the budget. Not version-gated — see the module doc comment.
    public fun top_up<T>(wallet: &mut AgentWallet<T>, funds: Coin<T>, ctx: &TxContext) {
        assert!(ctx.sender() == wallet.owner, E_NOT_OWNER);
        let amount = funds.value();
        wallet.budget.join(funds.into_balance());
        event::emit(ToppedUp { wallet: object::id(wallet), amount, remaining: wallet.budget.value() });
    }

    /// Owner kills the wallet and reclaims all remaining funds. Future `request_spend`/`confirm_spend`
    /// abort (`E_REVOKED`).
    ///
    /// The critical case for NOT version-gating owner ops (see the module doc comment): `revoke` is
    /// the fund-reclaim kill-switch, and it must keep working even against a `Version` object stuck
    /// stale between a package upgrade and its `migrate` call — an owner can never be trapped out of
    /// pulling their own funds back.
    public fun revoke<T>(wallet: &mut AgentWallet<T>, ctx: &mut TxContext): Coin<T> {
        assert!(ctx.sender() == wallet.owner, E_NOT_OWNER);
        wallet.revoked = true;
        let amount = wallet.budget.value();
        let out = coin::take(&mut wallet.budget, amount, ctx);
        event::emit(Revoked { wallet: object::id(wallet), reclaimed: amount });
        out
    }

    /// Owner-only: retire the current agent/cap pair and mint a fresh `AgentCap` for `new_agent`. The
    /// old cap object still exists wherever it was last held, but instantly fails `request_spend`'s
    /// `cap_id` check since it no longer matches `wallet.cap_id`. Not version-gated — see the module
    /// doc comment; an owner must be able to cut off a compromised agent regardless of upgrade state.
    public fun rotate_agent<T>(
        wallet: &mut AgentWallet<T>,
        new_agent: address,
        ctx: &mut TxContext,
    ) {
        assert!(ctx.sender() == wallet.owner, E_NOT_OWNER);
        let old_agent = wallet.agent;
        let old_cap = wallet.cap_id;

        let cap = AgentCap { id: object::new(ctx), wallet: object::id(wallet) };
        let new_cap = object::id(&cap);
        wallet.agent = new_agent;
        wallet.cap_id = new_cap;

        event::emit(AgentRotated { wallet: object::id(wallet), old_agent, new_agent, old_cap, new_cap });
        transfer::transfer(cap, new_agent);
    }

    /// Owner-only: push expiry forward. Only forward — `new_expires_at_ms` must be strictly greater
    /// than the current `expires_at_ms`, so this can re-enable an expired wallet but can never be used
    /// to shorten a live wallet's remaining lifetime. Not version-gated — see the module doc comment.
    public fun extend_expiry<T>(
        wallet: &mut AgentWallet<T>,
        new_expires_at_ms: u64,
        ctx: &TxContext,
    ) {
        assert!(ctx.sender() == wallet.owner, E_NOT_OWNER);
        assert!(new_expires_at_ms > wallet.expires_at_ms, E_EXPIRY_NOT_FORWARD);
        let old_value = wallet.expires_at_ms;
        wallet.expires_at_ms = new_expires_at_ms;
        event::emit(ConfigChanged {
            wallet: object::id(wallet),
            field: b"expires_at_ms",
            old_value,
            new_value: new_expires_at_ms,
        });
    }

    // ── views ──
    public fun remaining<T>(wallet: &AgentWallet<T>): u64 { wallet.budget.value() }
    public fun spent<T>(wallet: &AgentWallet<T>): u64 { wallet.spent }
    public fun is_active<T>(wallet: &AgentWallet<T>, clock: &Clock): bool {
        !wallet.revoked && clock.timestamp_ms() < wallet.expires_at_ms
    }
    public fun agent<T>(wallet: &AgentWallet<T>): address { wallet.agent }
    public fun owner<T>(wallet: &AgentWallet<T>): address { wallet.owner }
    public fun cap_id<T>(wallet: &AgentWallet<T>): ID { wallet.cap_id }
    public fun expires_at_ms<T>(wallet: &AgentWallet<T>): u64 { wallet.expires_at_ms }
}
