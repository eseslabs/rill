#[test_only]
module agent_wallet::agent_wallet_tests {
    use sui::test_scenario as ts;
    use sui::coin;
    use sui::sui::SUI;
    use sui::clock::{Self, Clock};
    use sui::package;
    use agent_wallet::agent_wallet::{Self as aw, AgentWallet, AgentCap, SpendRequest};
    use agent_wallet::version::{Self as av, Version};
    use agent_wallet::budget;
    use agent_wallet::per_tx;
    use agent_wallet::rate_limit;
    use agent_wallet::time_window;

    const OWNER: address = @0xA;
    const AGENT: address = @0xB;
    const NEW_AGENT: address = @0xD;

    // Mirror agent_wallet::agent_wallet's abort codes (constants are module-private).
    const E_NOT_OWNER: u64 = 1;
    const E_REVOKED: u64 = 2;
    const E_EXPIRED: u64 = 3;
    const E_INSUFFICIENT_FUNDS: u64 = 4;
    const E_BAD_CAP: u64 = 5;
    const E_ZERO_AMOUNT: u64 = 6;
    const E_EXPIRY_NOT_FORWARD: u64 = 8;
    const E_WRONG_WALLET: u64 = 9;
    const E_RULE_NOT_SATISFIED: u64 = 10;
    const E_RULE_ALREADY_SET: u64 = 11;

    // Mirror each rule module's own (private) abort code.
    const BUDGET_E_OVER_BUDGET: u64 = 1;
    const PER_TX_E_OVER_PER_TX: u64 = 1;
    const RATE_LIMIT_E_OVER_WINDOW: u64 = 1;
    const TIME_WINDOW_E_OUTSIDE: u64 = 1;

    // Mirror agent_wallet::version's own (private) abort codes.
    const VERSION_E_INVALID_PACKAGE_VERSION: u64 = 0;
    const VERSION_E_INVALID_PUBLISHER: u64 = 1;

    /// A test-only witness usable as a "same-package" One-Time-Witness stand-in for
    /// `sui::package::test_claim` — any droppable value defined *within* the `agent_wallet` package
    /// works, since `Publisher::from_package` only compares the package address, not the module.
    public struct TEST_OTW has drop {}

    // ══════════════════════════════════════════════════════════════════════
    // helpers
    // ══════════════════════════════════════════════════════════════════════

    /// Boot the package version + create a funded wallet (AGENT-held cap), leaving both the Version
    /// and the AgentWallet shared, ready to be taken by the test body.
    fun create(scenario: &mut ts::Scenario, amount: u64, expires_at_ms: u64) {
        ts::next_tx(scenario, OWNER);
        av::init_for_testing(ts::ctx(scenario));

        ts::next_tx(scenario, OWNER);
        let v = ts::take_shared<Version>(scenario);
        let funds = coin::mint_for_testing<SUI>(amount, ts::ctx(scenario));
        aw::create_wallet<SUI>(&v, funds, AGENT, expires_at_ms, ts::ctx(scenario));
        ts::return_shared(v);
    }

    fun take_agent_side(scenario: &ts::Scenario): (Version, AgentWallet<SUI>, AgentCap) {
        (
            ts::take_shared<Version>(scenario),
            ts::take_shared<AgentWallet<SUI>>(scenario),
            ts::take_from_sender<AgentCap>(scenario),
        )
    }

    fun return_agent_side(scenario: &ts::Scenario, v: Version, w: AgentWallet<SUI>, c: AgentCap) {
        ts::return_shared(v);
        ts::return_shared(w);
        ts::return_to_sender(scenario, c);
    }

    fun take_owner_side(scenario: &ts::Scenario): (Version, AgentWallet<SUI>) {
        (ts::take_shared<Version>(scenario), ts::take_shared<AgentWallet<SUI>>(scenario))
    }

    fun return_owner_side(v: Version, w: AgentWallet<SUI>) {
        ts::return_shared(v);
        ts::return_shared(w);
    }

    fun new_request(
        scenario: &mut ts::Scenario,
        wallet: &AgentWallet<SUI>,
        cap: &AgentCap,
        version: &Version,
        amount: u64,
        clk: &Clock,
    ): SpendRequest {
        aw::request_spend<SUI>(wallet, cap, version, amount, clk, ts::ctx(scenario))
    }

    /// Consume a `SpendRequest` (the hot potato has no `drop`, so every code path — including ones
    /// that never execute at runtime because an earlier call already aborted — must route it through
    /// `confirm_spend` or an equivalent consuming call) and discard the resulting coin. Used in
    /// `expected_failure` tests where the coin's value isn't the point.
    fun drain(scenario: &mut ts::Scenario, wallet: &mut AgentWallet<SUI>, req: SpendRequest, version: &Version, clk: &Clock) {
        let out = aw::confirm_spend<SUI>(wallet, req, version, clk, ts::ctx(scenario));
        coin::burn_for_testing(out);
    }

    // ══════════════════════════════════════════════════════════════════════
    // Hot potato core (write the adversarial invariant-locking test FIRST)
    // ══════════════════════════════════════════════════════════════════════

