---
status: proposal
audience: xfajarr (signer owner)
authored_by: U6 (Modular Agent-Wallet Capabilities plan)
context: docs/plans/2026-07-18-001-feat-modular-agent-wallet-capabilities-plan.md
---

# CapabilityManifest ↔ Signer Interface Contract

**This is a proposal, not a spec.** Nothing in `packages/rill-signer/*` has been edited to produce
this doc — it only reads your files to describe them accurately. U1 (Move) and U2 (SDK) have landed;
this contract exists so your signer-side mirror and owner-driven onboarding work can target something
concrete instead of guessing at the shape of the other two layers. Where your judgment differs from
what's proposed here, that wins — flag it and we reconcile.

The framing (KTD-3): a single `CapabilityManifest` in `@rill/sdk` is the **source of truth**. It
projects to three layers that must stay in sync:

1. **On-chain `SpendPolicy` rules** (U1, `move/agent_wallet/`) — hard enforcement, unbypassable by
   construction (hot potato).
2. **Signer pre-flight mirror** (this doc's subject — your `StepValidator`s + `LocalSignerPolicy`) —
   fail-fast, but NOT the authority. If the signer's mirror and the chain ever disagree, the chain
   wins; the signer's job is to reject *before* wasting gas on something the chain would reject anyway.
3. **skill.md / agent-instructions declaration** (U3, not yet started) — what the agent is told, purely
   descriptive.

Per R6, this is distinct from your `steps[]` per-transaction plan on `ExecutionEnvelope`: the manifest
is wallet-level and persistent (owner-set once, changed only by the owner); `steps[]` describes what
ONE compiled PTB does. The signer validates a transaction's `steps[]` *against* the manifest's
projection — it doesn't replace `steps[]`.

---

## 1. The `CapabilityManifest` shape and `toSignerPolicy` projection

Source: `packages/rill-sdk/src/capability-manifest.ts` (landed, U2).

```ts
export const RULE_KINDS = [
  'budget', 'per_tx', 'rate_limit', 'protocol_scope',
  'slippage_floor', 'asset_scope', 'recipient_allowlist', 'time_window',
] as const;

export interface CapabilityManifest {
  walletCoinType: string;   // e.g. "0x2::sui::SUI"
  rules: CapabilityRule[];  // discriminated union on `kind`, one of RULE_KINDS; >=1 required,
                             // each kind at most once (empty manifest = rejected as unsafe, KTD-6)
}
```

Each rule's own shape (all u64 fields are decimal strings, validated through the SDK's single
`parseU64String` money-path — never floats):

```ts
{ kind: 'budget',      totalMist: string }
{ kind: 'per_tx',      maxMist: string }
{ kind: 'rate_limit',  windowMs: string, maxMist: string }
{ kind: 'protocol_scope', allowedPackages: string[] }        // Sui addresses, min 1
{ kind: 'slippage_floor', minBps: number }                   // 0..10000 basis points
{ kind: 'asset_scope', allowedCoinTypes: string[] }           // min 1
{ kind: 'recipient_allowlist', addresses: string[] }          // min 1
{ kind: 'time_window', notBeforeMs?: string, notAfterMs?: string, allowedHoursUtc?: number[] }
```

`toSignerPolicy(manifest)` — the projection your mirror is meant to consume — flattens this to:

```ts
export interface SignerPolicy {
  maxAmountMist?: string;                              // from budget
  perTxMaxMist?: string;                                // from per_tx
  window?: { windowMs: string; maxMist: string };       // from rate_limit
  allowedPackages?: string[];                            // from protocol_scope
  minSlippageBps?: number;                                // from slippage_floor
  allowedCoinTypes?: string[];                            // from asset_scope
  allowedRecipients?: string[];                           // from recipient_allowlist
  timeWindow?: { notBeforeMs?: string; notAfterMs?: string; allowedHoursUtc?: number[] };
}
```

