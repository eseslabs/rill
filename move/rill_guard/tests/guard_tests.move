#[test_only]
module rill_guard::guard_tests {
    use sui::coin;
    use sui::sui::SUI;
    use rill_guard::guard;

    const E_SLIPPAGE: u64 = 1;

    #[test]
    fun passes_when_at_or_above_min() {
        let ctx = &mut tx_context::dummy();
        let c = coin::mint_for_testing<SUI>(100, ctx);
        guard::assert_min_value(&c, 100); // exactly min
        guard::assert_min_value(&c, 50);  // above min
        coin::burn_for_testing(c);
    }

    #[test, expected_failure(abort_code = E_SLIPPAGE, location = rill_guard::guard)]
    fun aborts_when_below_min() {
        let ctx = &mut tx_context::dummy();
        let c = coin::mint_for_testing<SUI>(100, ctx);
        guard::assert_min_value(&c, 101); // below min → abort
        coin::burn_for_testing(c);
    }
}