    // ── confirm_spend aborts when an attached rule has no receipt: nothing releases ──
    #[test, expected_failure(abort_code = E_RULE_NOT_SATISFIED, location = aw)]
    fun confirm_aborts_when_rule_receipt_missing() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 100_000, 1_000_000);

        ts::next_tx(&mut sc, OWNER);
        let (v, mut wallet) = take_owner_side(&sc);
        budget::add<SUI>(&mut wallet, &v, 5_000, ts::ctx(&mut sc));
        per_tx::add<SUI>(&mut wallet, &v, 5_000, ts::ctx(&mut sc));
        return_owner_side(v, wallet);

        ts::next_tx(&mut sc, AGENT);
        let (v, mut wallet, cap) = take_agent_side(&sc);
        let clk = clock::create_for_testing(ts::ctx(&mut sc));
        let mut req = new_request(&mut sc, &wallet, &cap, &v, 300, &clk);

        // Only `budget` proves; `per_tx` is attached but never gets a receipt.
        budget::prove<SUI>(&mut req, &mut wallet, &v);

        // Must abort here — the potato cannot be dropped, and per_tx's receipt is missing.
        drain(&mut sc, &mut wallet, req, &v, &clk);

        clock::destroy_for_testing(clk);
        return_agent_side(&sc, v, wallet, cap);
        ts::end(sc);
    }

    // ── all attached rules proven → coin releases ──
    #[test]
    fun confirm_releases_coin_when_all_rules_proven() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 100_000, 1_000_000);

        ts::next_tx(&mut sc, OWNER);
        let (v, mut wallet) = take_owner_side(&sc);
        budget::add<SUI>(&mut wallet, &v, 5_000, ts::ctx(&mut sc));
        per_tx::add<SUI>(&mut wallet, &v, 5_000, ts::ctx(&mut sc));
        rate_limit::add<SUI>(&mut wallet, &v, 1_000, 5_000, ts::ctx(&mut sc));
        return_owner_side(v, wallet);

        ts::next_tx(&mut sc, AGENT);
        let (v, mut wallet, cap) = take_agent_side(&sc);
        let clk = clock::create_for_testing(ts::ctx(&mut sc));
        let mut req = new_request(&mut sc, &wallet, &cap, &v, 300, &clk);

        budget::prove<SUI>(&mut req, &mut wallet, &v);
        per_tx::prove<SUI>(&mut req, &wallet, &v);
        rate_limit::prove<SUI>(&mut req, &mut wallet, &v, &clk);

        let out = aw::confirm_spend<SUI>(&mut wallet, req, &v, &clk, ts::ctx(&mut sc));
        assert!(coin::value(&out) == 300, 0);
        assert!(aw::remaining(&wallet) == 99_700, 1);
        assert!(aw::spent(&wallet) == 300, 2);

        coin::burn_for_testing(out);
        clock::destroy_for_testing(clk);
        return_agent_side(&sc, v, wallet, cap);
        ts::end(sc);
    }

    // ── attach/detach changes what confirm requires: 1 receipt required, then 0 ──
    #[test]
    fun attach_detach_changes_confirm_requirement() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 100_000, 1_000_000);

        ts::next_tx(&mut sc, OWNER);
        let (v, mut wallet) = take_owner_side(&sc);
        budget::add<SUI>(&mut wallet, &v, 5_000, ts::ctx(&mut sc));
        return_owner_side(v, wallet);

        // With `budget` attached: proving it satisfies confirm.
        ts::next_tx(&mut sc, AGENT);
        let (v, mut wallet, cap) = take_agent_side(&sc);
        let clk = clock::create_for_testing(ts::ctx(&mut sc));
        let mut req1 = new_request(&mut sc, &wallet, &cap, &v, 100, &clk);
        budget::prove<SUI>(&mut req1, &mut wallet, &v);
        let out1 = aw::confirm_spend<SUI>(&mut wallet, req1, &v, &clk, ts::ctx(&mut sc));
        coin::burn_for_testing(out1);
        return_agent_side(&sc, v, wallet, cap);

        // Owner detaches `budget`.
        ts::next_tx(&mut sc, OWNER);
        let (v, mut wallet) = take_owner_side(&sc);
        budget::remove<SUI>(&mut wallet, &v, ts::ctx(&mut sc));
        return_owner_side(v, wallet);

        // Now confirm requires zero receipts — an unproven request still succeeds.
        ts::next_tx(&mut sc, AGENT);
        let (v, mut wallet, cap) = take_agent_side(&sc);
        let req2 = new_request(&mut sc, &wallet, &cap, &v, 100, &clk);
        let out2 = aw::confirm_spend<SUI>(&mut wallet, req2, &v, &clk, ts::ctx(&mut sc));
        assert!(coin::value(&out2) == 100, 0);

        coin::burn_for_testing(out2);
        clock::destroy_for_testing(clk);
        return_agent_side(&sc, v, wallet, cap);
        ts::end(sc);
    }

    // ── non-owner add_rule aborts (covers R4: agent can never mutate rules) ──
    #[test, expected_failure(abort_code = E_NOT_OWNER, location = aw)]
    fun add_rule_by_non_owner_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 100_000, 1_000_000);
        ts::next_tx(&mut sc, AGENT); // agent is not the owner
        let (v, mut wallet) = take_owner_side(&sc);
        budget::add<SUI>(&mut wallet, &v, 5_000, ts::ctx(&mut sc));
        return_owner_side(v, wallet);
        ts::end(sc);
    }

    // ── non-owner remove_rule aborts ──
    #[test, expected_failure(abort_code = E_NOT_OWNER, location = aw)]
    fun remove_rule_by_non_owner_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 100_000, 1_000_000);

        ts::next_tx(&mut sc, OWNER);
        let (v, mut wallet) = take_owner_side(&sc);
        budget::add<SUI>(&mut wallet, &v, 5_000, ts::ctx(&mut sc));
        return_owner_side(v, wallet);

        ts::next_tx(&mut sc, AGENT); // agent is not the owner
        let (v, mut wallet) = take_owner_side(&sc);
        budget::remove<SUI>(&mut wallet, &v, ts::ctx(&mut sc));
        return_owner_side(v, wallet);
        ts::end(sc);
    }

    // ── add_rule twice for the same rule type aborts ──
    #[test, expected_failure(abort_code = E_RULE_ALREADY_SET, location = aw)]
    fun add_rule_twice_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 100_000, 1_000_000);
        ts::next_tx(&mut sc, OWNER);
        let (v, mut wallet) = take_owner_side(&sc);
        budget::add<SUI>(&mut wallet, &v, 5_000, ts::ctx(&mut sc));
        budget::add<SUI>(&mut wallet, &v, 9_000, ts::ctx(&mut sc));
        return_owner_side(v, wallet);
        ts::end(sc);
    }

    // ══════════════════════════════════════════════════════════════════════
    // closed exploit: cross-wallet rule substitution (FIX 1)
    //
    // Before the fix, a rule's `prove` only checked its own invariant against whatever wallet the
    // caller happened to pass in — nothing bound that wallet to the wallet the `SpendRequest` was
    // minted against. An agent could satisfy a strict wallet's rule receipts by `prove`-ing against a
    // second, permissive, self-owned "shadow" wallet, then `confirm_spend` the request against the
    // real wallet (which only checks `req.wallet == id(wallet)` for itself). `add_receipt` — the single
    // funnel every rule's `prove` routes through — now asserts `object::id(wallet) == req.wallet`
    // first, closing the hole at its single choke point instead of in every rule individually.
    // ══════════════════════════════════════════════════════════════════════

    #[test, expected_failure(abort_code = E_WRONG_WALLET, location = aw)]
    fun cross_wallet_rule_substitution_aborts() {
        let mut sc = ts::begin(OWNER);
        ts::next_tx(&mut sc, OWNER);
        av::init_for_testing(ts::ctx(&mut sc));

        // Wallet W: owner OWNER, agent AGENT, per_tx capped at 100.
        ts::next_tx(&mut sc, OWNER);
        let v = ts::take_shared<Version>(&sc);
        let funds_w = coin::mint_for_testing<SUI>(1_000_000, ts::ctx(&mut sc));
        aw::create_wallet<SUI>(&v, funds_w, AGENT, 1_000_000, ts::ctx(&mut sc));
        ts::return_shared(v);

        let effects_w = ts::next_tx(&mut sc, OWNER);
        let shared_w = ts::shared(&effects_w);
        let wallet_w_id = *shared_w.borrow(0);
        let cap_w_id = ts::most_recent_id_for_address<AgentCap>(AGENT).destroy_some();

        let (v, mut wallet_w) = take_owner_side(&sc); // the only wallet so far == W
        per_tx::add<SUI>(&mut wallet_w, &v, 100, ts::ctx(&mut sc));
        return_owner_side(v, wallet_w);

        // Attacker (AGENT) mints a second, self-owned wallet W2 with a permissive per_tx cap.
        ts::next_tx(&mut sc, AGENT);
        let v = ts::take_shared<Version>(&sc);
        let funds_w2 = coin::mint_for_testing<SUI>(1_000_000, ts::ctx(&mut sc));
        aw::create_wallet<SUI>(&v, funds_w2, AGENT, 1_000_000, ts::ctx(&mut sc)); // owner = AGENT (sender)
        ts::return_shared(v);

        let effects_w2 = ts::next_tx(&mut sc, AGENT);
        let shared_w2 = ts::shared(&effects_w2);
        let wallet_w2_id = *shared_w2.borrow(0);

        let v = ts::take_shared<Version>(&sc);
        let mut wallet_w2 = ts::take_shared_by_id<AgentWallet<SUI>>(&sc, wallet_w2_id);
        per_tx::add<SUI>(&mut wallet_w2, &v, 1_000_000, ts::ctx(&mut sc)); // huge cap; AGENT owns W2
        ts::return_shared(v);
        ts::return_shared(wallet_w2);

        // Attacker requests a large spend against W, then tries to satisfy per_tx by proving against
        // W2's permissive config instead of W's tight one.
        ts::next_tx(&mut sc, AGENT);
        let v = ts::take_shared<Version>(&sc);
        let mut wallet_w = ts::take_shared_by_id<AgentWallet<SUI>>(&sc, wallet_w_id);
        let cap_w = ts::take_from_sender_by_id<AgentCap>(&sc, cap_w_id);
        let clk = clock::create_for_testing(ts::ctx(&mut sc));
        let mut req = new_request(&mut sc, &wallet_w, &cap_w, &v, 100_000, &clk);

        let wallet_w2 = ts::take_shared_by_id<AgentWallet<SUI>>(&sc, wallet_w2_id);
        // Without the FIX 1 wallet-binding check, per_tx's own assert would pass here (100_000 <=
        // 1_000_000, W2's cap) — this must abort E_WRONG_WALLET before that can happen.
        per_tx::prove<SUI>(&mut req, &wallet_w2, &v);

        // Unreachable: the assert above always aborts first.
        ts::return_shared(wallet_w2);
        drain(&mut sc, &mut wallet_w, req, &v, &clk);
        clock::destroy_for_testing(clk);
        ts::return_shared(v);
        ts::return_shared(wallet_w);
        ts::return_to_sender(&sc, cap_w);
        ts::end(sc);
    }

    // ══════════════════════════════════════════════════════════════════════
    // rules::budget
    // ══════════════════════════════════════════════════════════════════════

    #[test]
    fun budget_passes_within_ceiling() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 100_000, 1_000_000);
        ts::next_tx(&mut sc, OWNER);
        let (v, mut wallet) = take_owner_side(&sc);
        budget::add<SUI>(&mut wallet, &v, 500, ts::ctx(&mut sc));
        return_owner_side(v, wallet);

        ts::next_tx(&mut sc, AGENT);
        let (v, mut wallet, cap) = take_agent_side(&sc);
        let clk = clock::create_for_testing(ts::ctx(&mut sc));
        let mut req = new_request(&mut sc, &wallet, &cap, &v, 300, &clk);
        budget::prove<SUI>(&mut req, &mut wallet, &v);
        let out = aw::confirm_spend<SUI>(&mut wallet, req, &v, &clk, ts::ctx(&mut sc));
        assert!(coin::value(&out) == 300, 0);

        coin::burn_for_testing(out);
        clock::destroy_for_testing(clk);
        return_agent_side(&sc, v, wallet, cap);
        ts::end(sc);
    }

    #[test, expected_failure(abort_code = BUDGET_E_OVER_BUDGET, location = budget)]
    fun budget_blocks_over_ceiling() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 100_000, 1_000_000);
        ts::next_tx(&mut sc, OWNER);
        let (v, mut wallet) = take_owner_side(&sc);
        budget::add<SUI>(&mut wallet, &v, 500, ts::ctx(&mut sc));
        return_owner_side(v, wallet);

        ts::next_tx(&mut sc, AGENT);
        let (v, mut wallet, cap) = take_agent_side(&sc);
        let clk = clock::create_for_testing(ts::ctx(&mut sc));
        let mut req = new_request(&mut sc, &wallet, &cap, &v, 600, &clk); // 600 > 500
        budget::prove<SUI>(&mut req, &mut wallet, &v);

        drain(&mut sc, &mut wallet, req, &v, &clk);
        clock::destroy_for_testing(clk);
        return_agent_side(&sc, v, wallet, cap);
        ts::end(sc);
    }

    // ── closed exploit: budget TOCTOU across batched requests in one PTB (FIX 2) ──
    //
    // Before the fix, `budget::prove` read `wallet.spent()` — which only advances at `confirm_spend`
    // — through an immutable ref. Two `request_spend` + `budget::prove` pairs minted before either is
    // confirmed would both observe the same stale baseline and could jointly clear a ceiling neither
    // could clear alone. `budget::Config` now carries its own eager `spent` counter, committed inside
    // `prove` itself (mirroring `rate_limit`), so the second `prove` in a batch sees the first's
    // reservation immediately.
    #[test, expected_failure(abort_code = BUDGET_E_OVER_BUDGET, location = budget)]
    fun budget_batched_requests_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1_000, 1_000_000);
        ts::next_tx(&mut sc, OWNER);
        let (v, mut wallet) = take_owner_side(&sc);
        budget::add<SUI>(&mut wallet, &v, 150, ts::ctx(&mut sc));
        return_owner_side(v, wallet);

        ts::next_tx(&mut sc, AGENT);
        let (v, mut wallet, cap) = take_agent_side(&sc);
        let clk = clock::create_for_testing(ts::ctx(&mut sc));

        // First request_spend + budget::prove, still unconfirmed: eagerly commits cfg.spent = 80.
        let mut req1 = new_request(&mut sc, &wallet, &cap, &v, 80, &clk);
        budget::prove<SUI>(&mut req1, &mut wallet, &v);

        // Second request_spend + budget::prove in the same batch, BEFORE req1 is confirmed:
        // wallet.spent() is still 0, but cfg.spent is already 80 — 80 + 80 > 150 must abort here.
        let mut req2 = new_request(&mut sc, &wallet, &cap, &v, 80, &clk);
        budget::prove<SUI>(&mut req2, &mut wallet, &v);

        // Unreachable: the second prove above always aborts first.
        drain(&mut sc, &mut wallet, req1, &v, &clk);
        drain(&mut sc, &mut wallet, req2, &v, &clk);
        clock::destroy_for_testing(clk);
        return_agent_side(&sc, v, wallet, cap);
        ts::end(sc);
    }

    // ══════════════════════════════════════════════════════════════════════
    // rules::per_tx
    // ══════════════════════════════════════════════════════════════════════

    #[test]
    fun per_tx_passes_within_cap() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 100_000, 1_000_000);
        ts::next_tx(&mut sc, OWNER);
        let (v, mut wallet) = take_owner_side(&sc);
        per_tx::add<SUI>(&mut wallet, &v, 500, ts::ctx(&mut sc));
        return_owner_side(v, wallet);

        ts::next_tx(&mut sc, AGENT);
        let (v, mut wallet, cap) = take_agent_side(&sc);
        let clk = clock::create_for_testing(ts::ctx(&mut sc));
        let mut req = new_request(&mut sc, &wallet, &cap, &v, 500, &clk); // == cap
        per_tx::prove<SUI>(&mut req, &wallet, &v);
        let out = aw::confirm_spend<SUI>(&mut wallet, req, &v, &clk, ts::ctx(&mut sc));
        assert!(coin::value(&out) == 500, 0);

        coin::burn_for_testing(out);
        clock::destroy_for_testing(clk);
        return_agent_side(&sc, v, wallet, cap);
        ts::end(sc);
    }

    #[test, expected_failure(abort_code = PER_TX_E_OVER_PER_TX, location = per_tx)]
    fun per_tx_blocks_over_cap() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 100_000, 1_000_000);
        ts::next_tx(&mut sc, OWNER);
        let (v, mut wallet) = take_owner_side(&sc);
        per_tx::add<SUI>(&mut wallet, &v, 500, ts::ctx(&mut sc));
        return_owner_side(v, wallet);

        ts::next_tx(&mut sc, AGENT);
        let (v, mut wallet, cap) = take_agent_side(&sc);
        let clk = clock::create_for_testing(ts::ctx(&mut sc));
        let mut req = new_request(&mut sc, &wallet, &cap, &v, 600, &clk); // 600 > 500
        per_tx::prove<SUI>(&mut req, &wallet, &v);

        drain(&mut sc, &mut wallet, req, &v, &clk);
        clock::destroy_for_testing(clk);
        return_agent_side(&sc, v, wallet, cap);
        ts::end(sc);
    }

    // ══════════════════════════════════════════════════════════════════════
    // rules::rate_limit
    // ══════════════════════════════════════════════════════════════════════

    #[test]
    fun rate_limit_passes_within_window() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 100_000, 1_000_000);
        ts::next_tx(&mut sc, OWNER);
        let (v, mut wallet) = take_owner_side(&sc);
        rate_limit::add<SUI>(&mut wallet, &v, 1_000, 500, ts::ctx(&mut sc));
        return_owner_side(v, wallet);

        ts::next_tx(&mut sc, AGENT);
        let (v, mut wallet, cap) = take_agent_side(&sc);
        let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
        clk.set_for_testing(0);

        let mut req1 = new_request(&mut sc, &wallet, &cap, &v, 200, &clk);
        rate_limit::prove<SUI>(&mut req1, &mut wallet, &v, &clk);
        let out1 = aw::confirm_spend<SUI>(&mut wallet, req1, &v, &clk, ts::ctx(&mut sc));

        let mut req2 = new_request(&mut sc, &wallet, &cap, &v, 300, &clk);
        rate_limit::prove<SUI>(&mut req2, &mut wallet, &v, &clk); // 200 + 300 == window_max
        let out2 = aw::confirm_spend<SUI>(&mut wallet, req2, &v, &clk, ts::ctx(&mut sc));

        coin::burn_for_testing(out1);
        coin::burn_for_testing(out2);
        clock::destroy_for_testing(clk);
        return_agent_side(&sc, v, wallet, cap);
        ts::end(sc);
    }

    #[test, expected_failure(abort_code = RATE_LIMIT_E_OVER_WINDOW, location = rate_limit)]
    fun rate_limit_blocks_over_window() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 100_000, 1_000_000);
        ts::next_tx(&mut sc, OWNER);
        let (v, mut wallet) = take_owner_side(&sc);
        rate_limit::add<SUI>(&mut wallet, &v, 1_000, 500, ts::ctx(&mut sc));
        return_owner_side(v, wallet);

        ts::next_tx(&mut sc, AGENT);
        let (v, mut wallet, cap) = take_agent_side(&sc);
        let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
        clk.set_for_testing(0);

        let mut req1 = new_request(&mut sc, &wallet, &cap, &v, 300, &clk);
        rate_limit::prove<SUI>(&mut req1, &mut wallet, &v, &clk);
        let out1 = aw::confirm_spend<SUI>(&mut wallet, req1, &v, &clk, ts::ctx(&mut sc));
        coin::burn_for_testing(out1);

        let mut req2 = new_request(&mut sc, &wallet, &cap, &v, 300, &clk);
        rate_limit::prove<SUI>(&mut req2, &mut wallet, &v, &clk); // 300 + 300 > 500

        drain(&mut sc, &mut wallet, req2, &v, &clk);
        clock::destroy_for_testing(clk);
        return_agent_side(&sc, v, wallet, cap);
        ts::end(sc);
    }

    #[test]
    fun rate_limit_resets_after_window_elapses() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 100_000, 1_000_000);
        ts::next_tx(&mut sc, OWNER);
        let (v, mut wallet) = take_owner_side(&sc);
        rate_limit::add<SUI>(&mut wallet, &v, 1_000, 500, ts::ctx(&mut sc));
        return_owner_side(v, wallet);

        ts::next_tx(&mut sc, AGENT);
        let (v, mut wallet, cap) = take_agent_side(&sc);
        let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
        clk.set_for_testing(0);

        let mut req1 = new_request(&mut sc, &wallet, &cap, &v, 500, &clk); // fills window
        rate_limit::prove<SUI>(&mut req1, &mut wallet, &v, &clk);
        let out1 = aw::confirm_spend<SUI>(&mut wallet, req1, &v, &clk, ts::ctx(&mut sc));

        // Advance past window_start_ms(0) + window_ms(1000): the window rolls over.
        clk.set_for_testing(1_000);
        let mut req2 = new_request(&mut sc, &wallet, &cap, &v, 500, &clk);
        rate_limit::prove<SUI>(&mut req2, &mut wallet, &v, &clk); // would over-window if not reset
        let out2 = aw::confirm_spend<SUI>(&mut wallet, req2, &v, &clk, ts::ctx(&mut sc));

        let state = rate_limit::view<SUI>(&wallet);
        assert!(rate_limit::spent_in_window(state) == 500, 0);
        assert!(rate_limit::window_start_ms(state) == 1_000, 1);

        coin::burn_for_testing(out1);
        coin::burn_for_testing(out2);
        clock::destroy_for_testing(clk);
        return_agent_side(&sc, v, wallet, cap);
        ts::end(sc);
    }

    // ══════════════════════════════════════════════════════════════════════
    // rules::time_window
    // ══════════════════════════════════════════════════════════════════════

    #[test]
    fun time_window_passes_within_window() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 100_000, 1_000_000);
        ts::next_tx(&mut sc, OWNER);
        let (v, mut wallet) = take_owner_side(&sc);
        time_window::add<SUI>(&mut wallet, &v, 1_000, 5_000, ts::ctx(&mut sc));
        return_owner_side(v, wallet);

        ts::next_tx(&mut sc, AGENT);
        let (v, mut wallet, cap) = take_agent_side(&sc);
        let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
        clk.set_for_testing(2_000); // inside [1000, 5000)
        let mut req = new_request(&mut sc, &wallet, &cap, &v, 100, &clk);
        time_window::prove<SUI>(&mut req, &wallet, &v, &clk);
        let out = aw::confirm_spend<SUI>(&mut wallet, req, &v, &clk, ts::ctx(&mut sc));

        coin::burn_for_testing(out);
        clock::destroy_for_testing(clk);
        return_agent_side(&sc, v, wallet, cap);
        ts::end(sc);
    }

    #[test, expected_failure(abort_code = TIME_WINDOW_E_OUTSIDE, location = time_window)]
    fun time_window_blocks_outside_window() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 100_000, 1_000_000);
        ts::next_tx(&mut sc, OWNER);
        let (v, mut wallet) = take_owner_side(&sc);
        time_window::add<SUI>(&mut wallet, &v, 1_000, 5_000, ts::ctx(&mut sc));
        return_owner_side(v, wallet);

        ts::next_tx(&mut sc, AGENT);
        let (v, mut wallet, cap) = take_agent_side(&sc);
        let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
        clk.set_for_testing(6_000); // outside [1000, 5000)
        let mut req = new_request(&mut sc, &wallet, &cap, &v, 100, &clk);
        time_window::prove<SUI>(&mut req, &wallet, &v, &clk);

        drain(&mut sc, &mut wallet, req, &v, &clk);
        clock::destroy_for_testing(clk);
        return_agent_side(&sc, v, wallet, cap);
        ts::end(sc);
    }

    // ══════════════════════════════════════════════════════════════════════
    // wallet plumbing: request_spend guards (cap validity, expiry, revoke, zero-amount, funds)
    // ══════════════════════════════════════════════════════════════════════

    #[test, expected_failure(abort_code = E_ZERO_AMOUNT, location = aw)]
    fun request_spend_zero_amount_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 10_000);
        ts::next_tx(&mut sc, AGENT);
        let (v, mut wallet, cap) = take_agent_side(&sc);
        let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
        clk.set_for_testing(1000);
        let req = new_request(&mut sc, &wallet, &cap, &v, 0, &clk);

        drain(&mut sc, &mut wallet, req, &v, &clk);
        clock::destroy_for_testing(clk);
        return_agent_side(&sc, v, wallet, cap);
        ts::end(sc);
    }

    #[test, expected_failure(abort_code = E_INSUFFICIENT_FUNDS, location = aw)]
    fun request_spend_over_physical_funds_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 10_000);
        ts::next_tx(&mut sc, AGENT);
        let (v, mut wallet, cap) = take_agent_side(&sc);
        let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
        clk.set_for_testing(1000);
        let req = new_request(&mut sc, &wallet, &cap, &v, 2000, &clk); // > 1000 funded

        drain(&mut sc, &mut wallet, req, &v, &clk);
        clock::destroy_for_testing(clk);
        return_agent_side(&sc, v, wallet, cap);
        ts::end(sc);
    }

    #[test, expected_failure(abort_code = E_EXPIRED, location = aw)]
    fun request_spend_after_expiry_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 10_000);
        ts::next_tx(&mut sc, AGENT);
        let (v, mut wallet, cap) = take_agent_side(&sc);
        let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
        clk.set_for_testing(10_000); // ts == expiry → not (ts < expiry) → expired
        assert!(!aw::is_active(&wallet, &clk), 0);
        let req = new_request(&mut sc, &wallet, &cap, &v, 100, &clk);

        drain(&mut sc, &mut wallet, req, &v, &clk);
        clock::destroy_for_testing(clk);
        return_agent_side(&sc, v, wallet, cap);
        ts::end(sc);
    }

    #[test, expected_failure(abort_code = E_REVOKED, location = aw)]
    fun request_spend_after_revoke_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 10_000);

        ts::next_tx(&mut sc, OWNER);
        let (v, mut wallet) = take_owner_side(&sc);
        let reclaimed = aw::revoke<SUI>(&mut wallet, ts::ctx(&mut sc));
        assert!(coin::value(&reclaimed) == 1000, 0);
        coin::burn_for_testing(reclaimed);
        return_owner_side(v, wallet);

        ts::next_tx(&mut sc, AGENT);
        let (v, mut wallet, cap) = take_agent_side(&sc);
        let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
        clk.set_for_testing(1000);
        let req = new_request(&mut sc, &wallet, &cap, &v, 100, &clk);

        drain(&mut sc, &mut wallet, req, &v, &clk);
        clock::destroy_for_testing(clk);
        return_agent_side(&sc, v, wallet, cap);
        ts::end(sc);
    }

    #[test, expected_failure(abort_code = E_NOT_OWNER, location = aw)]
    fun revoke_by_non_owner_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 10_000);
        ts::next_tx(&mut sc, AGENT); // agent is not the owner
        let (v, mut wallet) = take_owner_side(&sc);
        let reclaimed = aw::revoke<SUI>(&mut wallet, ts::ctx(&mut sc));
        coin::burn_for_testing(reclaimed);
        return_owner_side(v, wallet);
        ts::end(sc);
    }

    #[test]
    fun top_up_increases_budget() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 10_000);
        ts::next_tx(&mut sc, OWNER);
        let (v, mut wallet) = take_owner_side(&sc);
        let more = coin::mint_for_testing<SUI>(500, ts::ctx(&mut sc));
        aw::top_up<SUI>(&mut wallet, more, ts::ctx(&mut sc));
        assert!(aw::remaining(&wallet) == 1500, 0);
        return_owner_side(v, wallet);
        ts::end(sc);
    }

    #[test, expected_failure(abort_code = E_NOT_OWNER, location = aw)]
    fun top_up_by_non_owner_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 10_000);
        ts::next_tx(&mut sc, AGENT);
        let (v, mut wallet) = take_owner_side(&sc);
        let more = coin::mint_for_testing<SUI>(500, ts::ctx(&mut sc));
        aw::top_up<SUI>(&mut wallet, more, ts::ctx(&mut sc));
        return_owner_side(v, wallet);
        ts::end(sc);
    }

    // ══════════════════════════════════════════════════════════════════════
    // cap rotation
    // ══════════════════════════════════════════════════════════════════════

    #[test, expected_failure(abort_code = E_BAD_CAP, location = aw)]
    fun old_cap_after_rotation_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 10_000);

        ts::next_tx(&mut sc, OWNER);
        let (v, mut wallet) = take_owner_side(&sc);
        aw::rotate_agent<SUI>(&mut wallet, NEW_AGENT, ts::ctx(&mut sc));
        return_owner_side(v, wallet);

        ts::next_tx(&mut sc, AGENT); // old agent, still physically holding the old cap
        let (v, mut wallet, old_cap) = take_agent_side(&sc);
        let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
        clk.set_for_testing(1000);
        let req = new_request(&mut sc, &wallet, &old_cap, &v, 100, &clk);

        drain(&mut sc, &mut wallet, req, &v, &clk);
        clock::destroy_for_testing(clk);
        return_agent_side(&sc, v, wallet, old_cap);
        ts::end(sc);
    }

    #[test]
    fun new_cap_after_rotation_works() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 10_000);

        ts::next_tx(&mut sc, OWNER);
        let (v, mut wallet) = take_owner_side(&sc);
        aw::rotate_agent<SUI>(&mut wallet, NEW_AGENT, ts::ctx(&mut sc));
        assert!(aw::agent(&wallet) == NEW_AGENT, 0);
        return_owner_side(v, wallet);

        ts::next_tx(&mut sc, NEW_AGENT);
        let v = ts::take_shared<Version>(&sc);
        let mut wallet = ts::take_shared<AgentWallet<SUI>>(&sc);
        let new_cap = ts::take_from_sender<AgentCap>(&sc);
        let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
        clk.set_for_testing(1000);
        let req = new_request(&mut sc, &wallet, &new_cap, &v, 100, &clk);
        let out = aw::confirm_spend<SUI>(&mut wallet, req, &v, &clk, ts::ctx(&mut sc));
        assert!(coin::value(&out) == 100, 1);

        coin::burn_for_testing(out);
        clock::destroy_for_testing(clk);
        ts::return_shared(v);
        ts::return_shared(wallet);
        ts::return_to_sender(&sc, new_cap);
        ts::end(sc);
    }

    #[test, expected_failure(abort_code = E_NOT_OWNER, location = aw)]
    fun rotate_agent_by_non_owner_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 10_000);
        ts::next_tx(&mut sc, AGENT); // agent is not the owner
        let (v, mut wallet) = take_owner_side(&sc);
        aw::rotate_agent<SUI>(&mut wallet, NEW_AGENT, ts::ctx(&mut sc));
        return_owner_side(v, wallet);
        ts::end(sc);
    }

    // ══════════════════════════════════════════════════════════════════════
    // extend_expiry
    // ══════════════════════════════════════════════════════════════════════

    #[test]
    fun extend_expiry_by_owner_succeeds() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 10_000);
        ts::next_tx(&mut sc, OWNER);
        let (v, mut wallet) = take_owner_side(&sc);
        aw::extend_expiry<SUI>(&mut wallet, 20_000, ts::ctx(&mut sc));
        assert!(aw::expires_at_ms(&wallet) == 20_000, 0);
        return_owner_side(v, wallet);
        ts::end(sc);
    }

    #[test, expected_failure(abort_code = E_NOT_OWNER, location = aw)]
    fun extend_expiry_by_non_owner_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 10_000);
        ts::next_tx(&mut sc, AGENT);
        let (v, mut wallet) = take_owner_side(&sc);
        aw::extend_expiry<SUI>(&mut wallet, 20_000, ts::ctx(&mut sc));
        return_owner_side(v, wallet);
        ts::end(sc);
    }

    #[test, expected_failure(abort_code = E_EXPIRY_NOT_FORWARD, location = aw)]
    fun extend_expiry_backwards_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 10_000);
        ts::next_tx(&mut sc, OWNER);
        let (v, mut wallet) = take_owner_side(&sc);
        aw::extend_expiry<SUI>(&mut wallet, 5_000, ts::ctx(&mut sc)); // 5000 < current 10_000
        return_owner_side(v, wallet);
        ts::end(sc);
    }

    #[test]
    fun extend_expiry_reenables_expired_wallet() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 10_000);

        ts::next_tx(&mut sc, AGENT);
        let wallet_check = ts::take_shared<AgentWallet<SUI>>(&sc);
        let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
        clk.set_for_testing(10_000); // ts == expiry → expired
        assert!(!aw::is_active(&wallet_check, &clk), 0);
        ts::return_shared(wallet_check);

        ts::next_tx(&mut sc, OWNER);
        let (v, mut wallet) = take_owner_side(&sc);
        aw::extend_expiry<SUI>(&mut wallet, 50_000, ts::ctx(&mut sc));
        assert!(aw::is_active(&wallet, &clk), 1);
        return_owner_side(v, wallet);

        ts::next_tx(&mut sc, AGENT);
        let (v, mut wallet, cap) = take_agent_side(&sc);
        let req = new_request(&mut sc, &wallet, &cap, &v, 100, &clk);
        let out = aw::confirm_spend<SUI>(&mut wallet, req, &v, &clk, ts::ctx(&mut sc));
        assert!(coin::value(&out) == 100, 2);

        coin::burn_for_testing(out);
        clock::destroy_for_testing(clk);
        return_agent_side(&sc, v, wallet, cap);
        ts::end(sc);
    }

    // ══════════════════════════════════════════════════════════════════════
    // agent_wallet::version
    // ══════════════════════════════════════════════════════════════════════

    #[test, expected_failure(abort_code = VERSION_E_INVALID_PACKAGE_VERSION, location = av)]
    fun check_is_valid_aborts_on_stale_version() {
        let mut sc = ts::begin(OWNER);
        ts::next_tx(&mut sc, OWNER);
        av::init_for_testing(ts::ctx(&mut sc));
        ts::next_tx(&mut sc, OWNER);
        let mut v = ts::take_shared<Version>(&sc);
        av::set_for_testing(&mut v, av::current_for_testing() + 1); // stale relative to compiled VERSION
        av::check_is_valid(&v);
        ts::return_shared(v);
        ts::end(sc);
    }

    #[test, expected_failure(abort_code = VERSION_E_INVALID_PACKAGE_VERSION, location = av)]
    fun request_spend_aborts_on_stale_version() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 10_000);
        ts::next_tx(&mut sc, AGENT);
        let (mut v, mut wallet, cap) = take_agent_side(&sc);
        av::set_for_testing(&mut v, av::current_for_testing() + 1);
        let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
        clk.set_for_testing(1000);
        let req = new_request(&mut sc, &wallet, &cap, &v, 100, &clk);

        drain(&mut sc, &mut wallet, req, &v, &clk);
        clock::destroy_for_testing(clk);
        return_agent_side(&sc, v, wallet, cap);
        ts::end(sc);
    }

    // ── the fund-trap regression: an upgrade can pause the agent, but must never trap the owner ──
    // With a stale/mismatched Version (simulating a package upgrade whose `migrate` hasn't run yet):
    // the owner's kill-switch (`revoke`) still succeeds and returns funds — proving owner ops are NOT
    // version-gated — while `request_spend` against that SAME stale Version still aborts
    // `E_INVALID_PACKAGE_VERSION` — proving the agent path IS. An owner must never be locked out of
    // reclaiming funds just because a package upgrade is sitting un-migrated.
    #[test, expected_failure(abort_code = VERSION_E_INVALID_PACKAGE_VERSION, location = av)]
    fun revoke_survives_stale_version_but_request_spend_does_not() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 10_000);

        // Simulate a pending, un-migrated upgrade: the shared Version is stale relative to VERSION.
        ts::next_tx(&mut sc, OWNER);
        let (mut v, mut wallet) = take_owner_side(&sc);
        av::set_for_testing(&mut v, av::current_for_testing() + 1);

        // Owner's kill-switch is unaffected: revoke still succeeds and returns every last mist.
        let reclaimed = aw::revoke<SUI>(&mut wallet, ts::ctx(&mut sc));
        assert!(coin::value(&reclaimed) == 1000, 0);
        assert!(aw::remaining(&wallet) == 0, 1);
        coin::burn_for_testing(reclaimed);
        return_owner_side(v, wallet);

        // The agent path, against the SAME stale Version, is paused: request_spend aborts here.
        ts::next_tx(&mut sc, AGENT);
        let (v, mut wallet, cap) = take_agent_side(&sc);
        let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
        clk.set_for_testing(1000);
        let req = new_request(&mut sc, &wallet, &cap, &v, 100, &clk);

        drain(&mut sc, &mut wallet, req, &v, &clk);
        clock::destroy_for_testing(clk);
        return_agent_side(&sc, v, wallet, cap);
        ts::end(sc);
    }

    #[test]
    fun migrate_succeeds_for_publisher() {
        let mut sc = ts::begin(OWNER);
        ts::next_tx(&mut sc, OWNER);
        av::init_for_testing(ts::ctx(&mut sc));
        ts::next_tx(&mut sc, OWNER);
        let mut v = ts::take_shared<Version>(&sc);
        av::set_for_testing(&mut v, 0); // simulate a stale package version

        let publisher = package::test_claim(TEST_OTW {}, ts::ctx(&mut sc));
        av::migrate(&publisher, &mut v);
        av::check_is_valid(&v); // no longer stale — must not abort

        package::burn_publisher(publisher);
        ts::return_shared(v);
        ts::end(sc);
    }

    #[test, expected_failure(abort_code = VERSION_E_INVALID_PUBLISHER, location = av)]
    fun migrate_aborts_for_non_publisher() {
        let mut sc = ts::begin(OWNER);
        ts::next_tx(&mut sc, OWNER);
        av::init_for_testing(ts::ctx(&mut sc));
        ts::next_tx(&mut sc, OWNER);
        let mut v = ts::take_shared<Version>(&sc);

        // A `TypeName` value's type is declared in `std::type_name` — a different package entirely
        // from `agent_wallet` — so the resulting Publisher fails `from_package<Version>`.
        let foreign_otw = std::type_name::with_defining_ids<bool>();
        let publisher = package::test_claim(foreign_otw, ts::ctx(&mut sc));
        av::migrate(&publisher, &mut v);

        package::burn_publisher(publisher);
        ts::return_shared(v);
        ts::end(sc);
    }
}
