# Rill — Codebase Map

> **Audience:** engineers and AI agents working in this repo. Detailed feature → file → method → behavior → flow reference.
> **Generated:** 2026-07-18 from a full four-part scan of the audit-hardened codebase.
> **Scope:** `main`, `develop`, and the `feat/rill-demo-day-vertical-slice` worktree are **content-identical** — this map describes all three. Paths are relative to the repo root.

---

## 0. Orientation

**Rill = the keyless transaction layer for AI agents on Sui.** An owner grants a bounded, revocable on-chain wallet to an agent; the agent uses any MCP client to *build* transactions through Rill's hosted backend (which never holds a key), then *signs locally* with the `rill-signer`, which independently re-validates everything before the key is ever used. Two on-chain Move contracts bound every action.

**The one rule that explains the whole design:** *Rill Cloud builds (keyless) · the local signer signs · Move gates on-chain.* No component trusts the one before it.

### Deployed (Sui testnet)
- `agent_wallet` package: `0xd9265581b6b930f5fd27d9ec98e67b48f876f5de7bd25155639d808e9da636da`
- `rill_guard` package: `0xadec99557cf7771bce94737fdd3ea0bcc989d81e0860f3e69af55433dae8c034`
- Live API `https://api.rill.naisu.one` · Studio `https://rill.naisu.one`
- **Caveat:** the `agent_wallet` *source* in `move/` is **v2** (window quota, sender check, cap rotation — struct layout changed, a fresh package not an upgrade). The address hardcoded in `pitch.tsx` is the earlier deployment; **verify whether v2 is redeployed before relying on window/rotation on-chain.**

### Monorepo (Bun workspace)
| Path | Role | Entry |
|---|---|---|
| `rill-backend/` | Keyless Hono API — build/simulate/publish/MCP | `src/index.ts` → `src/http/routes/api.routes.ts` |
| `rill-frontend/` | Rill Studio (TanStack Router + React Flow) | `src/routes/builder.tsx` |
| `packages/rill-sdk/` | Shared types, envelope schema, money-path, HTTP client | `src/index.ts` |
| `packages/rill-signer/` | Local key-holding MCP signer (security-critical) | `src/mcp.ts` (bin `rill-signer-mcp`), `src/cli.ts` (bin `rill-sign`) |
| `move/agent_wallet/` | Capped/revocable budget contract (v2) | `sources/agent_wallet.move` |
| `move/rill_guard/` | On-chain slippage floor | `sources/guard.move` |

### Test counts (all green)
backend **147** · signer **111** · sdk **59** · frontend **48** (vitest) · Move `agent_wallet` **25**, `rill_guard` **2**.

### Audit-remediation tags
The source is littered with `KTD-n` (Known Technical Debt) and `Rn` (audit remediation) markers. Key ones referenced below: **KTD-2** single money-path (no float touches an amount), **KTD-3** single settle-sweep owner, **KTD-4** envelope gains no field, **R1** a no-floor guardrail must never look enforced, **R3** Cetus-abort match is package-scoped not substring, **R7** no fake 1-mist slippage default, **R8** onboarding inspected unconditionally, **R9/R10/R11** signer effects-check / independent ceilings / byte-pinning.

---

## 1. The end-to-end money path (the flow)

This is the DeepBook "hero" flow — the one fully-wired path. Every arrow is a real code boundary.

```
Owner (browser wallet)
  └─ POST /api/setup/prepare ──► setup.service.prepareSetupPlan
       → 2 unsigned PTBs (create_wallet+BalanceManager ; mint_trade_cap) + runSetTemplate
  └─ local signer: create_run_set ──► inspectOnboarding (unconditional) → signs setup → harvests object ids
       → rebuilds tradeCap PTB LOCALLY (never signs backend's bytes) → saves run-set JSON

Agent (Claude Code / any MCP client)
  ├─ remote MCP rill-actions: list_actions → describe_action
  ├─ remote MCP rill-actions: build_action(params)
  │     └─ skill-runner.runFlow ──► compiler.compileFlow (FlowGraph → 1 unsigned PTB)
  │          → serializeUnsignedPtb → simulator.simulateTransaction (devInspect)
  │          → if !ok: RETURN a refusal (envelope-shaped-NOTHING, unsignable)   [R3/KTD-4]
  │          → else: digestUnsignedPtb (SHA-256) → ExecutionEnvelope (TTL now+5min)
  └─ local MCP rill-wallet: execute_rill_action(envelope)
        └─ core.executeEnvelope ──► validateExecutionEnvelope (fail-closed, ~15 checks)
             → byte-pin: re-serialize+digest #2 == actionDigest  [R11 TOCTOU]
             → assertCapabilitiesActive (live on-chain liveness+ceilings)
             → re-simulate exact tx (must succeed) → gas ceiling → SUI-outflow ≤ spend+gas  [R9]
             → sign (Ed25519/Secp) → submit → verify status.success
             → on-chain: agent_wallet::spend (gates budget/per-tx/window/expiry/revoke/sender/cap)
                         → balance_manager::deposit → generate_proof_as_trader → pool::place_limit_order
```

