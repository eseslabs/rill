import { config } from '../../core/config';
import type { PublishedSkill } from './skills.store';
import { buildToolDefs } from './tool-schema';

export function buildSkillDoc(skill: PublishedSkill): string {
  const mcpUrl = `${config.publicBaseUrl}/api/mcp/${skill.id}`;
  return [
    '---',
    'name: rill-actions',
    `description: Keyless Rill action discovery and ExecutionEnvelope building for ${skill.name}.`,
    '---',
    '',
    '# Rill Actions',
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
    'without storing its value in MCP configuration.',
    '',
    'Ready-to-paste agent instructions (tool sequence, active guardrails, example prompt):',
    `${config.publicBaseUrl}/api/skills/${skill.id}/instructions.md`,
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
  '9. Query digest, DeepBook order, wallet Spent event, and remaining budget.',
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
  console.log('skill-doc self-check ok');
}