Keys for rule kinds the manifest doesn't attach are simply absent (not `undefined`-valued), so
`'perTxMaxMist' in policy` works as a presence check. This is documented in the SDK source as
**shape-only** — it's explicit that the signer re-derives its own enforcement rather than trusting the
projection blindly, which matches how `LocalSignerPolicy` already works (it's a locally-loaded,
locally-trusted file, not something the backend hands you at request time).

**Proposal:** `LocalSignerPolicy` (`packages/rill-signer/src/policy.ts`) grows an optional
`capabilityManifest?: SignerPolicy` field (additive, mirrors how `steps?: EnvelopeStep[]` was added
without breaking the legacy DeepBook path) that a new pre-flight pass checks each `steps[]` entry
against, independent of `assertCapabilitiesActive`'s live chain reads (see §3).

---

## 2. Mapping the 8 rules to per-step checks

Your `StepValidator`s (`packages/rill-signer/src/steps/{cetus,haedal,deepbook}.ts`, dispatched via
`stepValidators` in `steps/registry.ts`, called from `inspectGeneric` in `policy.ts`) already do
PTB-structural inspection per node type. Below is a rule-by-rule map of what each one implies for that
layer — most are new checks; two already exist in some form.

| Rule | On-chain enforcement (U1) | Proposed signer-side check |
|---|---|---|
| `budget` | `wallet.spent() + req.amount() <= total_mist` (cumulative, lives in `budget::Config`) | Live check, not per-step-structural: read `wallet.spent` (flat field, already read by `readWalletStatus`/`assertCapabilitiesActive`) + this PTB's aggregate `spendAmountMist`, compare against `SignerPolicy.maxAmountMist`. Belongs next to your existing `assertCapabilitiesActive` live reads, not inside a `StepValidator`. |
| `per_tx` | `req.amount() <= max_mist` on the ONE `request_spend` per PTB | `inspectGeneric` already computes one aggregate `spendAmountMist` for the whole PTB (see §3 on why it's one `request_spend`, not one per step). Compare that directly against `SignerPolicy.perTxMaxMist` — a one-line addition near where `policy.maxAmountMist` is already checked. |
| `rate_limit` | rolling window state (`window_start_ms`, `spent_in_window`) mutated in `rate_limit::Config`, a **dynamic field** — not a flat wallet field | New capability needed: this state isn't reachable the way `assertCapabilitiesActive` reads `budget`/`revoked`/`expires_at_ms` today (those are flat `AgentWallet` fields). Mirroring it fail-fast requires either a dynamic-field object read keyed on the rule's `RuleKey<rate_limit::Rule>` type, or a `devInspectTransactionBlock` call against `rate_limit::view<T>(wallet)` (a read-only Move accessor U1 already exposes for exactly this). Open question — see §5. |
| `protocol_scope` | `req.target_package()` ∈ `allowed: vector<address>` | Each `StepValidator` already asserts specific call targets structurally (e.g. `cetus.ts` pins `::router::swap`, `deepbook.ts` pins `::balance_manager::deposit`/`::generate_proof_as_trader`/`::pool::place_limit_order`). Add: the package id parsed out of each asserted target must be a member of `SignerPolicy.allowedPackages`. This is closer to "the manifest constrains which protocols your own registry may dispatch to" than a new per-command check. |
| `slippage_floor` | dispatches to `rill_guard::guard::assert_min_value(coin_out, min)`, `min` is an **absolute u64 output floor** | `cetus.ts` already has the closest analog: it requires a `guard::assert_min_value` MoveCall immediately after the swap, asserted against the swap's own `NestedResult` output, and checks `minOut >= step.minOutMist`. That's structurally the right mirror. The gap: `SignerPolicy.minSlippageBps` is **relative** (basis points of quoted amount), while both the on-chain rule's `min` and `CetusSwapStep.minOutMist` are **absolute**. Converting bps → an absolute floor needs the step's quoted/expected output amount, which isn't currently a field on `CetusSwapStep`. See §5. |
| `asset_scope` | both `req.coin_in()` and `req.coin_out()` ∈ `allowed: vector<TypeName>` | Gap: neither `cetus.ts` nor `haedal.ts` currently asserts `typeArguments` at all (unlike `deepbook.ts`, which does call `assertTypeArguments`). Mirroring this rule means adding a coin-type-argument check to `cetus_swap`/`haedal_stake` steps and comparing against `SignerPolicy.allowedCoinTypes`. See §5. |
| `recipient_allowlist` | `req.recipient()` ∈ `allowed: vector<address>` | Gap: none of the three current node types (`cetus_swap`, `haedal_stake`, `deepbook_limit_order`) carry an explicit recipient — every flow today is self-directed (swap/stake output stays in the wallet's own custody chain, and `inspectGeneric`'s terminal invariant is "merge the wallet-spend remainder back into gas," i.e. back to the sender). There's no `TransferObjects`-to-a-third-party node type yet. This rule has no current per-step analog to hang off of. See §5. |
| `time_window` | `[not_before_ms, not_after_ms)` clock check inside `prove` (both bounds **mandatory** on-chain) | Purely local, no chain read needed — same style as your existing `expiresAt`/5-minute-TTL checks in `validateExecutionEnvelope`. Compare `now` against `SignerPolicy.timeWindow.notBeforeMs`/`notAfterMs`/`allowedHoursUtc` before doing anything else. Note `allowedHoursUtc` (hour-of-day allowlist) has **no on-chain rule counterpart** — U1's `time_window` rule only has the two clock bounds. It's safe for the signer to enforce it as an extra fail-fast layer (stricter than chain is always fine), just don't expect a matching on-chain abort code for it. |

**Net read:** `protocol_scope`, `slippage_floor`, and `time_window` have workable analogs in your
existing architecture with modest extension. `rate_limit`, `asset_scope`, and `recipient_allowlist`
need either new data on the envelope/step types or a new live-chain-read path you don't have today.
`budget` and `per_tx` are one-line additions next to checks you already have.

---

## 3. Owner-driven onboarding (R9 / KTD-4)

**Today** (`packages/rill-signer/src/mcp.ts`, `createRunSet`, lines ~336-402): the backend hands the
signer a `plan.setupPtb` that calls `${walletPackageId}::agent_wallet::create_wallet` (per
`onboardingAllowlistFor`, lines ~305-323); `inspectOnboarding` structurally checks it against a fixed
allowlist (R8 — never sign backend bytes blind); then, if `RILL_ALLOW_AUTO_ONBOARDING=true`, **the
signer's own key** (`signAndExecutePtb(plan.setupPtb, signer, cfg)`) signs and executes it — the agent
is creating and funding its own wallet. That's exactly what KTD-4 says has to stop: an agent that can
create its own wallet could in principle create one with no rules attached.

**Proposed shift:**

- The OWNER, in studio (Connect Wallet), signs **one PTB** built by the backend's keyless compiler:
  `create_wallet<T>(version, funds, agent, expires_at_ms, ctx)` (U1) followed by one `add` call per
  manifest rule (`budget::add`, `per_tx::add`, ... — see §4) and a fund/`top_up` call. This is the
  `create_wallet + add_rule×N + fund` sequence from KTD-4/R9.
- `create_wallet`'s `agent: address` argument is the agent's *local keypair address* — meaning
  `keystore.ts`'s `loadOrCreateKeypair` (already exactly "the agent auto-creates only its local
  keypair," R9 — **no change proposed here**) has to run, and its address has to reach the studio/
  backend, *before* this PTB can be built. That ordering (agent key first, then owner signs onboarding
  against that address) is worth confirming explicitly since it inverts today's flow (today the signer
  creates the wallet against its own address as part of the same call that generates gas for it).
