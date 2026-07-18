#[test_only]
module agent_wallet::agent_wallet_tests {
    use sui::test_scenario as ts;
    use sui::coin::{Self};
    use sui::sui::SUI;
    use sui::clock;
    use agent_wallet::agent_wallet::{Self as aw, AgentWallet, AgentCap};

    const OWNER: address = @0xA;
    const AGENT: address = @0xB;
    const NEW_AGENT: address = @0xD;
    const STRANGER: address = @0xE;
    const PKG_A: address = @0xCAFE;
    const PKG_B: address = @0xBEEF;

    // Mirror the module's abort codes (constants are module-private) for expected_failure.
    const E_NOT_OWNER: u64 = 1;
    const E_REVOKED: u64 = 2;
    const E_EXPIRED: u64 = 3;
    const E_OVER_PER_TX: u64 = 4;
    const E_OVER_BUDGET: u64 = 5;
    const E_BAD_CAP: u64 = 6;
    const E_ZERO_AMOUNT: u64 = 7;
    const E_OVER_WINDOW: u64 = 8;
    const E_NOT_AGENT: u64 = 9;
    const E_EXPIRY_NOT_FORWARD: u64 = 10;

    fun create(
        scenario: &mut ts::Scenario,
        amount: u64,
        per_tx: u64,
        window_ms: u64,
        window_max: u64,
        expiry: u64,
        allowed: vector<address>,
    ) {
        ts::next_tx(scenario, OWNER);
        let ctx = ts::ctx(scenario);
        let funds = coin::mint_for_testing<SUI>(amount, ctx);
        aw::create_wallet<SUI>(funds, AGENT, per_tx, window_ms, window_max, expiry, allowed, ctx);
    }