Owner revokes → `agent_wallet::revoke` sets `revoked=true`, drains budget. Next agent attempt fails at the signer's `assertCapabilitiesActive` (revoked read) *before* signing, and a devInspect of the revoked PTB returns abort code `2`.

---

## 2. Backend — core (`rill-backend/src/core/`)

| File | Responsibility | Key exports & behavior |
|---|---|---|
| `config.ts` | Central config + fail-fast boot + Sui clients | `config` object; `assertBootSafe()` **throws at module load if `network==='mainnet' && !guardPackageId`** (a guardrail-only flow would otherwise 500 on every compile). Builds **two `SuiGrpcClient`** (not JSON-RPC): `suiClient` (active net), `mainnetSuiClient` (always mainnet, for mainnet-only reads). `BACKEND_ROOT` anchors paths to the package, not `cwd`. Testnet is the default; mainnet has **no** default guard package. |
| `protocols.ts` | Curated protocol addresses per network | `CETUS`, `HAEDAL` (`minStakeMist = 1e9`, abort 4 below), `SUI_CLOCK_ID='0x6'`, `DEFAULT_SIMULATE_SENDER` (zero address = keyless devInspect sender). `getProtocolRegistry()` for `/protocols`. **DeepBook has NO hardcoded addresses** — pools/coins/packageIds come from `@mysten/deepbook-v3`. |
| `node-config.ts` | Validated config parsing + runtime-param merge + per-protocol resolvers | `resolveEffectiveFlow(flow, runtimeParams)` is the flow's front door: precedence **config < inputs < runtimeParams**; rejects a runtime key not allowed for any node, or flat params with >1 matching node. `RUNTIME_KEYS.cetus_swap = ['amount_in','min_amount_out']`. `suiToMist()` is the single float→mist path (KTD-2). **`min_amount_out` uses `optionalString` — no server fallback** (R7: a 1-mist floor is fake protection). |
| `agent-wallet.ts` | Optional env-loaded wallet binding | `loadAgentWalletFromEnv()` → `{packageId,walletId,capId,coinType}` or undefined. When set, PTBs fund via `agent_wallet::spend()` instead of `tx.gas`. `SUI_COIN_TYPE`. |
| `walrus-client.ts` | Walrus-extended gRPC client factory | `createWalrusClient()`. |
| `errors.ts` | Error hierarchy + Hono handler | `AppError`(400)/`ValidationError`(422)/`NotFoundError`(404). `errorHandler` returns `{success:false,error,type}` for `AppError`; **any non-AppError → generic 500, never leaks message/stack.** |

---

## 3. Backend — compile engine (`rill-backend/src/features/compiler/`)

