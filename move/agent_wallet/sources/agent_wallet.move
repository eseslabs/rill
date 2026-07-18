/// Rill agent wallet — an on-chain, capped, revocable budget for an AI agent.
///
/// Universal: generic over the coin type `T` (any token). Protocol-agnostic — `spend()` returns a free
/// `Coin<T>` the agent uses in any PTB. Hard caps (budget, per-tx, expiry, revoke) are enforced here;
/// "protocol scope" (`allowed_packages`) is recorded on-chain but enforced at the build/policy layer
/// (Move can't intercept where a released coin is used).
///
/// v2 additions:
/// - Rolling spend-window quota (`window_ms`/`window_max`) in addition to the flat budget and
///   per-tx ceiling, lazily reset in `spend()` against the supplied `Clock`. A `window_ms` or
///   `window_max` of `0` means "no window limit" — either sentinel alone fully disables the quota
///   (no reset bookkeeping, no `E_OVER_WINDOW` assert), so a wallet created with `0, 0` behaves
///   exactly like a v1 wallet that only had a flat budget/per-tx cap.
/// - `spend()` requires `ctx.sender() == wallet.agent`, defense-in-depth alongside cap possession:
///   a leaked or stolen `AgentCap` is still useless from any other address.
/// - Cap rotation: the wallet tracks the currently active cap's id (`cap_id`); owner-only
///   `rotate_agent` mints a fresh `AgentCap` for a new agent address and retires the old one
///   instantly, even though the old cap object still physically exists in its former holder's account.
/// - Owner config setters (`set_per_tx_max`, `extend_expiry`, `set_window`) let the owner tighten or
///   loosen limits on a live wallet without revoking and recreating it. `extend_expiry` only accepts
///   a strictly later timestamp — it cannot be used to shorten a wallet's remaining lifetime.
///
/// This is a v2 package: the struct layout changed from v1 (new fields cannot be added in-place under
/// Sui's upgrade compatibility rules), so v2 ships as a fresh package rather than an upgrade. Entry
/// point names are kept stable across v1/v2 so callers only need to swap package ids.
module agent_wallet::agent_wallet {
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::clock::Clock;
    use sui::event;

    // ── abort codes ──
    const E_NOT_OWNER: u64 = 1;
    const E_REVOKED: u64 = 2;
    const E_EXPIRED: u64 = 3;
    const E_OVER_PER_TX: u64 = 4;
    const E_OVER_BUDGET: u64 = 5;
    const E_BAD_CAP: u64 = 6;
    const E_ZERO_AMOUNT: u64 = 7;
    /// v2: the rolling spend-window quota (`window_max` within `window_ms`) is exhausted for the
    /// current window. Never fires when `window_ms == 0 || window_max == 0` (no window configured).
    const E_OVER_WINDOW: u64 = 8;
    /// v2: `spend()`'s caller (`ctx.sender()`) is not the wallet's current `agent` — defense-in-depth
    /// alongside the `AgentCap` possession check, so a leaked cap alone is not sufficient.
    const E_NOT_AGENT: u64 = 9;
    /// v2: `extend_expiry` was called with a timestamp that does not move expiry strictly forward.
    const E_EXPIRY_NOT_FORWARD: u64 = 10;

    /// Shared object: the agent's capped, revocable wallet. `T` = the budget coin type (any token).
    public struct AgentWallet<phantom T> has key {
        id: UID,
        owner: address,
        agent: address,
        /// The currently active `AgentCap`'s id. `spend()` requires the caller's cap to match this —
        /// `rotate_agent` mints a fresh cap and updates this field, instantly invalidating the
        /// previous cap even though its holder still physically owns that object.
        cap_id: ID,
        budget: Balance<T>,
        spent: u64,
        per_tx_max: u64,
        /// Rolling spend-window quota length in ms. `0` (paired with `window_max == 0`) disables the
        /// window entirely — see the module doc comment for the full sentinel contract.
        window_ms: u64,
        /// Max spend allowed within any `window_ms`-long window. `0` (paired with `window_ms == 0`)
        /// disables the window entirely.
        window_max: u64,
        /// Start (ms since epoch) of the current window. Lazily rolled forward in `spend()` once
        /// `clock.timestamp_ms() >= window_start_ms + window_ms`.
        window_start_ms: u64,
        /// Amount spent since `window_start_ms`. Reset to `0` whenever the window rolls over.
        spent_in_window: u64,
        expires_at_ms: u64,
        allowed_packages: vector<address>,
        revoked: bool,
    }

