# Rill E2E Testing Guide

This guide walks through the full vertical-slice test for Rill: UI → backend → signer → Sui testnet.

## What is currently wired

- **Frontend builder**: PTB wrapper node, Guardrail node, and DeepBook limit-order action node can be composed and published as an MCP skill.
- **Backend**: compiles the flow into an `ExecutionEnvelope`, validates guardrails, resolves DeepBook pools, and exposes the skill via MCP.
- **Signer**: runs as a local MCP server, stores run-sets, enforces the policy, and signs/submits the PTB on testnet.

A live order has already been placed through this stack on testnet. These steps reproduce that path.

## Prerequisites

- Bun installed (`bun --version`)
- Sui CLI installed and configured for `testnet`
- Testnet SUI in the signer address (request from the [testnet faucet](https://faucet.testnet.sui.io/) if needed)
- A Sui private key exported as `suiprivkey1…` (never commit it; load it from env only)

## 1. Component tests

Run these before any E2E run to catch regressions:

```bash
cd /Users/xfajarr/Hackathon/Rill/rill-demo-day

bun test --cwd rill-backend
bun test --cwd packages/rill-signer
bun test --cwd packages/rill-sdk
bun run --cwd rill-frontend build

cd move/agent_wallet && sui move test
cd ../rill_guard && sui move test
```

## 2. Start the backend

```bash
cd rill-backend
SUI_NETWORK=testnet bun run dev
```

The API is available at `http://localhost:3002`.

## 3. Start the frontend

```bash
cd rill-frontend
bun run dev
```

Open the URL printed by the dev server (usually `http://localhost:5173`).

## 4. Build and publish a skill

1. In the builder, add a **PTB** node.
2. Add a **Guardrail** node and set:
   - `minValue` (e.g. `0.5`)
   - `coinType` (e.g. `0x2::sui::SUI`)
3. Add a **DeepBook limit order** action node with:
   - `poolKey`: `SUI_DBUSDC`
   - `price`, `quantity`, `isBid`, `clientOrderId`
   - `depositSui`: enough gas budget for the run-set (e.g. `1.1`)
4. Wire **PTB → order** and **Guardrail → order**.
5. Click **Publish** and copy the MCP server URL.

## 5. Backend compile smoke test

You can test the compiler without touching the chain:

```bash
curl -X POST http://localhost:3002/api/compile \
  -H 'Content-Type: application/json' \
  -d '{
    "flow": {
      "nodes": [
        { "id": "ptb", "type": "ptb", "config": {} },
        { "id": "guard", "type": "guardrail", "config": { "minValue": "500000000", "coinType": "0x2::sui::SUI" } },
        { "id": "order", "type": "deepbook_limit_order", "config": { "poolKey": "SUI_DBUSDC", "price": 1, "quantity": 0.01, "isBid": false, "clientOrderId": "71699", "depositSui": 1.1 } }
      ],
      "edges": [
        { "source": "ptb", "sourceHandle": "out", "target": "order", "targetHandle": "in" },
        { "source": "guard", "sourceHandle": "out", "target": "order", "targetHandle": "in" }
      ]
    },
    "sender": "0x<your-address>"
  }'
```

A successful response returns `unsignedPtb`, `preview`, and `warnings`. The preview should list the PTB, Guardrail, and DeepBook steps.

## 6. Start the local signer MCP server

```bash
cd packages/rill-signer
RILL_SUI_PRIVATE_KEY=<suiprivkey1...> \
RILL_MCP_SERVER_URL=<copied-mcp-url> \
RILL_ALLOW_TESTNET=true \
bun src/mcp.ts
```

The signer exposes tools such as `list_actions`, `describe_action`, `create_run_set`, `build_action`, and `execute_rill_action`.

## 7. Onboard a run-set

A run-set is the set of on-chain objects the signer needs to execute the skill (AgentWallet, BalanceManager, TradeCap).

1. Call `list_actions` to see the published action.
2. Call `describe_action` to get the setup plan.
3. Call `create_run_set` with the plan and `confirmed: true`.

The signer will:
- Create an `AgentWallet`
- Create a DeepBook `BalanceManager`
- Mint a `TradeCap`
- Deposit the requested SUI budget

The run-set is saved to `packages/rill-signer/.rill/runsets/`.

## 8. Build and execute

1. Call `build_action` with the run-set label and order parameters.
2. The signer returns an `ExecutionEnvelope`.
3. Call `execute_rill_action` with the envelope.

The signer will:
- Reconstruct the PTB
- Verify the policy and guardrail target
- Sign and submit the transaction

## 9. Verify on-chain

- Check the transaction digest returned by `execute_rill_action` on [Suiscan testnet](https://suiscan.xyz/testnet).
- Confirm the order appears in the `SUI_DBUSDC` pool with the expected `clientOrderId`.
- Check the AgentWallet `Spent` event and the DeepBook `OrderPlaced` event.

## 10. Reclaim gas (optional)

If you created multiple AgentWallets during rehearsal and no longer need them, revoke the unused ones to reclaim the deposited SUI budget:

```bash
cd packages/rill-signer
RILL_SUI_PRIVATE_KEY=<suiprivkey1...> bun scripts/hero-owner.ts revoke --runset <path-to-runset>
```

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `No key configured` | `RILL_SUI_PRIVATE_KEY` missing | Export the key in the shell before running the signer. |
| `Insufficient gas` | Address balance too low | Request testnet SUI from the faucet or revoke an unused AgentWallet. |
| `Run-set price/exp mismatch` | Envelope parameters changed after the run-set was created | Update the run-set JSON to match the actual envelope values, or recreate the run-set. |
| `Guardrail assertion failed` | The budget coin value is below the guardrail `minValue` | Increase the deposit amount or lower the guardrail. |
| `TradeCap not found` | The run-set is missing the TradeCap ID | Recover the TradeCap from the setup transaction and write it into the run-set. |

## Important notes

- Never commit a private key. The `.gitignore` already excludes `.rill/`, `.env`, and run-set files.
- The E2E flow is currently demo-grade. It requires testnet SUI and a local signer.
- For CI/automation, mock the Sui client and use the backend `/api/compile` and `/api/simulate` endpoints.