- `create_wallet` internally does `transfer::transfer(cap, agent)` — the `AgentCap` lands directly in
  the agent's address as an owned object the moment the owner's PTB executes. No separate on-chain
  hand-off step is needed.
- What's left for `create_run_set` shrinks: it stops building/signing a wallet-creation PTB itself.
  What it still needs to do is learn the resulting `walletId`/`agentCapId` (today it gets these from
  `extractCreatedObjectId(setupResult.effects, ...)` because it executed the tx and has the effects —
  under owner-driven onboarding it doesn't have those effects). See §5 for how that data might reach
  it.
- The `tradeCapPtb` piece (`buildTradeCapPtb`, DeepBook `mint_trade_cap`) looks orthogonal to this
  shift — it doesn't touch `agent_wallet`'s owner-only surface at all, so it may be fine for the signer
  to keep building/signing that one itself. Flagging rather than asserting, since you know that DeepBook
  path better than this doc does.

**Files this touches, named so ownership is explicit (none edited by U6):**
- `packages/rill-signer/src/mcp.ts` — `create_run_set`'s `createRunSet`, `onboardingAllowlistFor`.
- `packages/rill-signer/src/policy.ts` — `LocalSignerPolicy` (would need to carry whatever the owner
  actually configured, e.g. wallet id / agent cap id / a `capabilityManifest` mirror), plus
  `assertCapabilitiesActive`'s live wallet-field reads (see the mismatch in §6 — these read a field
  that no longer exists on the new struct).
