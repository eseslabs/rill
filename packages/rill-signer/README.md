# @rill/signer

`@rill/signer` is the local half of Rill's bounded action flow. Rill Cloud builds an unsigned
`ExecutionEnvelope`; the local `rill-wallet` MCP server validates the exact envelope and PTB against a
run-specific policy, checks live capabilities, re-simulates, and only then signs and submits.

The MCP server exposes exactly:

- `wallet_status`
- `list_capabilities`
- `execute_rill_action`
- `explain_rejection`

It does not expose a raw or arbitrary PTB execution tool.

## Environment

Set the signer key in the shell or secret manager that launches the MCP client. Never put it in MCP JSON,
command arguments, transcripts, or this repository.

```bash
export SUI_NETWORK=testnet
export RILL_SIGNER_POLICY_PATH="$PWD/.rill/demo/sets/live.json"
# Set RILL_SUI_PRIVATE_KEY in this launching shell from your secure secret source.
```

Optional local settings are `SUI_RPC_URL`, `RILL_MAX_GAS_MIST`, and the explicit mainnet gate
`RILL_ALLOW_MAINNET=true`.

## Secret-Free MCP Config

```json
{
  "mcpServers": {
    "rill-wallet": {
      "command": "bun",
      "args": ["run", "/abs/path/to/packages/rill-signer/src/mcp.ts"],
      "env": {
        "SUI_NETWORK": "testnet",
        "RILL_SIGNER_POLICY_PATH": "/abs/path/to/.rill/demo/sets/live.json"
      }
    }
  }
}
```

Launch the MCP client from the shell where the signer key is already available to child processes.

## Bounded Flow

1. Call local `wallet_status` and continue only when `strategyEligible` is true.
2. Call local `list_capabilities` for public wallet IDs, limits, targets, and `demoParams`.
3. Call remote `rill-actions.describe_action`, then `rill-actions.build_action` with those public IDs.
4. Inspect the returned `ExecutionEnvelope` and verified simulation.
5. Pass the complete envelope to local `execute_rill_action`.
6. If rejected, call `explain_rejection`; policy is never weakened automatically.

The CLI raw PTB path is development-only and requires the explicit `--unsafe-ptb` flag. It is not part of
the bounded MCP or Demo Day flow.

## Live Test

The live harness requires a published action, real public objects, local policy, and a funded local signer:

```bash
export RILL_BACKEND=http://localhost:3002
export RILL_ACTION_ID=skill_...
export RILL_SIGNER_POLICY_PATH="$PWD/.rill/demo/sets/live.json"
# Set RILL_SUI_PRIVATE_KEY in this launching shell from your secure secret source.
bun run packages/rill-signer/scripts/mcp-live-test.ts
```

It builds a fresh remote envelope, executes it through local policy, then proves a mutated digest is rejected
and reported by `explain_rejection`.