    /// Capability minted to the agent — possession authorizes `spend()`, but only alongside a
    /// matching `ctx.sender() == wallet.agent` and `object::id(cap) == wallet.cap_id` (v2).
    public struct AgentCap has key, store {
        id: UID,
        wallet: ID,
    }

    // ── events ──
    public struct WalletCreated has copy, drop {
        wallet: ID,
        owner: address,
        agent: address,
        budget: u64,
        per_tx_max: u64,
        window_ms: u64,
        window_max: u64,
        expires_at_ms: u64,
        allowed_packages: vector<address>,
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
    /// Emitted by every owner-only config setter (`set_per_tx_max`, `extend_expiry`, `set_window`).
    /// `field` names the changed field so off-chain consumers can distinguish setters without a
    /// dedicated event type per field.
    public struct ConfigChanged has copy, drop {
        wallet: ID,
        field: vector<u8>,
        old_value: u64,
        new_value: u64,
    }

    /// Owner creates + funds a wallet, mints the `AgentCap` to `agent`, and shares the wallet.
    /// `window_ms`/`window_max` of `0` disables the rolling window quota (see module doc comment).
    public fun create_wallet<T>(
        funds: Coin<T>,
        agent: address,
        per_tx_max: u64,
        window_ms: u64,
        window_max: u64,
        expires_at_ms: u64,
        allowed_packages: vector<address>,
        ctx: &mut TxContext,
    ) {
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
            per_tx_max,
            window_ms,
            window_max,
            window_start_ms: 0,
            spent_in_window: 0,
            expires_at_ms,
            allowed_packages,
            revoked: false,
        };
        event::emit(WalletCreated {
            wallet: wallet_id,
            owner,
            agent,
            budget: amount,
            per_tx_max,
            window_ms,
            window_max,
            expires_at_ms,
            allowed_packages,
        });
        transfer::transfer(cap, agent);
        transfer::share_object(wallet);
    }

