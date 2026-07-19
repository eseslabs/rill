import { config } from '../../core/config';
import type { PublishedSkill } from './skills.store';
import { buildToolDefs, heroActionOf } from './tool-schema';

type ParamProperty = { type: string; description?: string };
type ParamsSchema = { properties?: Record<string, ParamProperty>; required?: string[] };

/** Reads the flow-aware runtime-params schema `build_action` actually advertises for this skill
 *  (`tool-schema.ts`'s `buildRuntimeParamsSchema`, nested under `inputSchema.properties.params`) —
 *  never a hardcoded DeepBook shape, so a Cetus swap skill documents `amount_in`/`min_amount_out`
 *  and a Haedal stake skill documents `amount`, not DeepBook's `poolKey`/`price`/`quantity`. */
function paramsSchemaOf(skill: PublishedSkill): ParamsSchema {
  const schema = skill.toolDefs.inputSchema as { properties: { params: ParamsSchema } };
  return schema.properties.params;
}

function renderParamRows(params: ParamsSchema): string {
  const props = params.properties ?? {};
  const required = params.required ?? [];
  if (required.length === 0) return '_(no required action parameters)_';
  return required
    .map((name) => `- \`${name}\` (${props[name]?.type ?? 'string'}) — ${props[name]?.description ?? ''}`)
    .join('\n');
}

/** Example `params` object for the REST curl snippet — a placeholder per required field, numeric
 *  fields default to `0` (mirrors the old skill-doc's example-value convention). */
function exampleParamsOf(params: ParamsSchema): Record<string, unknown> {
  const props = params.properties ?? {};
  const required = params.required ?? [];
  return Object.fromEntries(required.map((name) => [name, props[name]?.type === 'number' ? 0 : '…']));
}

/**
 * Renders a self-contained SKILL.md for a published flow. Paste its URL into ANY MCP-capable agent
 * (Claude Code, OpenCode, Cursor, OpenClaw, Hermes, …) — it teaches the agent to build the PTB
 * (keyless) via MCP or REST and sign it locally with its own key, bounded by an on-chain agent_wallet.
 *
 * Every per-skill string here is FLOW-AWARE (`heroActionOf`/`paramsSchemaOf`, both derived from
 * `skill.flow`) — a published Cetus swap is described as a swap throughout, never as "DeepBook
 * order"; same for Haedal stake. This restores the educational sections (Parameters, Run it,
 * Signing, Safety) the pre-keyless-refactor SKILL.md had, made flow-aware, ON TOP of the current
 * operational content (the numbered MCP tool sequence + local run-set onboarding) — nothing below
 * is invented: every named tool is a real entry in `mcp.service.ts`'s `actionTools`,
 * `skill.toolDefs`, or `packages/rill-signer/src/mcp.ts`'s `walletTools`.
 */