- `packages/rill-signer/src/steps/*` — new/extended `StepValidator`s per §2's gaps.
- `packages/rill-signer/src/keystore.ts` — reference point only; believed already correct for R9, no
  change expected.

---

## 4. On-chain entry points (U1, `move/agent_wallet/`, flat module names — all under `agent_wallet::*`)

Core module (`agent_wallet::agent_wallet`):

```move
public fun create_wallet<T>(
    version: &Version, funds: Coin<T>, agent: address, expires_at_ms: u64, ctx: &mut TxContext,
)
// shares an AgentWallet with an EMPTY SpendPolicy; transfers AgentCap to `agent`.
// Owner is expected to follow with N `<rule_module>::add` calls in the SAME PTB.

public fun request_spend<T>(
    wallet: &AgentWallet<T>, cap: &AgentCap, version: &Version, amount: u64,
    target_package: address, coin_in: TypeName, coin_out: TypeName, recipient: address,
    clock: &Clock, ctx: &TxContext,
): SpendRequest
// mints the hot potato; checks cap/agent/revoked/expiry/amount, touches NO rule.

public fun confirm_spend<T>(
    wallet: &mut AgentWallet<T>, req: SpendRequest, version: &Version, clock: &Clock, ctx: &mut TxContext,
): Coin<T>
// asserts req.receipts == policy.rules (set-equality) then releases the coin.
```

**Important:** `add_rule<T, Rule: drop, Config: store + drop>` and `remove_rule<...>` are the
*underlying* generic functions in `agent_wallet::agent_wallet`, but they're not the PTB call targets —
each rule module wraps them with a concrete, zero-witness-argument entry point. The actual PTB targets
are `${pkg}::<module>::add` / `${pkg}::<module>::remove` / `${pkg}::<module>::prove`, always generic
only over `T` (the wallet coin type), with **no rule-witness type argument to supply** — the witness
gets resolved inside the wrapper. (This is relevant to §6 — the SDK's `ruleWitness` field isn't
something a PTB builder needs to pass anywhere.)

Per-rule `add` / `prove` signatures, quoted from `move/agent_wallet/sources/rules/*.move`:

```move
// budget.move
public fun add<T>(wallet: &mut AgentWallet<T>, version: &Version, total_mist: u64, ctx: &TxContext)
public fun prove<T>(req: &mut SpendRequest, wallet: &AgentWallet<T>, version: &Version)

// per_tx.move
public fun add<T>(wallet: &mut AgentWallet<T>, version: &Version, max_mist: u64, ctx: &TxContext)
public fun prove<T>(req: &mut SpendRequest, wallet: &AgentWallet<T>, version: &Version)

// rate_limit.move — the one rule with mutable per-spend state, hence `&mut wallet` in prove
public fun add<T>(wallet: &mut AgentWallet<T>, version: &Version, window_ms: u64, window_max: u64, ctx: &TxContext)
public fun prove<T>(req: &mut SpendRequest, wallet: &mut AgentWallet<T>, version: &Version, clock: &Clock)
public fun view<T>(wallet: &AgentWallet<T>): &Config   // read-only accessor for off-chain callers

// protocol_scope.move
public fun add<T>(wallet: &mut AgentWallet<T>, version: &Version, allowed: vector<address>, ctx: &TxContext)
public fun prove<T>(req: &mut SpendRequest, wallet: &AgentWallet<T>, version: &Version)

// slippage_floor.move — dispatches to rill_guard::guard::assert_min_value; `min` is an ABSOLUTE u64
public fun add<T>(wallet: &mut AgentWallet<T>, version: &Version, min: u64, ctx: &TxContext)
public fun prove<T, OutT>(req: &mut SpendRequest, wallet: &AgentWallet<T>, version: &Version, coin_out: &Coin<OutT>)

// asset_scope.move — allowlist is vector<TypeName>, not vector<string>
public fun add<T>(wallet: &mut AgentWallet<T>, version: &Version, allowed: vector<TypeName>, ctx: &TxContext)
public fun prove<T>(req: &mut SpendRequest, wallet: &AgentWallet<T>, version: &Version)

// recipient_allowlist.move
public fun add<T>(wallet: &mut AgentWallet<T>, version: &Version, allowed: vector<address>, ctx: &TxContext)
public fun prove<T>(req: &mut SpendRequest, wallet: &AgentWallet<T>, version: &Version)

// time_window.move — BOTH bounds mandatory; add() asserts not_before_ms < not_after_ms
public fun add<T>(wallet: &mut AgentWallet<T>, version: &Version, not_before_ms: u64, not_after_ms: u64, ctx: &TxContext)
public fun prove<T>(req: &mut SpendRequest, wallet: &AgentWallet<T>, version: &Version, clock: &Clock)
```

`agent_wallet::version::check_is_valid(&Version)` gates `create_wallet`, `request_spend`,
`confirm_spend`, every rule's `prove`, and `remove_rule` — but deliberately **not** `add_rule` or any
other owner-only op (`revoke`, `top_up`, `rotate_agent`, `extend_expiry`), so a pending upgrade can
pause the agent's ability to spend without ever trapping the owner's kill-switch. Every PTB that calls
any gated function needs the shared `Version` object as an argument; the signer/backend needs its
object id the same way it already needs the Clock's `0x6`.

---

## 5. Open questions for Fajar

1. **`rate_limit` live state** — it's a dynamic field on `SpendPolicy`, not a flat wallet field. Do you
   want a dynamic-field object read (needs the exact `RuleKey<rate_limit::Rule>` derivation) or would
   you rather devInspect `rate_limit::view<T>(wallet)`? Either works; this doc doesn't pick one because
   it changes your client plumbing, not the manifest contract.
2. **`slippage_floor` bps → absolute conversion** — `SignerPolicy.minSlippageBps` is relative; both the
   on-chain `min` and `CetusSwapStep.minOutMist` are absolute u64. Converting needs a quoted/expected
   output amount that isn't currently a field on `CetusSwapStep`/`HaedalStakeStep`. Does the compiler
   (U5) attach a quoted-amount field to steps so you can derive the absolute floor yourself, or should
   the manifest projection carry a pre-computed absolute floor per step instead of a flat bps number?
3. **`asset_scope`** — neither `cetus.ts` nor `haedal.ts` currently checks `typeArguments`. Is adding
   that check (mirroring what `deepbook.ts` already does) the right shape, or do you want coin types
   threaded through `steps[]` explicitly instead of re-derived from the PTB's type arguments?
4. **`recipient_allowlist`** — none of your three current node types express a third-party recipient.
   Is this rule meant to gate a node type that doesn't exist yet (a `transfer`/`payout` step), or should
   it fold into the existing self-directed flows some other way? Flagging rather than guessing since
   this might be genuinely out of scope for the current 3 node types.
5. **Where do the owner-created `walletId` + `AgentCap` id reach the signer?** Two candidates: (a) the
   studio backend watches the owner's onboarding tx effects and hands `walletId`/`agentCapId` back
   through `create_run_set`'s `plan` (closest to today's shape, just with the effects sourced
   differently); (b) the signer queries chain directly for `AgentCap` objects it owns
   (`getOwnedObjects` filtered by type, then reads `.wallet`) and self-discovers which wallet it was
   granted. Which do you want to build against?
