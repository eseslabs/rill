import { config } from '../../core/config';
import type { PublishedSkill } from './skills.store';

/**
 * Renders a self-contained SKILL.md for a published flow. Paste its URL into ANY AI agent
 * (Claude Code, OpenCode, Cursor, OpenClaw, Hermes, …) — it teaches the agent to build the PTB
 * (keyless) via MCP or REST and sign it locally with its own key, bounded by an on-chain agent_wallet.
 */
export function buildSkillDoc(skill: PublishedSkill): string {
  const base = config.publicBaseUrl;
  const mcpUrl = `${base}/api/mcp/${skill.id}`;
  const restUrl = `${base}/api/execute`;
  const toolName = skill.toolDefs.name;
  const schema = skill.toolDefs.inputSchema as {
    properties?: Record<string, { type: string; description: string }>;
    required?: string[];
  };
  const props = schema.properties ?? {};
  const required = schema.required ?? [];

  const paramRows = required.length
    ? required
        .map((name) => `- \`${name}\` (${props[name]?.type ?? 'string'}) — ${props[name]?.description ?? ''}`)
        .join('\n')
    : '_(none — this flow takes no caller parameters)_';

  const exampleParams = Object.fromEntries(required.map((name) => [name, props[name]?.type === 'number' ? 0 : '…']));
  const pkg = config.agentWallet?.packageId ?? '<your AGENT_WALLET_PACKAGE_ID>';

  return `---
name: ${toolName}
description: ${skill.description}
---

# ${toolName}

${skill.description}

Network: **${config.network}**. Rill builds the transaction **keyless** — it never holds your key.
You sign locally with your own Sui key, bounded by an on-chain **agent_wallet** (capped + revocable).

## Parameters
${paramRows}

Plus \`sender\` — your Sui address. The PTB is built for this address (tx sender + output recipient) so you can sign it.

## Run it — pick one

### Option A · MCP (Streamable HTTP) — connect your agent to this server
MCP endpoint (paste into your agent, then call tool \`${toolName}\`):

\`\`\`
${mcpUrl}
\`\`\`

**Claude Code**
\`\`\`bash
claude mcp add --transport http rill ${mcpUrl}
\`\`\`

**OpenCode** — add to \`opencode.json\`:
\`\`\`json
{
  "mcp": {
    "rill": { "type": "remote", "url": "${mcpUrl}", "enabled": true }
  }
}
\`\`\`

**Thiny** — \`@thiny/mcp\`:
\`\`\`ts
import { mcpHttpPlugin } from '@thiny/mcp';
const rill = await mcpHttpPlugin({ url: '${mcpUrl}', name: 'rill' });
// add \`rill\` (+ suiPlugin for signing) to createAgent({ plugins: [...] })
\`\`\`

Then call \`${toolName}\` with the parameters above plus \`sender\`. It returns \`unsignedPtb\` (base64) + a simulation preview — sign + submit it locally (see **Signing**).

### Option B · REST (any agent / script)
\`\`\`bash
curl -X POST ${restUrl} \\
  -H 'content-type: application/json' \\
  -d '${JSON.stringify({ skillId: skill.id, sender: '<your-sui-address>', params: exampleParams })}'
\`\`\`
Returns \`{ unsignedPtb, simulation, preview, warnings }\`.

## Signing (you hold the key, not Rill)
\`\`\`ts
import { Transaction } from '@mysten/sui/transactions';
// \`unsignedPtb\` is base64 of the serialized PTB built for your \`sender\`:
const tx = Transaction.from(Buffer.from(unsignedPtb, 'base64').toString('utf8'));
const res = await suiClient.signAndExecuteTransaction({ signer: yourKeypair, transaction: tx });
// res.digest → on-chain. Re-simulate before signing if you want a second check.
\`\`\`
Thiny agents: use \`@thiny/plugin-sui\` → \`sui_execute_ptb\` (pass \`unsignedPtb\`).

## Safety — agent_wallet caps the blast radius
Fund an on-chain agent_wallet (package \`${pkg}\`) with a budget, per-tx max, and expiry. Every spend goes
through \`spend()\`, which aborts over-cap / expired / revoked. Worst case is bounded by that wallet — not your whole balance.
Bind it by adding \`agentWallet: { packageId, walletId, capId }\` to the REST body (or via your MCP server config).
`;
}

// ponytail: templating — one self-check that required params actually render.
if (import.meta.main) {
  const doc = buildSkillDoc({
    id: 'skill_demo',
    name: 'rill_skill_demo',
    description: 'Swap then stake.',
    flow: { nodes: [], edges: [] },
    toolDefs: {
      name: 'rill_skill_demo',
      description: 'Swap then stake.',
      inputSchema: {
        type: 'object',
        properties: { amount_in: { type: 'number', description: 'Amount in (mist)' } },
        required: ['amount_in'],
      },
    },
    createdAt: new Date().toISOString(),
  });
  if (!doc.includes('`amount_in`')) throw new Error('skill-doc: required param not rendered');
  if (!doc.includes('/api/mcp/skill_demo')) throw new Error('skill-doc: mcp url missing');
  if (!doc.includes('claude mcp add --transport http')) throw new Error('skill-doc: Claude Code setup missing');
  if (!doc.includes('"type": "remote"')) throw new Error('skill-doc: OpenCode setup missing');
  if (!doc.includes('mcpHttpPlugin')) throw new Error('skill-doc: Thiny setup missing');
  console.log('skill-doc self-check ok');
}
