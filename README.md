<div align="center">

# Rill

**The transaction layer for AI agents on Sui.**

Any agent can safely transact with any Sui protocol — without hallucinating parameters or risking the whole wallet.

[Live API](https://api.rill.naisu.one) · [Studio](https://rill.naisu.one) · [API docs (Swagger)](https://api.rill.naisu.one) · [Project context](docs/project-context.md)

</div>

---

## Why Rill

> *"The next wave of internet users will be AI agents, not humans … every major category of software needs to be rebuilt for agents."* — [YC RFS, Software for Agents](https://www.ycombinator.com/rfs#software-for-agents)

On-chain finance was built for humans: wallets that pop up to click "approve," SDKs written for developers to
read, ABIs that mean nothing without docs. An agent can read on-chain data but can't *act* safely:

- **Semantic gap** — ABIs expose `arg0, arg1, arg2` with no meaning, so LLM agents guess and build wrong transactions.
- **The "approve wall"** — every action needs a human signature, or the agent holds a raw key that can drain the whole wallet (and get sandwiched/MEV'd).
- **Fragmentation** — Cetus, DeepBook, Haedal each ship different SDKs written for humans.

Rill is the **rebuild for agents as first-class citizens**: it turns Sui protocols into machine-readable,
self-describing tools (MCP / REST / Skill), compiles plain intents into correct, simulated PTBs **keyless**
(it never holds a key), and bounds every action with **two on-chain chokepoints** — so an agent can transact
**without a human in the loop**, and without risking the whole wallet.

## How it works

```
  Agent
    ├─ remote rill-actions: list_actions → describe_action → build_action
    │    Rill Cloud resolves, compiles, and strictly simulates without a key
    │    └─ unsigned ExecutionEnvelope
    └─ local rill-wallet: wallet_status → list_capabilities → execute_rill_action
         └─ exact envelope policy + live capability checks + re-simulation + local signature
              └─ Sui: agent_wallet::spend → DeepBook → bounded on-chain result
```

1. **Keyless PTB builder** — introspects packages, attaches semantics, compiles a visual/JSON flow into one simulated PTB.
2. **Two on-chain chokepoints (Move):**
   - **`agent_wallet`** — capped, revocable budget (budget · per-tx max · protocol scope · expiry · owner revoke). Every spend flows through `spend()`.
   - **`rill_guard`** — `assert_min_value` aborts any swap below the caller's slippage floor; injected automatically by the compiler.
3. **One build engine, three doors** — the same flow is exposed as an **MCP server**, **REST**, and a **Skill** link.
4. **Bounded build / sign split** — remote `rill-actions` returns an unsigned `ExecutionEnvelope`; local `rill-wallet` accepts only that envelope and signs through the run-specific policy.

## Use it with any agent

A published flow gives you an MCP URL. Connect your agent:

Set the local signer key only in the shell or secret manager that launches the agent. Never put it in
MCP JSON, command arguments, transcripts, or the repository.

```bash
export RILL_REMOTE_MCP_URL="https://api.rill.naisu.one/api/mcp/<skillId>"
export RILL_SIGNER_POLICY_PATH="$PWD/.rill/demo/sets/live.json"

claude mcp add --transport http rill-actions "$RILL_REMOTE_MCP_URL"
claude mcp add --transport stdio \
  --env "SUI_NETWORK=testnet" \
  --env "RILL_SIGNER_POLICY_PATH=$RILL_SIGNER_POLICY_PATH" \
  rill-wallet -- bun run packages/rill-signer/src/mcp.ts
```

Launch Claude from the shell where `RILL_SUI_PRIVATE_KEY` is already set. The persisted MCP configuration
contains only public network and policy-path values.

Or open the human-readable instructions: `GET /api/skills/<skillId>/skill.md`.

## Repository layout

| Path | Description |
|---|---|
| `rill-backend/` | Keyless Hono API — introspect, compile, simulate, publish, MCP/Skill server |
| `rill-frontend/` | Rill Studio — visual node-flow builder (TanStack Start) |
| `packages/rill-sdk/` | Typed HTTP client for the backend |
| `packages/rill-signer/` | Local bounded signer — MCP (`wallet_status`, `list_capabilities`, `execute_rill_action`, `explain_rejection`) |
| `move/agent_wallet/` | On-chain capped, revocable agent budget |
| `move/rill_guard/` | On-chain slippage floor (`assert_min_value`) |

## Deployed contracts (Sui testnet)

| Contract | Package ID |
|---|---|
| `agent_wallet` | [`0xd9265581…a636da`](https://suiscan.xyz/testnet/object/0xd9265581b6b930f5fd27d9ec98e67b48f876f5de7bd25155639d808e9da636da) |
| `rill_guard` | [`0xadec9955…e8c034`](https://suiscan.xyz/testnet/object/0xadec99557cf7771bce94737fdd3ea0bcc989d81e0860f3e69af55433dae8c034) |

## Quick start

Prerequisites: [Bun](https://bun.sh) ≥ 1.3.

```bash
# install workspace deps
bun install

# Backend (port 3002)
cd rill-backend && cp .env.example .env && bun run dev

# Frontend (separate terminal)
cd rill-frontend && cp .env.example .env && bun run dev
```

| Service | Local | Production |
|---|---|---|
| Backend API + Swagger | http://localhost:3002 | https://api.rill.naisu.one |
| Studio (frontend) | http://localhost:3000 | https://rill.naisu.one |

## API

Base path `/api` ([OpenAPI/Swagger](https://api.rill.naisu.one)).

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/protocols` | Supported protocols + defaults |
| `POST` | `/introspect` | Read a package's functions |
| `POST` | `/resolve` | Attach semantics to a function's params |
| `POST` | `/compile` | Flow → unsigned PTB + preview |
| `POST` | `/simulate` | Flow → dry-run (devInspect) + preview |
| `POST` | `/publish` | Flow → shareable MCP / Skill / REST link |
| `POST` | `/execute` | Build a strictly simulated unsigned `ExecutionEnvelope`; never signs |
| `GET` | `/skills` · `/skills/:id/skill.md` | List skills · human-readable skill doc |
| `GET`·`POST` | `/mcp/:skillId` | MCP endpoint (Streamable HTTP) |

## Testing

```bash
# Move contracts (unit tests)
cd move/agent_wallet && sui move test
cd move/rill_guard   && sui move test

# rill-signer (unit)
bun run --filter @rill/signer test

# Live on-chain battle-tests (need real public objects, policy, and a funded local key)
bun run rill-backend/scripts/agent-wallet-live-test.ts

export RILL_ACTION_ID=skill_...
export RILL_SIGNER_POLICY_PATH="$PWD/.rill/demo/sets/live.json"
# Set RILL_SUI_PRIVATE_KEY only in this launching shell from your secure secret source.
bun run packages/rill-signer/scripts/mcp-live-test.ts
```

`agent_wallet` and `rill_guard` are battle-tested on testnet — all caps, slippage, and owner-revocation
paths are proven by real on-chain transactions.

## Tech stack

Sui Move 2024 · Programmable Transaction Blocks · DeepBook v3 · `@mysten/sui` · Bun · Hono · Model Context Protocol · TanStack Start.
