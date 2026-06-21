---
name: rill-signer
description: Sign and submit the unsigned Sui transactions (PTBs) that Rill builds, using a local Sui key bounded by an on-chain agent_wallet. Use whenever a Rill tool returns an `unsignedPtb` that needs to go on-chain.
---

# rill-signer skill

Rill builds Sui transactions **keyless** — it returns an `unsignedPtb` (base64) but never holds your key.
This skill signs + submits that PTB locally. Hard caps (budget, per-tx, expiry, revoke) are enforced
on-chain by the `agent_wallet` baked into the PTB, so worst case is bounded by that wallet — not your whole balance.

## Setup (once)
Set your Sui key in the environment before running anything:
```bash
export RILL_SUI_PRIVATE_KEY="suiprivkey1…"   # from: sui keytool export
export SUI_NETWORK="testnet"                  # testnet (default) | mainnet
# mainnet also needs: export RILL_ALLOW_MAINNET=true
```

## Use it
The CLI is `rill-sign` (run via `bun /path/to/rill-signer/src/cli.ts`).

1. **Get your address** — pass this as `sender` when you call Rill's build tool/REST:
   ```bash
   rill-sign address
   # → {"address":"0x…","network":"testnet"}
   ```

2. **Build** (Rill, keyless) — get the `unsignedPtb` for that `sender` (MCP tool or REST `/api/execute`).

3. **Sign + submit** the PTB it returned:
   ```bash
   rill-sign "<unsignedPtb-base64>"
   # or:  echo "<unsignedPtb-base64>" | rill-sign
   # → {"digest":"…","status":"success","explorerUrl":"https://suiscan.xyz/testnet/tx/…"}
   ```
   It re-simulates before signing and aborts if the dry-run fails. Report the `digest`/`explorerUrl` to the user.

## Notes
- No key set → it errors instead of signing. Never paste a private key into chat; use the env var.
- Optional soft gas ceiling: `export RILL_MAX_GAS_MIST=50000000`.
- MCP-capable agents can use the MCP server instead (`src/mcp.ts`, tool `sui_execute_ptb`) — same core.
