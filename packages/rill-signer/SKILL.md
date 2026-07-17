---
name: rill-wallet
description: Execute Rill ExecutionEnvelopes locally through a fixed wallet, capability, amount, target, and DeepBook order policy.
---

# Rill Wallet

Rill Cloud is keyless. It discovers and builds actions through remote `rill-actions`; this local skill reads
public capability state and signs only a complete `ExecutionEnvelope` accepted by the run-specific policy.

## Setup

Set `RILL_SUI_PRIVATE_KEY` only in the shell or secret manager that launches the agent. Never place the key in
MCP JSON, command arguments, chat, transcripts, or the repository.

Set these public/local references:

```bash
export SUI_NETWORK=testnet
export RILL_SIGNER_POLICY_PATH="$PWD/.rill/demo/sets/live.json"
```

Configure the stdio server without a secret value:

```bash
claude mcp add --transport stdio \
  --env "SUI_NETWORK=$SUI_NETWORK" \
  --env "RILL_SIGNER_POLICY_PATH=$RILL_SIGNER_POLICY_PATH" \
  rill-wallet -- bun run packages/rill-signer/src/mcp.ts
```

Launch Claude from the shell where the signer key is already available to child processes.

## Required Sequence

1. Call local `wallet_status`; stop unless `strategyEligible` is true.
2. Call local `list_capabilities` and retain its public IDs, limits, targets, guards, and `demoParams`.
3. Call remote `list_actions` and `describe_action` for the configured action ID.
4. Call remote `build_action` with the local signer address, public `agentWallet` binding, BalanceManager,
   TradeCap, and `demoParams`.
5. Verify the envelope identities, resolved params, target/object manifests, expiry, and verified simulation.
6. Pass the full envelope unchanged to local `execute_rill_action`.
7. On rejection, call `explain_rejection`; never weaken policy or retry with raw PTB bytes.

The local MCP server exposes no arbitrary transaction or raw PTB tool.