export function buildSkillDoc(skill: PublishedSkill): string {
  const mcpUrl = `${config.publicBaseUrl}/api/mcp/${skill.id}`;
  const restUrl = `${config.publicBaseUrl}/api/execute`;
  const hero = heroActionOf(skill.flow);
  const params = paramsSchemaOf(skill);
  const pkg = config.agentWallet?.packageId ?? '<your AGENT_WALLET_PACKAGE_ID>';

  const exampleBody = {
    skillId: skill.id,
    sender: '<your-sui-address>',
    agentWallet: {
      packageId: '<agentWallet.packageId>',
      walletId: '<agentWallet.walletId>',
      capId: '<agentWallet.capId>',
      versionId: '<agentWallet.versionId>',
      capabilityManifest: '<CapabilityManifest — see Safety below>',
    },
    params: exampleParamsOf(params),
  };

  return [
    '---',
    'name: rill-actions',
    `description: Keyless Rill action discovery and ExecutionEnvelope building for ${skill.name}.`,
    '---',
    '',
    '# Rill Actions',
    '',
    `${hero.name} (\`${skill.id}\`). ${skill.description}`,
    '',
    `Network: **${config.network}**`,
    '',
    'Rill Cloud never signs. Connect this Streamable HTTP endpoint as `rill-actions`:',
    '',
    '```bash',
    `export RILL_REMOTE_MCP_URL="${mcpUrl}"`,
    'claude mcp add --transport http rill-actions "$RILL_REMOTE_MCP_URL"',
    '```',
    '',
    'Set the signer key only in the shell or secret manager that launches Claude. Never put it in MCP config,',
    'commands, transcripts, or the repository.',
    '',
    '```bash',
    `export SUI_NETWORK="${config.network}"`,
    'export RILL_WALLET_MCP_ENTRY="<absolute path to this repo>/packages/rill-signer/src/mcp.ts"',
    'export RILL_SIGNER_POLICY_PATH="<absolute path to this repo>/.rill/demo/sets/live.json"',
    '',
    'claude mcp add --env "SUI_NETWORK=$SUI_NETWORK" --env "RILL_SIGNER_POLICY_PATH=$RILL_SIGNER_POLICY_PATH" --transport stdio rill-wallet -- bun run "$RILL_WALLET_MCP_ENTRY"',
    '```',
    '',
    'Launch Claude from the shell where `RILL_SUI_PRIVATE_KEY` is already set so the local server inherits it',
    'without storing its value in MCP configuration. (If you skip this, the local signer generates and',
    'persists its own keypair on first use instead — see **Signing** below.)',
    '',
    'Ready-to-paste agent instructions (tool sequence, active guardrails, example prompt):',
    `${config.publicBaseUrl}/api/skills/${skill.id}/instructions.md`,
    '',
    '## Parameters',
    '',
    renderParamRows(params),
    '',
    'Plus `sender` (your Sui signer address) and `agentWallet` (the on-chain AgentWallet binding —',
    'see **Safety** below) on every build call.',
    '',
    '## Run it',
    '',
    `Build one ${hero.name} — pick one:`,
    '',
    '### MCP (Claude Code, OpenCode, Thiny, …)',
    '',
    `Call \`build_action\` on \`rill-actions\` (connected above) with the parameters listed under`,
    '**Parameters** plus `sender` and `agentWallet` — see the numbered tool sequence below for the',
    'full order. It returns `unsignedPtb` (base64) plus a strict-simulation preview; sign + submit it',
    'locally (see **Signing**). Non-Claude MCP clients: point them at the same',
    `\`${mcpUrl}\` Streamable HTTP endpoint.`,
    '',
    '### REST (any agent / script)',
    '',
    '```bash',
    `curl -X POST ${restUrl} \\`,
    "  -H 'content-type: application/json' \\",
    `  -d '${JSON.stringify(exampleBody)}'`,
    '```',
    'Returns `{ unsignedPtb, preview, simulation, allowedTargets, requiredObjectIds, requiredGuards,',
    'actionDigest, expiresAt }` (or `{ refused: true, reason, simulation }` when strict simulation',
    'fails) — never a signature.',
    '',
    'Use tools in this order:',
    '',
    '1. Remote `list_actions`.',
    `2. Remote \`describe_action\` for action ID \`${skill.id}\`.`,
    '3. Local `signer_status` and `list_run_sets` from `@rill/signer`.',
    '4. If no run-set exists and auto-create is enabled, ask the user for permission, then call local `create_run_set`.',
    '5. If the signer balance is low, call local `request_faucet`; if that fails, ask the user to fund the address.',
    '6. Remote `build_action` with the run-set IDs and `demoParams`.',
    '7. Verify resolved params, preview, targets, required objects, and strict simulation.',
    '8. Local `execute_rill_action` with the returned ExecutionEnvelope.',
    `9. Query digest, the ${hero.name} outcome, wallet Spent event, and remaining budget.`,
    '',
    '## Onboarding',
    '',
    'If no run-set exists yet:',
    '',
    '1. Check `signer_status` and `list_run_sets`.',
    '2. If no run-set is present and auto-create is enabled, ask the user for permission, then call `create_run_set`.',
    '3. If the signer balance is low, call `request_faucet`; if that fails, ask the user to fund the address.',
    '4. With the run-set IDs, call `build_action` and then `execute_rill_action`.',
    '',
    '## Signing (you hold the key, not Rill)',
    '',
    'MCP-capable agents: call local `execute_rill_action` (step 8 above) — it validates the envelope',
    'against your local policy, re-simulates, signs, and submits. That local tool is the ONLY path',
    'that should ever produce a signature; never hand `unsignedPtb` to a generic/raw signing tool.',
    '',
    'Scripted or non-MCP callers can drive the same signer core directly:',
    '',
    '```ts',
    '// packages/rill-signer/src/core.ts + src/policy.ts, in this repo — the same functions',
    "// packages/rill-signer/src/mcp.ts's own execute_rill_action handler calls.",
    "import { loadConfigFromEnv, createSigner, executeEnvelope } from './core';",
    "import { loadPolicy } from './policy';",
    '',
    '// Reads RILL_SUI_PRIVATE_KEY / SUI_PRIVATE_KEY if set; otherwise auto-generates and persists a',
    '// local keypair under .rill/keys/ on first use.',
    'const cfg = loadConfigFromEnv();',
    'const signer = createSigner(cfg);',
    '// The run-set / local policy this key is bounded to (RILL_SIGNER_POLICY_PATH).',
    'const policy = loadPolicy();',
    '',
    '// `envelope` is exactly what build_action / POST /api/execute returned above.',
    'const result = await executeEnvelope(envelope, signer, cfg, policy);',
    '// result.digest -> on-chain. Aborts BEFORE signing if the envelope, policy, or a fresh',
    '// re-simulation disagree with each other.',
    '```',
    '',
    '## Safety — agent_wallet caps the blast radius',
    '',
    `Fund an on-chain agent_wallet (package \`${pkg}\`) with a CapabilityManifest — budget, per-tx`,
    'max, rate limit, expiry, and more. Every spend goes through `request_spend` → `prove` →',
    '`confirm_spend`, which aborts outside those bounds; the wallet can also be revoked at any time.',
    'Worst case is bounded by that wallet, not your whole balance. Bind it via',
    '`agentWallet: { packageId, walletId, capId, versionId, capabilityManifest }` on `build_action` /',
    '`POST /api/execute` (or your MCP server config).',
    '',
    'Never request hosted execution and never pass raw PTB bytes to a generic signing tool.',
    '',
  ].join('\n');
}

if (import.meta.main) {
  const doc = buildSkillDoc({
    id: 'skill_demo',
    name: 'rill_skill_demo',
    description: 'Swap then stake.',
    flow: { nodes: [{ id: 'order', type: 'deepbook_limit_order' }], edges: [] },
    toolDefs: buildToolDefs({
      nodes: [{ id: 'order', type: 'deepbook_limit_order' }],
      edges: [],
    }, 'skill_demo'),
    createdAt: new Date().toISOString(),
  });
  if (!doc.includes('list_actions')) throw new Error('skill-doc: list_actions missing');
  if (!doc.includes('execute_rill_action')) throw new Error('skill-doc: local execution handoff missing');
  if (!doc.includes('RILL_REMOTE_MCP_URL')) throw new Error('skill-doc: remote URL environment variable missing');
  if (!doc.includes('RILL_SIGNER_POLICY_PATH')) throw new Error('skill-doc: local policy path missing');
  if (!doc.includes('## Parameters')) throw new Error('skill-doc: Parameters section missing');
  if (!doc.includes('## Signing')) throw new Error('skill-doc: Signing section missing');
  if (!doc.includes('## Safety')) throw new Error('skill-doc: Safety section missing');
  console.log('skill-doc self-check ok');
}