### `compiler.service.ts` — `compileFlow(flow, options, runtimeParams): CompileResult`
The FlowGraph → **one unsigned PTB** engine. Steps:
1. `findFlowStructureIssues` (unique ids, real edge endpoints, registered handles) → 422. Runs here too so MCP callers that bypass the HTTP schema still get it (R13).
2. `resolveEffectiveFlow` (merge config/inputs/runtime).
3. `topologicalSort` — DFS, **throws `ValidationError` on a cycle**.
4. `computeRootSuiFunding` — sum each adapter's `rootSuiFunding` (only when the node has no upstream coin edge).
5. **Funding chokepoint:** if `agentWallet` bound & root>0 → one `agent_wallet::spend(wallet, cap, u64(rootTotal), Clock)` producing `budgetCoin` (SUI-only, else throws); else `fundSuiCoin` splits from `tx.gas`.
6. **Root-budget guardrail loop** — guardrails with *zero* incoming edges assert on `budgetCoin` directly (paired with the adapter's early-return = KTD-3 dedupe).
7. **Adapter loop** in topo order — `getAdapter(node.type).build(ctx)`; unknown type → warn + skip. Consumers read `nodeOutputs[source]` and **must `delete`** it.
8. `settleCoin` sweep (the single cleanup owner, KTD-3): SUI → `mergeCoins(gas)`; other coin → `transferObjects(sender)`, or **throws if no sender** (never lose a coin).
Returns `{transaction, resolvedFlow, warnings, agentWalletBound, budgetSpendMist}`.

### `simulator.service.ts` — `simulateTransaction(tx, sender?)`
Wraps gRPC `simulateTransaction` (devInspect-style; **never signs**). RPC throw is caught → returns a classified `{ok:false}`, never throws. `classifySimulation`: **verification is a two-value enum `'verified'|'unverified'`** (there is no `'failed'`); failure is the boolean `ok`. Only case of `unverified`: `!ok && isCetusDevInspectVersionAbort(error)`.

### `pool-resolver.ts`
`resolvePoolTypeArgs(poolId)` reads on-chain `Pool<A,B>`. `pickSwapFunction` decides a2b/b2a (`a2b = inputCoinType===coinTypeA`). **`isCetusDevInspectVersionAbort`** (R3): true only if error contains `'checked_package_version'` **AND** one of the three curated Cetus package ids — not a bare substring, so lookalikes aren't misclassified.

### `preview.service.ts` / `ptb.util.ts`
`buildPreview(flow, warnings)` → human text. `serializeUnsignedPtb(tx)` → base64 tx JSON (intents resolved). `inspectTransaction(tx)` → `{allowedTargets, objectIds}` read from the PTB's own commands/inputs (feeds the envelope's allowlist).

---

## 4. Backend — protocol adapters (`rill-backend/src/features/protocols/`)

Contract (`types.ts`): each adapter has `rootSuiFunding(node,flow)` and `build(ctx)`. Adapters **only record** produced coins (into `nodeOutputs`/`extraCoins`); they never merge/transfer — the compiler's sweep owns that.

| Adapter | nodeType | Behavior |
|---|---|---|
| `cetus.adapter.ts` | `cetus_swap` | Builds `router::swap` directly (zero-coin pattern: exactly one `0x2::coin::zero` for the unfunded side; an extra aborts execute with `UnusedValueWithoutDrop` which devInspect misses). Sources coin from upstream edge / sender (`sourceCoinFromSender`, paginates `listCoins`, **MAX 10 pages**) / `fundSuiCoin`. **R7 slippage:** if `!min_amount_out && !feedsGuardrail` → **throws**. Injects `assert_min_value` on output unless a downstream guardrail asserts it. Records output; pushes ≈0 leftover to `extraCoins`. |
| `haedal.adapter.ts` | `haedal_stake` | `request_stake` (SUI→haSUI). **Throws if `amount < minStakeMist` (1 SUI, abort 4).** Consumes one SUI coin, produces no chainable output. |
| `deepbook.adapter.ts` | `deepbook_limit_order` | **Hero path, all preconditions fail-closed:** requires `agentWallet` (SUI-only), pre-provisioned `balanceManagerId`, delegated `tradeCapId`, `poolKey`/`price`/`quantity`, `spendAmountMist>0`. `balance_manager::deposit` of the spend-funded coin, then `DeepBookClient.placeLimitOrder(...)(tx)` appends `generate_proof_as_trader` + `pool::place_limit_order`. **The one place a protocol SDK builds (not signs) commands.** |
| `guard.ts` | (injection helper) | `injectMinOutAssert(tx, coin, coinType, minOut)` — no-op when `minOut<=0`; **throws if `minOut>0` and `guardPackageId` unset** ("refusing an unguarded PTB"). `resolveGuardrailMinValue` warns when `<=0` (R1). |
| `guardrail.adapter.ts` | `guardrail` | Pass-through sink. **Zero incoming edges → early return** (compiler owns it). Else collects incoming coins (must share coin type, else throws), asserts `min_value` per coin **only when `minValue>0`** (else merges + warns "no protection enforced"), merges into one output. |
| `ptb.adapter.ts` | `ptb` | **Enforces nothing** — only warns if >1 PTB node exists. Inert boundary marker. |
| `registry.ts` / `handles.ts` | | `getAdapter(nodeType)`; `NODE_HANDLES` per-type valid edge handles; `findFlowStructureIssues` the shared structural gate. |