6. **Does `steps[]` need the manifest attached to the envelope at all**, or is a locally-loaded
   `SignerPolicy` (extending `LocalSignerPolicy`, never sent over the wire) sufficient the way
   `LocalSignerPolicy` already works today? This doc assumes the latter (matches your existing
   trust model — the signer trusts its own loaded policy file, not backend-supplied data) but that's
   worth confirming explicitly.

---

## 6. Mismatches found while cross-checking this doc against the actual U1/U2 source

- **The biggest one:** `assertCapabilitiesActive` (`policy.ts`, ~line 734) and `readWalletStatus`
  (`mcp.ts`, ~line 193) both do `readMoveU64(fields, 'per_tx_max')` — a **flat field read**. The new
  `AgentWallet` struct (U1) has no `per_tx_max` field at all; the per-tx ceiling is now the optional
  `per_tx` rule's `Config.max_mist`, which may not even be attached, and lives as a dynamic field, not
  a plain struct field. This line will need to change regardless of anything else in this doc — it's
  not merely a nice-to-have mirror, it's reading something that won't exist once U1 deploys.
- Every other flat field `assertCapabilitiesActive`/`readWalletStatus` reads (`revoked`, `agent`,
  `expires_at_ms`, `budget`, `spent`) still exists on the new struct with the same name — confirmed
  those stay compatible.
- `AgentCap`'s `wallet: ID` field (checked via `readMoveId(capabilityFields, 'wallet')` in
  `assertCapabilitiesActive`'s capability-binding loop) is unchanged in the new struct — compatible.
- The signer's `inspect()`/`inspectGeneric()` (`policy.ts`) target
  `${walletPackageId}::agent_wallet::spend` — the v2 flat spend function. U1's redesign has **no
  `spend` function**; the funding chokepoint becomes `request_spend` → N `prove`s → `confirm_spend`.
  This is the central structural change §2/§4 describe — flagging it here explicitly since it's the
  one line (`walletTarget = normalizeTarget(...::agent_wallet::spend)`) that will hard-fail once U1
  deploys, independent of whether any rule-mirroring work happens at all.
- `SDK.OnChainRuleParams.ruleWitness` (e.g. `'BudgetRule'`, `'PerTxRule'`, ...) does not correspond to
  an actual Move type name — every rule module's witness struct is uniformly named `Rule` (scoped by
  its own module, e.g. `agent_wallet::budget::Rule`), and as §4 notes, PTB builders never need to name
  it at all since the `<module>::add`/`prove` wrappers resolve it internally. This is a U2↔U1 naming
  mismatch, not a U6/signer issue — surfacing it here since U5 (compiler) is the actual consumer of
  `toOnChainRuleParams`, and whoever picks that up should know `ruleWitness` is presentational, not a
  literal type argument to pass anywhere.
- `SDK`'s `time_window` rule allows omitting `notBeforeMs`/`notAfterMs` independently and adds an
  `allowedHoursUtc` field with no on-chain counterpart; U1's `time_window::add` requires **both** bounds
  (asserts `not_before_ms < not_after_ms`) and has no hour-of-day concept at all. Noted inline in §2's
  table — the signer can enforce `allowedHoursUtc` as an extra-strict local layer, but a manifest with
  only `allowedHoursUtc` set and no explicit bounds can't project to a valid `toOnChainRuleParams` call
  today (this is a U1/U2 reconciliation item, flagged for whoever picks up U5/U7, not something this
  doc resolves).

---

## Deferred (restated per the plan's scope boundaries)

None of this is implemented by U6. Deferred, per the plan: the signer-side mirror implementation
itself, owner-driven onboarding's actual code, FE (studio Connect Wallet UI, rule-attachment UI),
redeploying the Move package + propagating package ids, sponsored-tx wiring, and any live on-chain
rehearsal. This doc's only job is to make those follow-ups start from an agreed shape instead of a
guess.