    /// The chokepoint: release a `Coin<T>` within the caps. Aborts if the cap doesn't match the
    /// active one, the caller isn't the current agent, over-cap, expired, revoked, or the rolling
    /// window quota is exhausted.
    public fun spend<T>(
        wallet: &mut AgentWallet<T>,
        cap: &AgentCap,
        amount: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ): Coin<T> {
        assert!(cap.wallet == object::id(wallet), E_BAD_CAP);
        assert!(object::id(cap) == wallet.cap_id, E_BAD_CAP);
        assert!(ctx.sender() == wallet.agent, E_NOT_AGENT);
        assert!(!wallet.revoked, E_REVOKED);
        assert!(clock.timestamp_ms() < wallet.expires_at_ms, E_EXPIRED);
        assert!(amount > 0, E_ZERO_AMOUNT);
        assert!(amount <= wallet.per_tx_max, E_OVER_PER_TX);
        assert!(amount <= wallet.budget.value(), E_OVER_BUDGET);

        // v2: rolling spend-window quota. Disabled entirely when either sentinel is 0.
        if (wallet.window_ms > 0 && wallet.window_max > 0) {
            let now = clock.timestamp_ms();
            if (now >= wallet.window_start_ms + wallet.window_ms) {
                wallet.window_start_ms = now;
                wallet.spent_in_window = 0;
            };
            assert!(wallet.spent_in_window + amount <= wallet.window_max, E_OVER_WINDOW);
            wallet.spent_in_window = wallet.spent_in_window + amount;
        };

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

    /// Owner adds more funds to the budget.
    public fun top_up<T>(wallet: &mut AgentWallet<T>, funds: Coin<T>, ctx: &mut TxContext) {
        assert!(ctx.sender() == wallet.owner, E_NOT_OWNER);
        let amount = funds.value();
        wallet.budget.join(funds.into_balance());
        event::emit(ToppedUp { wallet: object::id(wallet), amount, remaining: wallet.budget.value() });
    }

    /// Owner kills the wallet and reclaims all remaining funds. Future `spend()` aborts.
    public fun revoke<T>(wallet: &mut AgentWallet<T>, ctx: &mut TxContext): Coin<T> {
        assert!(ctx.sender() == wallet.owner, E_NOT_OWNER);
        wallet.revoked = true;
        let amount = wallet.budget.value();
        let out = coin::take(&mut wallet.budget, amount, ctx);
        event::emit(Revoked { wallet: object::id(wallet), reclaimed: amount });
        out
    }

    /// Owner-only: retire the current agent/cap pair and mint a fresh `AgentCap` for `new_agent`.
    /// The old cap object still exists wherever it was last held, but instantly fails `spend()`'s
    /// `cap_id` check since it no longer matches `wallet.cap_id`.
    public fun rotate_agent<T>(wallet: &mut AgentWallet<T>, new_agent: address, ctx: &mut TxContext) {
        assert!(ctx.sender() == wallet.owner, E_NOT_OWNER);
        let old_agent = wallet.agent;
        let old_cap = wallet.cap_id;

        let cap = AgentCap { id: object::new(ctx), wallet: object::id(wallet) };
        let new_cap = object::id(&cap);
        wallet.agent = new_agent;
        wallet.cap_id = new_cap;

        event::emit(AgentRotated {
            wallet: object::id(wallet),
            old_agent,
            new_agent,
            old_cap,
            new_cap,
        });
        transfer::transfer(cap, new_agent);
    }

    /// Owner-only: adjust the per-transaction spend ceiling.
    public fun set_per_tx_max<T>(wallet: &mut AgentWallet<T>, new_per_tx_max: u64, ctx: &mut TxContext) {
        assert!(ctx.sender() == wallet.owner, E_NOT_OWNER);
        let old_value = wallet.per_tx_max;
        wallet.per_tx_max = new_per_tx_max;
        event::emit(ConfigChanged {
            wallet: object::id(wallet),
            field: b"per_tx_max",
            old_value,
            new_value: new_per_tx_max,
        });
    }

    /// Owner-only: push expiry forward. Only forward — `new_expires_at_ms` must be strictly greater
    /// than the current `expires_at_ms`, so this can re-enable an expired wallet but can never be
    /// used to shorten a live wallet's remaining lifetime.
    public fun extend_expiry<T>(wallet: &mut AgentWallet<T>, new_expires_at_ms: u64, ctx: &mut TxContext) {
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

    /// Owner-only: set the rolling spend-window quota. `window_ms == 0` or `window_max == 0`
    /// disables the window entirely (see module doc comment for the sentinel contract). Takes
    /// effect immediately; does not retroactively reset an in-progress window's `spent_in_window`.
    public fun set_window<T>(wallet: &mut AgentWallet<T>, window_ms: u64, window_max: u64, ctx: &mut TxContext) {
        assert!(ctx.sender() == wallet.owner, E_NOT_OWNER);
        let old_window_ms = wallet.window_ms;
        let old_window_max = wallet.window_max;
        wallet.window_ms = window_ms;
        wallet.window_max = window_max;
        event::emit(ConfigChanged {
            wallet: object::id(wallet),
            field: b"window_ms",
            old_value: old_window_ms,
            new_value: window_ms,
        });
        event::emit(ConfigChanged {
            wallet: object::id(wallet),
            field: b"window_max",
            old_value: old_window_max,
            new_value: window_max,
        });
    }

    // ── views ──
    public fun remaining<T>(wallet: &AgentWallet<T>): u64 { wallet.budget.value() }
    public fun spent<T>(wallet: &AgentWallet<T>): u64 { wallet.spent }
    public fun is_active<T>(wallet: &AgentWallet<T>, clock: &Clock): bool {
        !wallet.revoked && clock.timestamp_ms() < wallet.expires_at_ms
    }
    public fun allowed_packages<T>(wallet: &AgentWallet<T>): vector<address> { wallet.allowed_packages }
    public fun is_allowed<T>(wallet: &AgentWallet<T>, pkg: address): bool {
        wallet.allowed_packages.is_empty() || wallet.allowed_packages.contains(&pkg)
    }
    public fun agent<T>(wallet: &AgentWallet<T>): address { wallet.agent }
    public fun cap_id<T>(wallet: &AgentWallet<T>): ID { wallet.cap_id }
    public fun per_tx_max<T>(wallet: &AgentWallet<T>): u64 { wallet.per_tx_max }
    public fun expires_at_ms<T>(wallet: &AgentWallet<T>): u64 { wallet.expires_at_ms }
    public fun window_ms<T>(wallet: &AgentWallet<T>): u64 { wallet.window_ms }
    public fun window_max<T>(wallet: &AgentWallet<T>): u64 { wallet.window_max }
    public fun window_start_ms<T>(wallet: &AgentWallet<T>): u64 { wallet.window_start_ms }
    public fun spent_in_window<T>(wallet: &AgentWallet<T>): u64 { wallet.spent_in_window }
}