---

## 5. Backend — MCP, skill-runner, setup, walrus, HTTP

### MCP (`src/features/mcp/`)
- **`mcp.service.ts`** — MCP Streamable-HTTP JSON-RPC. Server name `rill-actions`. Tools: `list_actions`, `describe_action`, `build_action`. **Keyless guard `assertKeylessToolArguments`** recursively rejects any arg whose normalized key is `execute`/`force` (→ "sign locally") or `privatekey`/`secretkey`/`mnemonic`/`keypair` (→ "public object IDs only"); runs on **every** `tools/call`. A `build_action` result with `refused===true` is surfaced as an MCP **error** (`isError`) so it can't be mistaken for signable content.
- **`skill-runner.service.ts`** — `runFlow(flow, params, options)`: hero-gate (exactly 1 DeepBook node) → compile → serialize → simulate → **if `!ok` return an `ActionBuildRefusal` (no `unsignedPtb`/`actionDigest`/`version` — deliberately unsignable, R3/KTD-4)** → `digestUnsignedPtb` (SHA-256, a hash not a signature) → `ExecutionEnvelope` (`expiresAt = now+5min`). **Never signs.**
- **`skills.store.ts`** — file-backed JSON store; atomic write (`.tmp`+rename); load-time filter drops non-hero flows and re-canonicalizes name/description/toolDefs.
- **`tool-schema.ts`** — `isHeroActionFlow` predicate (exactly 1 `deepbook_limit_order`; other nodes only `ptb`/`guardrail`); MCP input schemas.
- **`skill-doc.ts`** — generates `skill.md` (the agent runbook): remote `rill-actions` + local `rill-wallet` setup, tool order, and the security rule "never request hosted execution, never pass raw PTB bytes to a generic signer." **No `sui-signer.ts` exists** — signing lives only in `packages/rill-signer`.

### Setup (`src/features/setup/setup.service.ts`)
`prepareSetupPlan(...)` builds two unsigned PTBs: (1) `create_wallet<SUI>(funds, agent, perTx, expiry, allowed_packages=[deepbookPkg])` + `balance_manager::new` + `public_share_object`; (2) `mint_trade_cap` (**placeholder BalanceManager id** — the signer fills the real one) + transfer to agent. Computes a deliberately-far, unlikely-to-fill onboarding order from live `midPrice`. Caps: throws if `spendAmountMist>perTxMist` or `budgetMist < perTxMist + minimumRemainingMist`.

### Walrus (`src/features/walrus/audit.service.ts`)
`readAuditTrail(blobId)` — reads a blob, **caps 256 KB**, `JSON.parse`, then **`AuditRecordSchema.safeParse`** (never trusts `as AuditRecord`). Uploads are disabled (`walrusEnabled` default false).

### HTTP (`src/http/` + `src/index.ts`)
CORS wildcard/no-credentials, 512 KB body limit (413), `errorHandler` on all routes.

**REST endpoints (all under `/api`):**
| Method | Path | Purpose |
|---|---|---|
| GET | `/protocols` | Network protocol registry |
| POST | `/introspect` | **Always 501** — gRPC client can't read Move bytecode/ABI (honest, R15) |
| POST | `/resolve` | Semantic manifest — curated Cetus/Haedal only |
| POST | `/compile` | Flow → unsigned PTB + preview |
| POST | `/simulate` | Compile + devInspect |
| POST | `/publish` | Publish a hero flow as an MCP skill |
| GET | `/skills`, `/skills/:id/skill.md` | List / agent runbook |
| POST | `/execute` | Build a strictly-simulated ExecutionEnvelope (refusal → **422**) |
| POST | `/setup/prepare` | Onboarding PTBs + run-set template |
| GET | `/audit/:blobId` | Read Walrus audit record (errors → **generic sanitized 404**) |
| GET·POST | `/mcp/:skillId` | MCP JSON-RPC (GET→302 to skill.md; origin-gated) |

Guards: `MAX_FLOW_NODES=20` (422), `MAX_STORED_SKILLS=500` (507, never evicts), `resolveAgentWallet` binds the server wallet **only when `useServerWallet===true`** (R13), `isAllowedMcpOrigin` exact-hostname match (R14). `api.schema.ts` Zod schemas are all `.strict()`; `openapi.ts` documents the honest behavior (501 introspect, 422 refusal, sanitized 404).

