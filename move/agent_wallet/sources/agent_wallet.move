/// Rill agent wallet — an on-chain, capped, revocable budget for an AI agent.
///
/// Universal: generic over the coin type `T` (any token). Protocol-agnostic — `spend()` returns a free
/// `Coin<T>` the agent uses in any PTB. Hard caps (budget, per-tx, expiry, revoke) are enforced here;
/// "protocol scope" (`allowed_packages`) is recorded on-chain but enforced at the build/policy layer
/// (Move can't intercept where a released coin is used).
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

    /// Shared object: the agent's capped, revocable wallet. `T` = the budget coin type (any token).
    public struct AgentWallet<phantom T> has key {
        id: UID,
        owner: address,
        agent: address,
        budget: Balance<T>,
        spent: u64,
        per_tx_max: u64,
        expires_at_ms: u64,
        allowed_packages: vector<address>,
        revoked: bool,
    }

    /// Capability minted to the agent — possession authorizes `spend()`.
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
        expires_at_ms: u64,
        allowed_packages: vector<address>,
    }
    public struct Spent has copy, drop { wallet: ID, amount: u64, spent_total: u64, remaining: u64 }
    public struct ToppedUp has copy, drop { wallet: ID, amount: u64, remaining: u64 }
    public struct Revoked has copy, drop { wallet: ID, reclaimed: u64 }

    /// Owner creates + funds a wallet, mints the `AgentCap` to `agent`, and shares the wallet.
    public fun create_wallet<T>(
        funds: Coin<T>,
        agent: address,
        per_tx_max: u64,
        expires_at_ms: u64,
        allowed_packages: vector<address>,
        ctx: &mut TxContext,
    ) {
        let owner = ctx.sender();
        let budget = funds.into_balance();
        let amount = budget.value();
        let wallet = AgentWallet<T> {
            id: object::new(ctx),
            owner,
            agent,
            budget,
            spent: 0,
            per_tx_max,
            expires_at_ms,
            allowed_packages,
            revoked: false,
        };
        let wallet_id = object::id(&wallet);
        let cap = AgentCap { id: object::new(ctx), wallet: wallet_id };
        event::emit(WalletCreated {
            wallet: wallet_id,
            owner,
            agent,
            budget: amount,
            per_tx_max,
            expires_at_ms,
            allowed_packages,
        });
        transfer::transfer(cap, agent);
        transfer::share_object(wallet);
    }

    /// The chokepoint: release a `Coin<T>` within the caps. Aborts if over-cap, expired, or revoked.
    public fun spend<T>(
        wallet: &mut AgentWallet<T>,
        cap: &AgentCap,
        amount: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ): Coin<T> {
        assert!(cap.wallet == object::id(wallet), E_BAD_CAP);
        assert!(!wallet.revoked, E_REVOKED);
        assert!(clock.timestamp_ms() < wallet.expires_at_ms, E_EXPIRED);
        assert!(amount > 0, E_ZERO_AMOUNT);
        assert!(amount <= wallet.per_tx_max, E_OVER_PER_TX);
        assert!(amount <= wallet.budget.value(), E_OVER_BUDGET);

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
}
