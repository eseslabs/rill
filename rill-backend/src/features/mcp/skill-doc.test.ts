import { expect, test } from 'bun:test';
import { buildSkillDoc } from './skill-doc';
import type { PublishedSkill } from './skills.store';
import { buildToolDefs } from './tool-schema';

test('documents the bounded remote and local MCP handoff', () => {
  const skill = {
    id: 'skill_doc',
    name: 'rill_skill_doc',
    description: 'Build one action.',
    flow: { nodes: [{ id: 'order', type: 'deepbook_limit_order' }], edges: [] },
    toolDefs: buildToolDefs({
      nodes: [{ id: 'order', type: 'deepbook_limit_order' }],
      edges: [],
    }, 'skill_doc'),
    createdAt: '2026-07-16T00:00:00.000Z',
  } satisfies PublishedSkill;
  const doc = buildSkillDoc(skill);

  expect(doc).toContain('name: rill-actions');
  expect(doc).toContain('export RILL_REMOTE_MCP_URL=');
  expect(doc).toContain('claude mcp add --transport http rill-actions "$RILL_REMOTE_MCP_URL"');
  expect(doc).toContain('Remote `list_actions`');
  expect(doc).toContain('Local `signer_status` and `list_run_sets`');
  expect(doc).toContain('local `create_run_set`');
  expect(doc).toContain('local `request_faucet`');
  expect(doc).toContain('Local `execute_rill_action`');
  expect(doc).toContain('export RILL_WALLET_MCP_ENTRY=');
  expect(doc).toContain('export RILL_SIGNER_POLICY_PATH=');
  expect(doc).not.toContain('export RILL_SIGNER_POLICY_PATH="$PWD/');
  expect(doc).toContain('--transport stdio rill-wallet -- bun run "$RILL_WALLET_MCP_ENTRY"');
  expect(doc).toContain('--env "SUI_NETWORK=$SUI_NETWORK"');
  expect(doc).toContain('--env "RILL_SIGNER_POLICY_PATH=$RILL_SIGNER_POLICY_PATH"');
  expect(doc).toContain('Launch Claude from the shell where `RILL_SUI_PRIVATE_KEY` is already set');
  expect(doc).not.toContain('--env "RILL_SUI_PRIVATE_KEY=');
  expect(doc).not.toContain('sui_execute_ptb');
  expect(doc).toContain('## Onboarding');
  expect(doc).toContain('Check `signer_status` and `list_run_sets`');
  expect(doc).toContain('call `create_run_set`');
  expect(doc).toContain('call `request_faucet`');
  expect(doc).toContain('call `build_action` and then `execute_rill_action`');
});