---

## 6. Signer + SDK — the security model (`packages/`)

**Trust boundary: the backend builds unsigned PTBs and holds no key; the signer holds the key and trusts no backend bytes without independent structural inspection.**

### SDK (`packages/rill-sdk/src/`)
- **`envelope.schema.ts`** — the single Zod `ExecutionEnvelopeSchema`, **`.strict()` at every nesting level** (KTD-4: no field can be smuggled in; an added field fails closed). `verification` enum = `['verified','unverified']` only. Semantic checks (digest/TTL) are deliberately NOT here — they're the signer's job.
- **`execution-envelope.ts`** — `assertExecutionEnvelope(value)`; `digestUnsignedPtb(b64)` = SHA-256 over the **UTF-8 bytes of the base64 string** (both sides derive it identically; catches byte drift).
- **`amounts.ts`** — the single money path (KTD-2): `decimalToBaseUnits`/`parseU64String`, pure string/bigint, reject scientific notation / excess precision / >`U64_MAX`. **No IEEE-754 ever touches a token amount.**
- **`tokens.ts`** — coin-decimals registry (SUI 9, USDC 6, WAL 9) keyed by full Move type.
- **`client.ts`** — `RillClient` HTTP + MCP JSON-RPC client. **`errors.ts`** — `RillApiError`.

