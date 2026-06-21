# @rill/signer

The local signer for Rill. Rill builds Sui transactions **keyless** (it returns an `unsignedPtb` and
never holds a key); this package holds the agent's key and **signs + submits** those PTBs. Hard caps
(budget, per-tx, expiry, revoke) are enforced on-chain by the `agent_wallet` baked into the PTB — so the
worst case is bounded by that wallet, not the whole balance.

One core (`src/core.ts`), three ways to use it:

| Surface | For | Entry |
|---|---|---|
| **MCP server** (stdio) | Claude Code, OpenCode, Cursor, any MCP client | `src/mcp.ts` — tools `sui_address`, `sui_balance`, `sui_execute_ptb` |
| **CLI** (`rill-sign`) | shell agents, scripts | `src/cli.ts` |
| **Skill** (`SKILL.md`) | OpenClaw, Hermes, skill-based agents | wraps the CLI |

## Config (env)
```bash
export RILL_SUI_PRIVATE_KEY="suiprivkey1…"   # sui keytool export
export SUI_NETWORK="testnet"                  # testnet (default) | mainnet
# mainnet guard — must opt in:
export RILL_ALLOW_MAINNET=true
# optional soft gas ceiling (MIST):
export RILL_MAX_GAS_MIST=50000000
# optional custom RPC:
export SUI_RPC_URL="https://fullnode.testnet.sui.io:443"
```

## MCP — Claude Code / Cursor / OpenCode
Add to the client's MCP config (Claude Code: `claude mcp add`):
```json
{
  "mcpServers": {
    "rill-signer": {
      "command": "bun",
      "args": ["run", "/abs/path/to/packages/rill-signer/src/mcp.ts"],
      "env": { "RILL_SUI_PRIVATE_KEY": "suiprivkey1…", "SUI_NETWORK": "testnet" }
    }
  }
}
```
Flow: `sui_address` → use as `sender` for Rill's build tool → `sui_execute_ptb` with the returned `unsignedPtb`.

## CLI
```bash
rill-sign address                 # → {"address":"0x…","network":"testnet"}
rill-sign "<unsignedPtb-base64>"  # → {"digest":"…","status":"success","explorerUrl":"…"}
echo "<unsignedPtb>" | rill-sign  # same, from stdin
```

## Safety
- No key configured → it errors instead of signing.
- Re-simulates before signing; aborts if the dry-run fails (`RILL_REQUIRE_SIM_SUCCESS=false` to override).
- Mainnet refused unless `RILL_ALLOW_MAINNET=true`.
