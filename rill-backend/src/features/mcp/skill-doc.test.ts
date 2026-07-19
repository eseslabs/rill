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

  // Educational sections restored on top of the operational ones (coordinator addendum).
  expect(doc).toContain('## Parameters');
  expect(doc).toContain('## Run it');
  expect(doc).toContain('## Signing');
  expect(doc).toContain('## Safety');
  expect(doc).toContain('9. Query digest, the DeepBook limit order outcome, wallet Spent event, and remaining budget.');
});

test('a Cetus swap skill is described as a swap throughout — never "DeepBook order"', () => {
  const skill = {
    id: 'skill_swap_doc',
    name: 'Cetus swap',
    description: 'Build one wallet-bound Cetus swap for strict local execution.',
    flow: { nodes: [{ id: 'swap', type: 'cetus_swap' }], edges: [] },
    toolDefs: buildToolDefs({ nodes: [{ id: 'swap', type: 'cetus_swap' }], edges: [] }, 'skill_swap_doc'),
    createdAt: '2026-07-18T00:00:00.000Z',
  } satisfies PublishedSkill;
  const doc = buildSkillDoc(skill);

  expect(doc).not.toContain('DeepBook');
  expect(doc).toContain('- `amount_in`');
  expect(doc).toContain('- `min_amount_out`');
  expect(doc).not.toContain('- `poolKey`');
  expect(doc).not.toContain('- `balanceManagerId`');
  expect(doc).toContain('9. Query digest, the Cetus swap outcome, wallet Spent event, and remaining budget.');
  expect(doc).toContain('Build one Cetus swap — pick one:');
});

test('a Haedal stake skill is described as a stake throughout — never "DeepBook order"', () => {
  const skill = {
    id: 'skill_stake_doc',
    name: 'Haedal stake',
    description: 'Build one wallet-bound Haedal stake for strict local execution.',
    flow: { nodes: [{ id: 'stake', type: 'haedal_stake' }], edges: [] },
    toolDefs: buildToolDefs({ nodes: [{ id: 'stake', type: 'haedal_stake' }], edges: [] }, 'skill_stake_doc'),
    createdAt: '2026-07-18T00:00:00.000Z',
  } satisfies PublishedSkill;
  const doc = buildSkillDoc(skill);

  expect(doc).not.toContain('DeepBook');
  expect(doc).toContain('- `amount`');
  expect(doc).not.toContain('- `poolKey`');
  expect(doc).toContain('9. Query digest, the Haedal stake outcome, wallet Spent event, and remaining budget.');
  expect(doc).toContain('Build one Haedal stake — pick one:');
});

test('a chained Cetus-swap -> Haedal-stake flow ("swap then stake") renders correctly', () => {
  const skill = {
    id: 'skill_combo_doc',
    name: 'Cetus swap → Haedal stake',
    description: 'Build one wallet-bound Cetus swap chained into a Haedal stake for strict local execution.',
    flow: {
      nodes: [
        { id: 'swap', type: 'cetus_swap' },
        { id: 'stake', type: 'haedal_stake' },
      ],
      edges: [{ source: 'swap', sourceHandle: 'coin_out', target: 'stake', targetHandle: 'sui_coin' }],
    },
    toolDefs: buildToolDefs({
      nodes: [{ id: 'swap', type: 'cetus_swap' }, { id: 'stake', type: 'haedal_stake' }],
      edges: [],
    }, 'skill_combo_doc'),
    createdAt: '2026-07-18T00:00:00.000Z',
  } satisfies PublishedSkill;
  const doc = buildSkillDoc(skill);

  expect(doc).toContain('Cetus swap → Haedal stake');
  expect(doc).toContain('## Parameters');
  expect(doc).toContain('## Signing');
});