### Signer (`packages/rill-signer/src/`) — SECURITY-CRITICAL, all checks fail-closed
- **`core.ts`** — key handling + `executeEnvelope` orchestration. Key hygiene (R10): raw `secretKey` **deleted** from config after derivation; keypair kept only in a `WeakMap`; multi-scheme (`keypairFromSuiPrivateKey`). `executeEnvelope` order: validate → **byte-pin (R11:** re-serialize+digest #2 before any simulate/sign, defeating TOCTOU) → `assertCapabilitiesActive` → re-simulate exact tx (must succeed) → gas ≤ ceiling → **sender SUI outflow ≤ spend+gas (R9)** → sign → submit → verify success. **Mainnet guard:** refuses unless `RILL_ALLOW_MAINNET=true`.
- **`policy.ts`** — the fail-closed engine:
  - `validateExecutionEnvelope`: TTL not-expired **and ≤ now+5min**; network/sender/actionId/identity-ids all pinned; **simulation gate — accepts ONLY `ok && verification==='verified'`; `unverified` is ALWAYS rejected (there is no `allowUnverifiedSimulation`)**; declared-gas ≤ ceiling; digest #1; exact target *sequence* + off-scope rejection; exact object set; **two independent spend ceilings** (`maxAmountMist` and `demoParams.depositSui`, from unrelated sources so neither relaxes the other).
  - `inspect` — the hardcoded DeepBook manifest: exact `spend`→`deposit`→`generate_proof`→`place_limit_order` sequence, wallet-funded deposit (split == spend), TradeCap-proof-authorized order, single-split + single terminal merge-to-gas. Any other command shape → throw.
  - `assertCapabilitiesActive` — **live on-chain reads:** wallet must be shared & not revoked & agent-bound; live `expires_at_ms`/`per_tx_max`/`budget`/`minimumRemaining` enforced from the wallet's own state; each cap held by the signer and correctly bound.
  - `inspectOnboarding` — a **second, independent** inspector (shares zero code) for onboarding PTBs; unknown command kind → throw; split total ≤ budget ceiling.
- **`config.ts`** — `isAutoOnboardingAllowed()` (launch-env only, exact `'true'`); `autoCreateRunSets` deliberately **removed** from the persisted shape and un-settable at runtime.
- **`runsets.ts`** — run-set persistence (`.rill/runsets/`, sanitized filenames). **`mcp.ts`** — the local `rill-wallet` MCP server; tools: `wallet_status`, `list_capabilities`, `execute_rill_action`, `explain_rejection`, `signer_status`, `get/set_onboarding_config`, `request_faucet`, `list_run_sets`, `create_run_set`. `create_run_set` inspects backend onboarding bytes **unconditionally (R8)**, and **rebuilds the tradeCap PTB locally** rather than signing backend bytes. **`cli.ts`** — `rill-sign` (`--unsafe-ptb` dev-only).

**The enforcement chain (each throws on first violation):** schema strictness → envelope validation (verified-only sim, dual ceilings, target sequence) → structural PTB inspection → byte-pinning → live liveness → re-simulation + effects check → mainnet guard → onboarding boundary → key hygiene.

---

## 7. Move contracts (`move/`)

### `agent_wallet::agent_wallet` (v2)
Generic `AgentWallet<T>` shared object. **v2 adds:** `cap_id` (active cap; rotation invalidation), `window_ms`/`window_max`/`window_start_ms`/`spent_in_window` (rolling quota), and setters.

**Abort codes:** 1 NOT_OWNER · 2 REVOKED · 3 EXPIRED · 4 OVER_PER_TX · 5 OVER_BUDGET · 6 BAD_CAP · 7 ZERO_AMOUNT · **8 OVER_WINDOW** · **9 NOT_AGENT** · **10 EXPIRY_NOT_FORWARD**.

**`spend<T>(wallet, cap, amount, clock, ctx)` assert order:** cap.wallet matches → `cap_id` matches (rotation) → **`sender==agent`** (NOT_AGENT) → not revoked → not expired → amount>0 → ≤per_tx_max → ≤budget → **window check** → take coin.

**Window logic:** disabled entirely if `window_ms==0` OR `window_max==0`; else lazily rolls (`now >= start+window_ms` resets `spent_in_window`), then `assert spent_in_window+amount <= window_max`.

**Functions:** `create_wallet`, `spend`, `top_up` (owner), `revoke` (owner, drains), **`rotate_agent`** (owner; new cap, old cap fails BAD_CAP), **`set_per_tx_max`/`extend_expiry`** (forward-only, EXPIRY_NOT_FORWARD; can re-enable an expired wallet)**/`set_window`** (owner). Events include `AgentRotated`, `ConfigChanged`.

**Two critical semantics:**
- **`expires_at_ms == 0` means PERMANENTLY EXPIRED, not "no expiry"** — the assert `now_ms < expires_at_ms` always fails at 0. (Opposite of the window sentinel where 0 = disabled.) Never pass 0.
- **`allowed_packages` is recorded on-chain but NOT enforced in `spend`** — protocol scope is enforced at the build/policy layer (Move can't intercept a released coin). `is_allowed` view: empty = allow-all.

Tests: **25** (happy path, every abort code, window rollover, sender check, cap rotation, all setters).

### `rill_guard::guard`
`assert_min_value<T>(coin: &Coin<T>, min: u64)` — aborts `E_SLIPPAGE=1` if `coin.value() < min`; immutable borrow so the coin stays usable downstream. Injected by the compiler after every swap output. Tests: **2**.

---

## 8. Frontend — Rill Studio (`rill-frontend/src/`)

Stack: TanStack Router, React Flow, Framer Motion + GSAP, Radix, Tailwind. Six vitest suites (money/flow/persistence logic).

### Routes
- **`routes/builder.tsx`** — the Studio. Palette **filtered to backend-supported actions only** (Cetus swap / Haedal stake / DeepBook limit, Cetus first). Reads network from `/health` (`Live on {network}`). Draft restore/autosave (R16, 800ms debounce, `beforeunload` guard). `computePublishGate` disables "Compile & export" with a reason. `applyWireCorrections` runs before Simulate/Export so the visible canvas matches compiled output. `DEFAULT_GUARDRAILS` are **cosmetic checklist labels** — the enforced field is a node's `minValue`/`coinType`.
- `index.tsx` (landing), `pitch.tsx` (8-slide deck, hardcodes deployed ids), `protocols.tsx` (all 9, marketing), `docs.tsx`.

### lib/
- **`flow-mapper.ts`** — canvas → backend `FlowGraph`. `buildFlowGraph` maps `cetus`→`cetus_swap`, `haedal`→`haedal_stake`, `deepbook`→`deepbook_limit_order`, plus `ptb`/`guardrail`; returns **`skipped`/`skippedEdges` with reasons** (R17). `isBackendSupported` = the "compiles today" predicate. `applyWireConstraints` forces Cetus→Haedal edges to output SUI and caps stake to swap output. **Edges touching trigger/output/ptb are dropped** (canvas-only sequencing; PTB is "not a real boundary yet").
- **`wire-inference.ts`** — draw-time `isValidWireConnection` (rejects self-loop, backwards guardrail, cycles, second coin-input into an action); `inferWireKind` (coin only for swap→stake).
- **`action-config.ts`** — `TESTNET_MANIFEST`, token registry, **per-token decimals** (`parseActionAmount` via `findToken(coinType).decimals`, KTD-2 — fixes USDC 6-dec). Note: swap `min_amount_out` is hardcoded `"1"` in the FE flow config (see §9). `toMist` is UI-only.
- **`protocols.ts`** — catalog of **9** protocols; **`BACKEND_PROTOCOL_IDS = {cetus, haedal, deepbook}`** are the only three that compile.
- **`rill-api.ts`** — typed client, `API_BASE` from `VITE_RILL_API_URL`, **20s hard timeout** on every request (R18).
- **Audit-hardening pieces:** `publish-gate.ts` (single truth for simulate-vs-publish eligibility; **only a single DeepBook order can publish** today — Cetus/Haedal only simulate), `draft-storage.ts` (localStorage, schema-versioned, corrupt→null), `graph-hash.ts` (FNV-1a idempotent-publish hash), `use-flow-request.ts` (abortable fetch hook, distinguishes AbortError from TimeoutError).

### components/flow/
`nodes.tsx` (5 node renderers + per-type config forms with live amount validation), `simulate-dialog.tsx` (**guardrail toggles are read-only/presentational post-audit** — "what actually runs, not a toggle"; gates synchronously before any network call), `export-dialog.tsx` (explicit publish only on click; idempotent via graph hash; stale-record banner), `discover-dialog.tsx` (real ABI introspect, no mock data), `flow-warnings.tsx` (dropped nodes/edges + reasons), plus `deletable-edge`, `aligned-handle`, `token-select`, `protocol-logo`, `dialog-shell`.

---

## 9. Honest status & known limitations

- **Only DeepBook limit order is fully live** (proven on testnet). Cetus swap and Haedal stake **compile and simulate** but publish is gated to a single DeepBook order. Cetus **cannot be strictly simulated on testnet** (`checked_package_version` devInspect abort → `unverified` → the signer refuses to sign it).
- **`/introspect` returns 501** by design (gRPC has no bytecode/ABI). Semantics come from curated `/resolve` manifests (Cetus/Haedal only).
- **The agent supplies `min_amount_out`** (it's a runtime key); the Cetus adapter requires it *unless* a downstream guardrail asserts a floor. There is **no live-quote derivation** and **no `allowUnverifiedSimulation` opt-in** on this codebase — both were deferred work on a superseded branch.
- **FE `action-config.ts` hardcodes swap `min_amount_out: "1"`** while the backend adapter would reject a missing floor — a FE flow always carries a floor, but it's a fixed `"1"`, not a real slippage bound. (This is the gap the deferred pool-state quote feature addressed.)
- **`expires_at_ms == 0` bricks a wallet** (permanently expired). **`allowed_packages` is not Move-enforced.** `AgentCap has store` (transferable) — rotation, not non-transferability, is the revocation mechanism.
- **Skills persist to a local JSON file** — no DB/auth/multi-tenant. Walrus upload disabled.
- **`agent_wallet` source is v2** but the deployed testnet address may be v1 — verify before relying on window/rotation on-chain.

---

## 10. Quick file index

- Compile chokepoint: `rill-backend/src/features/compiler/compiler.service.ts`
- Simulation classification: `rill-backend/src/features/compiler/simulator.service.ts`
- Envelope build (keyless): `rill-backend/src/features/mcp/skill-runner.service.ts`
- Remote MCP + keyless guard: `rill-backend/src/features/mcp/mcp.service.ts`
- REST routes: `rill-backend/src/http/routes/api.routes.ts`
- Onboarding: `rill-backend/src/features/setup/setup.service.ts`
- Money path (amounts): `packages/rill-sdk/src/amounts.ts`
- Envelope schema: `packages/rill-sdk/src/envelope.schema.ts`
- Signer policy engine: `packages/rill-signer/src/policy.ts`
- Signer orchestration: `packages/rill-signer/src/core.ts`
- Local signer MCP: `packages/rill-signer/src/mcp.ts`
- Move: `move/agent_wallet/sources/agent_wallet.move`, `move/rill_guard/sources/guard.move`
- Studio: `rill-frontend/src/routes/builder.tsx`, `rill-frontend/src/lib/flow-mapper.ts`, `rill-frontend/src/lib/publish-gate.ts`