    // ── happy path: spend within caps, views update ──
    #[test]
    fun spend_within_caps_updates_views() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 500, 0, 0, 10_000, vector[]);

        ts::next_tx(&mut sc, AGENT);
        let mut wallet = ts::take_shared<AgentWallet<SUI>>(&sc);
        let cap = ts::take_from_sender<AgentCap>(&sc);
        let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
        clk.set_for_testing(1000);

        assert!(aw::remaining(&wallet) == 1000, 100);
        assert!(aw::is_active(&wallet, &clk), 101);

        let out1 = aw::spend<SUI>(&mut wallet, &cap, 300, &clk, ts::ctx(&mut sc));
        assert!(coin::value(&out1) == 300, 102);
        assert!(aw::remaining(&wallet) == 700, 103);
        assert!(aw::spent(&wallet) == 300, 104);

        let out2 = aw::spend<SUI>(&mut wallet, &cap, 200, &clk, ts::ctx(&mut sc));
        assert!(aw::remaining(&wallet) == 500, 105);
        assert!(aw::spent(&wallet) == 500, 106);

        coin::burn_for_testing(out1);
        coin::burn_for_testing(out2);
        clock::destroy_for_testing(clk);
        ts::return_shared(wallet);
        ts::return_to_sender(&sc, cap);
        ts::end(sc);
    }

    // ── over per-tx cap → E_OVER_PER_TX ──
    #[test, expected_failure(abort_code = E_OVER_PER_TX, location = aw)]
    fun spend_over_per_tx_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 500, 0, 0, 10_000, vector[]);
        ts::next_tx(&mut sc, AGENT);
        let mut wallet = ts::take_shared<AgentWallet<SUI>>(&sc);
        let cap = ts::take_from_sender<AgentCap>(&sc);
        let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
        clk.set_for_testing(1000);
        let out = aw::spend<SUI>(&mut wallet, &cap, 600, &clk, ts::ctx(&mut sc)); // 600 > 500
        coin::burn_for_testing(out);
        clock::destroy_for_testing(clk);
        ts::return_shared(wallet);
        ts::return_to_sender(&sc, cap);
        ts::end(sc);
    }

    // ── over total budget → E_OVER_BUDGET ──
    #[test, expected_failure(abort_code = E_OVER_BUDGET, location = aw)]
    fun spend_over_budget_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 5000, 0, 0, 10_000, vector[]);
        ts::next_tx(&mut sc, AGENT);
        let mut wallet = ts::take_shared<AgentWallet<SUI>>(&sc);
        let cap = ts::take_from_sender<AgentCap>(&sc);
        let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
        clk.set_for_testing(1000);
        let out = aw::spend<SUI>(&mut wallet, &cap, 2000, &clk, ts::ctx(&mut sc)); // <=per_tx but >budget
        coin::burn_for_testing(out);
        clock::destroy_for_testing(clk);
        ts::return_shared(wallet);
        ts::return_to_sender(&sc, cap);
        ts::end(sc);
    }

    // ── zero amount → E_ZERO_AMOUNT ──
    #[test, expected_failure(abort_code = E_ZERO_AMOUNT, location = aw)]
    fun spend_zero_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 500, 0, 0, 10_000, vector[]);
        ts::next_tx(&mut sc, AGENT);
        let mut wallet = ts::take_shared<AgentWallet<SUI>>(&sc);
        let cap = ts::take_from_sender<AgentCap>(&sc);
        let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
        clk.set_for_testing(1000);
        let out = aw::spend<SUI>(&mut wallet, &cap, 0, &clk, ts::ctx(&mut sc));
        coin::burn_for_testing(out);
        clock::destroy_for_testing(clk);
        ts::return_shared(wallet);
        ts::return_to_sender(&sc, cap);
        ts::end(sc);
    }

    // ── expired → E_EXPIRED ──
    #[test, expected_failure(abort_code = E_EXPIRED, location = aw)]
    fun spend_after_expiry_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 500, 0, 0, 10_000, vector[]);
        ts::next_tx(&mut sc, AGENT);
        let mut wallet = ts::take_shared<AgentWallet<SUI>>(&sc);
        let cap = ts::take_from_sender<AgentCap>(&sc);
        let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
        clk.set_for_testing(10_000); // ts == expiry → not (ts < expiry) → expired
        assert!(!aw::is_active(&wallet, &clk), 200);
        let out = aw::spend<SUI>(&mut wallet, &cap, 100, &clk, ts::ctx(&mut sc));
        coin::burn_for_testing(out);
        clock::destroy_for_testing(clk);
        ts::return_shared(wallet);
        ts::return_to_sender(&sc, cap);
        ts::end(sc);
    }

    // ── revoke reclaims funds + future spend aborts (E_REVOKED) ──
    #[test, expected_failure(abort_code = E_REVOKED, location = aw)]
    fun spend_after_revoke_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 500, 0, 0, 10_000, vector[]);

        ts::next_tx(&mut sc, OWNER);
        let mut wallet = ts::take_shared<AgentWallet<SUI>>(&sc);
        let reclaimed = aw::revoke<SUI>(&mut wallet, ts::ctx(&mut sc));
        assert!(coin::value(&reclaimed) == 1000, 300);
        assert!(aw::remaining(&wallet) == 0, 301);
        coin::burn_for_testing(reclaimed);
        ts::return_shared(wallet);

        ts::next_tx(&mut sc, AGENT);
        let mut wallet2 = ts::take_shared<AgentWallet<SUI>>(&sc);
        let cap = ts::take_from_sender<AgentCap>(&sc);
        let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
        clk.set_for_testing(1000);
        let out = aw::spend<SUI>(&mut wallet2, &cap, 100, &clk, ts::ctx(&mut sc));
        coin::burn_for_testing(out);
        clock::destroy_for_testing(clk);
        ts::return_shared(wallet2);
        ts::return_to_sender(&sc, cap);
        ts::end(sc);
    }

    // ── revoke by non-owner → E_NOT_OWNER ──
    #[test, expected_failure(abort_code = E_NOT_OWNER, location = aw)]
    fun revoke_by_non_owner_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 500, 0, 0, 10_000, vector[]);
        ts::next_tx(&mut sc, AGENT); // agent is not the owner
        let mut wallet = ts::take_shared<AgentWallet<SUI>>(&sc);
        let reclaimed = aw::revoke<SUI>(&mut wallet, ts::ctx(&mut sc));
        coin::burn_for_testing(reclaimed);
        ts::return_shared(wallet);
        ts::end(sc);
    }

    // ── top_up by owner increases budget ──
    #[test]
    fun top_up_increases_budget() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 500, 0, 0, 10_000, vector[]);
        ts::next_tx(&mut sc, OWNER);
        let mut wallet = ts::take_shared<AgentWallet<SUI>>(&sc);
        let more = coin::mint_for_testing<SUI>(500, ts::ctx(&mut sc));
        aw::top_up<SUI>(&mut wallet, more, ts::ctx(&mut sc));
        assert!(aw::remaining(&wallet) == 1500, 400);
        ts::return_shared(wallet);
        ts::end(sc);
    }

    // ── top_up by non-owner → E_NOT_OWNER ──
    #[test, expected_failure(abort_code = E_NOT_OWNER, location = aw)]
    fun top_up_by_non_owner_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 500, 0, 0, 10_000, vector[]);
        ts::next_tx(&mut sc, AGENT);
        let mut wallet = ts::take_shared<AgentWallet<SUI>>(&sc);
        let more = coin::mint_for_testing<SUI>(500, ts::ctx(&mut sc));
        aw::top_up<SUI>(&mut wallet, more, ts::ctx(&mut sc));
        ts::return_shared(wallet);
        ts::end(sc);
    }

    // ── allowed_packages scope view: empty = allow all; non-empty = membership ──
    #[test]
    fun is_allowed_scope_logic() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 500, 0, 0, 10_000, vector[PKG_A]);
        ts::next_tx(&mut sc, AGENT);
        let wallet = ts::take_shared<AgentWallet<SUI>>(&sc);
        assert!(aw::is_allowed(&wallet, PKG_A), 500);   // listed
        assert!(!aw::is_allowed(&wallet, PKG_B), 501);  // not listed
        assert!(aw::allowed_packages(&wallet) == vector[PKG_A], 502);
        ts::return_shared(wallet);
        ts::end(sc);

        let mut sc2 = ts::begin(OWNER);
        create(&mut sc2, 1000, 500, 0, 0, 10_000, vector[]); // empty = allow any
        ts::next_tx(&mut sc2, AGENT);
        let w2 = ts::take_shared<AgentWallet<SUI>>(&sc2);
        assert!(aw::is_allowed(&w2, PKG_A), 503);
        assert!(aw::is_allowed(&w2, PKG_B), 504);
        ts::return_shared(w2);
        ts::end(sc2);
    }

    // ══════════════════════════════════════════════════════════════════════
    // v2: rolling spend-window quota
    // ══════════════════════════════════════════════════════════════════════

    // ── spends that stay within the window quota all pass ──
    #[test]
    fun spend_within_window_quota_passes() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 10_000, 10_000, 1_000, 500, 100_000, vector[]); // window_ms=1000, window_max=500
        ts::next_tx(&mut sc, AGENT);
        let mut wallet = ts::take_shared<AgentWallet<SUI>>(&sc);
        let cap = ts::take_from_sender<AgentCap>(&sc);
        let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
        clk.set_for_testing(0);

        let out1 = aw::spend<SUI>(&mut wallet, &cap, 200, &clk, ts::ctx(&mut sc));
        let out2 = aw::spend<SUI>(&mut wallet, &cap, 300, &clk, ts::ctx(&mut sc)); // 200 + 300 == window_max
        assert!(aw::spent_in_window(&wallet) == 500, 1000);

        coin::burn_for_testing(out1);
        coin::burn_for_testing(out2);
        clock::destroy_for_testing(clk);
        ts::return_shared(wallet);
        ts::return_to_sender(&sc, cap);
        ts::end(sc);
    }

    // ── exceeding window_max within the same window → E_OVER_WINDOW ──
    #[test, expected_failure(abort_code = E_OVER_WINDOW, location = aw)]
    fun spend_over_window_max_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 10_000, 10_000, 1_000, 500, 100_000, vector[]);
        ts::next_tx(&mut sc, AGENT);
        let mut wallet = ts::take_shared<AgentWallet<SUI>>(&sc);
        let cap = ts::take_from_sender<AgentCap>(&sc);
        let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
        clk.set_for_testing(0);

        let out1 = aw::spend<SUI>(&mut wallet, &cap, 300, &clk, ts::ctx(&mut sc));
        let out2 = aw::spend<SUI>(&mut wallet, &cap, 300, &clk, ts::ctx(&mut sc)); // 300 + 300 > 500

        coin::burn_for_testing(out1);
        coin::burn_for_testing(out2);
        clock::destroy_for_testing(clk);
        ts::return_shared(wallet);
        ts::return_to_sender(&sc, cap);
        ts::end(sc);
    }

    // ── once the window elapses, the quota resets (even though the flat budget wouldn't) ──
    #[test]
    fun window_elapse_resets_quota() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 10_000, 10_000, 1_000, 500, 100_000, vector[]);
        ts::next_tx(&mut sc, AGENT);
        let mut wallet = ts::take_shared<AgentWallet<SUI>>(&sc);
        let cap = ts::take_from_sender<AgentCap>(&sc);
        let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
        clk.set_for_testing(0);

        let out1 = aw::spend<SUI>(&mut wallet, &cap, 500, &clk, ts::ctx(&mut sc)); // fills the window
        assert!(aw::spent_in_window(&wallet) == 500, 1001);

        // Advance past window_start_ms(0) + window_ms(1000): the window rolls over.
        clk.set_for_testing(1_000);
        let out2 = aw::spend<SUI>(&mut wallet, &cap, 500, &clk, ts::ctx(&mut sc)); // would over-window if not reset
        assert!(aw::spent_in_window(&wallet) == 500, 1002);
        assert!(aw::window_start_ms(&wallet) == 1_000, 1003);

        coin::burn_for_testing(out1);
        coin::burn_for_testing(out2);
        clock::destroy_for_testing(clk);
        ts::return_shared(wallet);
        ts::return_to_sender(&sc, cap);
        ts::end(sc);
    }

    // ══════════════════════════════════════════════════════════════════════
    // v2: sender enforcement
    // ══════════════════════════════════════════════════════════════════════

    // ── spend from a non-agent sender aborts even while holding a wallet-valid cap ──
    #[test, expected_failure(abort_code = E_NOT_AGENT, location = aw)]
    fun spend_from_non_agent_sender_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 500, 0, 0, 10_000, vector[]);

        // AGENT forwards the (still wallet-valid) cap to a third party.
        ts::next_tx(&mut sc, AGENT);
        let cap = ts::take_from_sender<AgentCap>(&sc);
        transfer::public_transfer(cap, STRANGER);

        ts::next_tx(&mut sc, STRANGER);
        let mut wallet = ts::take_shared<AgentWallet<SUI>>(&sc);
        let cap = ts::take_from_sender<AgentCap>(&sc);
        let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
        clk.set_for_testing(1000);
        let out = aw::spend<SUI>(&mut wallet, &cap, 100, &clk, ts::ctx(&mut sc));

        coin::burn_for_testing(out);
        clock::destroy_for_testing(clk);
        ts::return_shared(wallet);
        ts::return_to_sender(&sc, cap);
        ts::end(sc);
    }

    // ══════════════════════════════════════════════════════════════════════
    // v2: cap rotation
    // ══════════════════════════════════════════════════════════════════════

    // ── old cap fails spend() after rotate_agent → E_BAD_CAP ──
    #[test, expected_failure(abort_code = E_BAD_CAP, location = aw)]
    fun old_cap_after_rotation_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 500, 0, 0, 10_000, vector[]);

        ts::next_tx(&mut sc, OWNER);
        let mut wallet = ts::take_shared<AgentWallet<SUI>>(&sc);
        aw::rotate_agent<SUI>(&mut wallet, NEW_AGENT, ts::ctx(&mut sc));
        ts::return_shared(wallet);

        ts::next_tx(&mut sc, AGENT); // old agent, still physically holding the old cap
        let mut wallet2 = ts::take_shared<AgentWallet<SUI>>(&sc);
        let old_cap = ts::take_from_sender<AgentCap>(&sc);
        let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
        clk.set_for_testing(1000);
        let out = aw::spend<SUI>(&mut wallet2, &old_cap, 100, &clk, ts::ctx(&mut sc));

        coin::burn_for_testing(out);
        clock::destroy_for_testing(clk);
        ts::return_shared(wallet2);
        ts::return_to_sender(&sc, old_cap);
        ts::end(sc);
    }

    // ── new cap works for the new agent after rotation ──
    #[test]
    fun new_cap_after_rotation_works() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 500, 0, 0, 10_000, vector[]);

        ts::next_tx(&mut sc, OWNER);
        let mut wallet = ts::take_shared<AgentWallet<SUI>>(&sc);
        aw::rotate_agent<SUI>(&mut wallet, NEW_AGENT, ts::ctx(&mut sc));
        assert!(aw::agent(&wallet) == NEW_AGENT, 1100);
        ts::return_shared(wallet);

        ts::next_tx(&mut sc, NEW_AGENT);
        let mut wallet2 = ts::take_shared<AgentWallet<SUI>>(&sc);
        let new_cap = ts::take_from_sender<AgentCap>(&sc);
        let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
        clk.set_for_testing(1000);
        let out = aw::spend<SUI>(&mut wallet2, &new_cap, 100, &clk, ts::ctx(&mut sc));
        assert!(coin::value(&out) == 100, 1101);

        coin::burn_for_testing(out);
        clock::destroy_for_testing(clk);
        ts::return_shared(wallet2);
        ts::return_to_sender(&sc, new_cap);
        ts::end(sc);
    }

    // ── rotate_agent by non-owner → E_NOT_OWNER ──
    #[test, expected_failure(abort_code = E_NOT_OWNER, location = aw)]
    fun rotate_agent_by_non_owner_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 500, 0, 0, 10_000, vector[]);
        ts::next_tx(&mut sc, AGENT); // agent is not the owner
        let mut wallet = ts::take_shared<AgentWallet<SUI>>(&sc);
        aw::rotate_agent<SUI>(&mut wallet, NEW_AGENT, ts::ctx(&mut sc));
        ts::return_shared(wallet);
        ts::end(sc);
    }

    // ══════════════════════════════════════════════════════════════════════
    // v2: owner setters
    // ══════════════════════════════════════════════════════════════════════

    // ── set_per_tx_max: owner succeeds ──
    #[test]
    fun set_per_tx_max_by_owner_succeeds() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 500, 0, 0, 10_000, vector[]);
        ts::next_tx(&mut sc, OWNER);
        let mut wallet = ts::take_shared<AgentWallet<SUI>>(&sc);
        aw::set_per_tx_max<SUI>(&mut wallet, 750, ts::ctx(&mut sc));
        assert!(aw::per_tx_max(&wallet) == 750, 1200);
        ts::return_shared(wallet);
        ts::end(sc);
    }

    // ── set_per_tx_max: non-owner aborts → E_NOT_OWNER ──
    #[test, expected_failure(abort_code = E_NOT_OWNER, location = aw)]
    fun set_per_tx_max_by_non_owner_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 500, 0, 0, 10_000, vector[]);
        ts::next_tx(&mut sc, AGENT);
        let mut wallet = ts::take_shared<AgentWallet<SUI>>(&sc);
        aw::set_per_tx_max<SUI>(&mut wallet, 750, ts::ctx(&mut sc));
        ts::return_shared(wallet);
        ts::end(sc);
    }

    // ── extend_expiry: owner succeeds ──
    #[test]
    fun extend_expiry_by_owner_succeeds() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 500, 0, 0, 10_000, vector[]);
        ts::next_tx(&mut sc, OWNER);
        let mut wallet = ts::take_shared<AgentWallet<SUI>>(&sc);
        aw::extend_expiry<SUI>(&mut wallet, 20_000, ts::ctx(&mut sc));
        assert!(aw::expires_at_ms(&wallet) == 20_000, 1201);
        ts::return_shared(wallet);
        ts::end(sc);
    }

    // ── extend_expiry: non-owner aborts → E_NOT_OWNER ──
    #[test, expected_failure(abort_code = E_NOT_OWNER, location = aw)]
    fun extend_expiry_by_non_owner_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 500, 0, 0, 10_000, vector[]);
        ts::next_tx(&mut sc, AGENT);
        let mut wallet = ts::take_shared<AgentWallet<SUI>>(&sc);
        aw::extend_expiry<SUI>(&mut wallet, 20_000, ts::ctx(&mut sc));
        ts::return_shared(wallet);
        ts::end(sc);
    }

    // ── extend_expiry: backwards move aborts → E_EXPIRY_NOT_FORWARD ──
    #[test, expected_failure(abort_code = E_EXPIRY_NOT_FORWARD, location = aw)]
    fun extend_expiry_backwards_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 500, 0, 0, 10_000, vector[]);
        ts::next_tx(&mut sc, OWNER);
        let mut wallet = ts::take_shared<AgentWallet<SUI>>(&sc);
        aw::extend_expiry<SUI>(&mut wallet, 5_000, ts::ctx(&mut sc)); // 5000 < current 10_000
        ts::return_shared(wallet);
        ts::end(sc);
    }

    // ── extend_expiry re-enables an expired wallet ──
    #[test]
    fun extend_expiry_reenables_expired_wallet() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 500, 0, 0, 10_000, vector[]);

        ts::next_tx(&mut sc, AGENT);
        let wallet_check = ts::take_shared<AgentWallet<SUI>>(&sc);
        let mut clk = clock::create_for_testing(ts::ctx(&mut sc));
        clk.set_for_testing(10_000); // ts == expiry → expired
        assert!(!aw::is_active(&wallet_check, &clk), 1202);
        ts::return_shared(wallet_check);

        ts::next_tx(&mut sc, OWNER);
        let mut wallet = ts::take_shared<AgentWallet<SUI>>(&sc);
        aw::extend_expiry<SUI>(&mut wallet, 50_000, ts::ctx(&mut sc));
        assert!(aw::is_active(&wallet, &clk), 1203);
        ts::return_shared(wallet);

        ts::next_tx(&mut sc, AGENT);
        let mut wallet2 = ts::take_shared<AgentWallet<SUI>>(&sc);
        let cap = ts::take_from_sender<AgentCap>(&sc);
        let out = aw::spend<SUI>(&mut wallet2, &cap, 100, &clk, ts::ctx(&mut sc));
        assert!(coin::value(&out) == 100, 1204);

        coin::burn_for_testing(out);
        clock::destroy_for_testing(clk);
        ts::return_shared(wallet2);
        ts::return_to_sender(&sc, cap);
        ts::end(sc);
    }

    // ── set_window: owner succeeds ──
    #[test]
    fun set_window_by_owner_succeeds() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 500, 0, 0, 10_000, vector[]);
        ts::next_tx(&mut sc, OWNER);
        let mut wallet = ts::take_shared<AgentWallet<SUI>>(&sc);
        aw::set_window<SUI>(&mut wallet, 2_000, 300, ts::ctx(&mut sc));
        assert!(aw::window_ms(&wallet) == 2_000, 1205);
        assert!(aw::window_max(&wallet) == 300, 1206);
        ts::return_shared(wallet);
        ts::end(sc);
    }

    // ── set_window: non-owner aborts → E_NOT_OWNER ──
    #[test, expected_failure(abort_code = E_NOT_OWNER, location = aw)]
    fun set_window_by_non_owner_aborts() {
        let mut sc = ts::begin(OWNER);
        create(&mut sc, 1000, 500, 0, 0, 10_000, vector[]);
        ts::next_tx(&mut sc, AGENT);
        let mut wallet = ts::take_shared<AgentWallet<SUI>>(&sc);
        aw::set_window<SUI>(&mut wallet, 2_000, 300, ts::ctx(&mut sc));
        ts::return_shared(wallet);
        ts::end(sc);
    }
}
