# Rill Project Context

This document is a snapshot of what the Rill project is, how it is built, and where the current demo-day vertical slice stands.

## 1. What Rill is

Rill is a visual flow builder for Sui protocols that turns on-chain actions into agent-callable skills.

- A user drags protocol actions (swap, stake, limit order) into a ReactFlow canvas.
- They wire actions together, add a PTB wrapper, and optionally attach guardrail checks.
- The canvas is published as an MCP skill.
- An AI agent (or a local signer) calls the MCP tools, the backend builds a single unsigned PTB, and the signer executes it on-chain.

The goal is “design the flow once; agents call it forever.”

## 2. Repository state

- **Repository**: `https://github.com/eseslabs/rill` (moved from `ESES-Labs/rill`).
- **Worktree**: `/Users/xfajarr/Hackathon/Rill/rill-demo-day`.
- **Current branch**: `feat/rill-demo-day-vertical-slice`.
- **Base branch for PR**: `develop` (created from `main` and kept at `main`).
- **PR link**: https://github.com/eseslabs/rill/compare/develop...feat/rill-demo-day-vertical-slice
- **Lovable connection**: This project is connected to Lovable. Do not force-push, rebase, amend, or squash commits that are already pushed.

## 3. Monorepo layout

Bun workspace with three packages:

```
rill-demo-day/
├── rill-backend/          # Hono API, compiler, MCP skill runner, protocol adapters
├── rill-frontend/         # Vite + React 19 + TanStack Router + ReactFlow + Tailwind v4
├── packages/
│   ├── rill-sdk/          # Types and client for the Rill API
│   └── rill-signer/       # Local MCP signer, policy, run-set persistence
├── move/
│   ├── agent_wallet/      # Move package: AgentWallet, spend/revoke
│   └── rill_guard/        # Move package: assert_min_value guard
├── docs/                  # E2E testing guide and this context doc
└── scripts/               # Feature-branch marker
```

## 4. Tech stack

- **Runtime**: Bun 1.x.
- **Backend**: Hono, Zod, `@mysten/sui`, `@mysten/deepbook-v3`, `@mysten/walrus`, MCP SDK.
- **Frontend**: Vite, React 19, TanStack Router, ReactFlow, Tailwind CSS v4, Radix UI, Framer Motion.
- **Signer**: Local MCP server using `@mysten/sui`, Ed25519 keypair, run-set JSON files.
- **Contracts**: Sui Move (`agent_wallet`, `rill_guard`).
- **Network**: Testnet for the demo-day rehearsal; mainnet is the eventual target.

## 5. Current feature branch work

The `feat/rill-demo-day-vertical-slice` branch contains the full demo-day slice:

- **SDK** (`packages/rill-sdk`): `ExecutionEnvelope` types, client helpers, and tests.
- **Signer** (`packages/rill-signer`): policy engine, run-set persistence, MCP tools (`list_actions`, `describe_action`, `create_run_set`, `build_action`, `execute_rill_action`), and tests.
- **Backend** (`rill-backend`): protocol adapters, compiler, simulator, MCP skill runner, setup/onboarding service, hero evidence/owner scripts, and tests.
- **Frontend** (`rill-frontend`): builder canvas with PTB, Guardrail, and action nodes; publish dialog; simulate dialog; flow mapper.
- **Docs**: `docs/e2e-testing-guide.md` and `docs/project-context.md`.

### Recent commits

```
bda1ed2 docs: add end-to-end testing guide
81a58fb feat(frontend): builder PTB/guardrail node wiring
6c6b1c3 feat(backend): PTB/guardrail adapters, setup flow, and MCP skill runner
a612fca feat(signer): policy, run-sets, and MCP wiring
67232d9 feat(sdk): execution envelope types and client support
72b6702 chore(root): update .gitignore, README, and lockfile for demo-day slice
```

## 6. Node / protocol status

| Node | Status | Notes |
|------|--------|-------|
| **DeepBook limit order** | ✅ Live-tested on testnet | Full e2e execution succeeded; order placed on `SUI_DBUSDC`. |
| **Cetus swap** | ✅ Wired, not live-tested | Adapter builds `router::swap`; frontend maps to action node; supports composing into Haedal stake. DevInspect simulation has a known fallback because Cetus testnet aborts on `checked_package_version`. |
| **Haedal stake** | ✅ Wired, not live-tested | Adapter calls `request_stake`; frontend maps to action node; enforces 1 SUI minimum on testnet. |
| **PTB wrapper** | ⚠️ Visual marker | Registered as an adapter, but the adapter only warns if multiple PTB nodes exist. The entire flow is already compiled into a single PTB regardless. |
| **Guardrail node** | ⚠️ Guards coin outputs only | When wired after an action that produces a coin (e.g., Cetus → Guardrail), it injects `rill_guard::assert_min_value`. If wired **before** an action (Guardrail → Action), the edge is currently dropped and the guardrail does nothing. |

### Known semantic gaps

1. PTB node does not yet enforce a transaction boundary or group sub-flows.
2. Guardrail node does not guard a budget coin going into a downstream action.
3. Cetus and Haedal have not been executed on-chain in this rehearsal.

## 7. Signer and run-set flow

The local signer is an MCP server that:

1. Connects to the backend MCP URL published by the frontend.
2. Reads a Sui private key from `RILL_SUI_PRIVATE_KEY` (never committed).
3. Stores run-sets (JSON files in `packages/rill-signer/.rill/runsets/`) containing:
   - `walletId`, `agentCapId`, `balanceManagerId`, `tradeCapId`, `poolId`
   - `allowedTargets` for policy enforcement
   - `demoParams` for the action
4. Onboards a run-set by creating the AgentWallet, BalanceManager, and TradeCap on-chain.
5. Builds an `ExecutionEnvelope` from the skill and run-set.
6. Executes the envelope by reconstructing the PTB, verifying the policy, and signing/submitting.

### Rehearsal run-set (public IDs only)

- **Label**: `skill_15df5c585d_recovered_1784260539436`
- **Sender**: `0xf73e2dea746d9a7071ec5c49bfc2a75f73be5efd02212632e849217234e7ab46`
- **AgentWallet**: `0xdabcba27d4113daa04125095b016567c50c8b77941b7708e1f686c52e1e239cc`
- **Current wallet**: `0xec40cd8d867e7be5cfd9ed4c05980e6f21b02f329c78c789dec5dca0941626d6`
- **BalanceManager**: `0xc31156d288e416fab4c8cc42b7cc5ebb110d186f2a402603cbe6aa5bfd0512da`
- **TradeCap**: `0xdb00c14fd83ec9eabc71c5383f06db064eba60fdab3c8df72bf0a9b5e332a5c6`
- **Pool**: `0x1c19362ca52b8ffd7a33cee805a67d40f31e6ba303753fd3a4cfdfacea7163a5`
- **Live execution digest**: `gDnRL1qkxcg48xtA2EtcNoD3pXGU8WSaZnCcZcWpAjJ`
- **Live order ID**: `170141183460496864954309720624205386657`

These IDs are public on-chain data. The private key is never persisted.

## 8. E2E testing status

A full E2E onboarding + execution has been completed:

- Recovered the run-set by minting the TradeCap.
- Revoked an unused second wallet to reclaim gas.
- Executed a DeepBook limit order on testnet.
- Verified the order and `Spent`/`OrderPlaced` events on Suiscan.

Component tests passed at the time of the run:
- Backend: 55 tests passed.
- Signer: 79 tests passed.
- SDK: 6 tests passed.
- Move: 12 tests passed.
- Frontend: build succeeded.

See `docs/e2e-testing-guide.md` for the full reproducible steps.

## 9. Environment variables and secrets

Secrets are loaded from env only. Never commit them.

```bash
# Backend
SUI_NETWORK=testnet
SUI_RPC_URL=https://fullnode.testnet.sui.io:443
RILL_GUARD_PACKAGE_ID=...
AGENT_WALLET_PACKAGE_ID=...
DEEPBOOK_PACKAGE_ID=...

# Signer
RILL_SUI_PRIVATE_KEY=<suiprivkey1...>
RILL_MCP_SERVER_URL=<published-mcp-url>
RILL_ALLOW_TESTNET=true
```

`.gitignore` excludes `.env`, `.env*.local`, `.rill/`, and run-set files.

## 10. Important files and directories

- `rill-backend/src/features/protocols/` — protocol adapters (`cetus`, `deepbook`, `haedal`, `ptb`, `guardrail`).
- `rill-backend/src/features/compiler/` — flow graph → PTB compiler.
- `rill-backend/src/features/mcp/` — MCP skill runner, tool schema, skill docs.
- `rill-backend/src/features/setup/` — onboarding/run-set setup service.
- `rill-frontend/src/components/flow/nodes.tsx` — ReactFlow node components.
- `rill-frontend/src/lib/flow-mapper.ts` — maps canvas nodes to backend flow graph.
- `rill-frontend/src/routes/builder.tsx` — builder page and publish dialog.
- `packages/rill-signer/src/mcp.ts` — local MCP server and tool handlers.
- `packages/rill-signer/src/policy.ts` — policy and guardrail verification.
- `packages/rill-signer/src/runsets.ts` — run-set persistence.
- `packages/rill-sdk/src/` — SDK types and client.
- `move/agent_wallet/` and `move/rill_guard/` — Move contracts.
- `docs/e2e-testing-guide.md` — manual E2E walkthrough.

## 11. Open questions and next steps

- Should PTB node become a real transaction-boundary or stay a visual marker?
- Should Guardrail node support guarding the budget coin for a downstream action?
- Run a live Cetus swap and Haedal stake on testnet to confirm those adapters.
- Decide whether to keep the untracked debug scripts in `packages/rill-signer/scripts/` or delete them.
- Set up an automated CI E2E test using a mocked Sui client so the live-chain path does not run in CI.
- Merge the PR after review and rebase future work on `develop`.

## 12. Commands I keep using

```bash
# Component tests
bun test --cwd rill-backend
bun test --cwd packages/rill-signer
bun test --cwd packages/rill-sdk
bun run --cwd rill-frontend build

# Move tests
cd move/agent_wallet && sui move test
cd ../rill_guard && sui move test

# Backend
bun run --cwd rill-backend dev

# Frontend
bun run --cwd rill-frontend dev

# Signer MCP server
RILL_SUI_PRIVATE_KEY=<key> RILL_MCP_SERVER_URL=<url> bun run --cwd packages/rill-signer src/mcp.ts
```
