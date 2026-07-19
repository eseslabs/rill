import { expect, test } from 'bun:test';
import type { CapabilityManifest } from '../../../../packages/rill-sdk/src/capability-manifest';
import { toDeclaration } from '../../../../packages/rill-sdk/src/capability-manifest';
import { apiRouter } from '../../http/routes/api.routes';
import { NO_MANIFEST_DECLARATION, renderAgentInstructions } from './agent-instructions';
import { skillsStore, type PublishedSkill } from './skills.store';
import { buildToolDefs } from './tool-schema';

const skill = {
  id: 'skill_instructions_demo',
  name: 'DeepBook limit order',
  description: 'Place one bounded DeepBook limit order.',
  flow: { nodes: [{ id: 'order', type: 'deepbook_limit_order' }], edges: [] },
  toolDefs: buildToolDefs({
    nodes: [{ id: 'order', type: 'deepbook_limit_order' }],
    edges: [],
  }, 'skill_instructions_demo'),
  createdAt: '2026-07-18T00:00:00.000Z',
} satisfies PublishedSkill;

const manifest: CapabilityManifest = {
  walletCoinType: '0x2::sui::SUI',
  rules: [
    { kind: 'budget', totalMist: '5000000000' },
    { kind: 'rate_limit', windowMs: '3600000', maxMist: '1000000000' },
    { kind: 'slippage_floor', minOutMist: '990000000' },
  ],
};

/** Reused across every scenario: an instructions document must never carry private key material,
 *  regardless of whether a manifest is present (mirrors the keyless-denylist idea applied to
 *  `assertKeylessToolArguments` in `mcp.service.ts` / the private-key assertions in
 *  `skill-doc.test.ts`, generalized to a reusable denylist here). */
const PRIVATE_KEY_DENYLIST = [
  'RILL_SUI_PRIVATE_KEY=',
  '--env "RILL_SUI_PRIVATE_KEY',
  'suiprivkey1',
  'privateKey:',
  'secretKey:',
  'mnemonic:',
];

function assertNoPrivateKeyMaterial(doc: string): void {
  for (const term of PRIVATE_KEY_DENYLIST) {
    expect(doc).not.toContain(term);
  }
}

test('renders both mcp-add commands and the 4-step tool order', () => {
  const doc = renderAgentInstructions(skill);

  // Both `claude mcp add` commands, env-safe form (public network + policy-path only).
  expect(doc).toContain('claude mcp add --transport http rill-actions "$RILL_REMOTE_MCP_URL"');
  // rill-wallet is a hosted standalone binary — no repo clone, no bun/node install.
  expect(doc).toContain('releases/latest/download/rill-wallet-darwin-arm64');
  expect(doc).toContain('--transport stdio rill-wallet -- "$PWD/rill-wallet"');
  expect(doc).toContain('export RILL_REMOTE_MCP_URL=');

  // The correct 4-step tool sequence, in order.
  const listIdx = doc.indexOf('`list_actions`');
  const describeIdx = doc.indexOf('`describe_action`');
  const buildIdx = doc.indexOf('`build_action`');
  const executeIdx = doc.indexOf('`execute_rill_action`');
  expect(listIdx).toBeGreaterThan(-1);
  expect(describeIdx).toBeGreaterThan(listIdx);
  expect(buildIdx).toBeGreaterThan(describeIdx);
  expect(executeIdx).toBeGreaterThan(buildIdx);

  assertNoPrivateKeyMaterial(doc);
});

test('documents one-time local signer setup: auto-generated keypair, address, and funding — honest against the current signer', () => {
  const doc = renderAgentInstructions(skill);

  // Auto-keypair behavior, verified against packages/rill-signer/src/keystore.ts /core.ts — not
  // the old SKILL.md's manual-env-var-only story.
  expect(doc).toContain('.rill/keys/agent-<network>.key');
  expect(doc).toContain('no manual key setup is required to get started');
  expect(doc).toContain('`signer_status`');
  expect(doc).toContain('`request_faucet`');

  // Ordered before the tool sequence section, and before every tool-sequence-section occurrence.
  const setupIdx = doc.indexOf('## 2. Local signer setup');
  const sequenceIdx = doc.indexOf('## 3. Tool sequence');
  expect(setupIdx).toBeGreaterThan(-1);
  expect(sequenceIdx).toBeGreaterThan(setupIdx);

  assertNoPrivateKeyMaterial(doc);
});

test('with a manifest (budget + rate_limit + slippage_floor) it declares all three caps honestly', () => {
  const doc = renderAgentInstructions(skill, manifest);
  const declaration = toDeclaration(manifest);

  expect(declaration.caps).toHaveLength(3);
  for (const line of declaration.summaryLines) {
    expect(doc).toContain(line);
  }
  for (const cap of declaration.caps) {
    expect(doc).toContain(`| ${cap.label} | ${cap.value} |`);
  }
  expect(doc).toContain('Budget');
  expect(doc).toContain('Rate limit');
  expect(doc).toContain('Min swap output');
  expect(doc).not.toContain(NO_MANIFEST_DECLARATION);

  assertNoPrivateKeyMaterial(doc);
});

test('with no manifest it renders the honest no-wallet-budget state', () => {
  const doc = renderAgentInstructions(skill);

  expect(doc).toContain(NO_MANIFEST_DECLARATION);
  expect(doc).toContain(
    'This skill runs without an agent-wallet budget binding — no on-chain spend limit is enforced yet.',
  );
  expect(doc).not.toContain('| Budget |');

  assertNoPrivateKeyMaterial(doc);
});

test('instructions never leak private key material (denylist)', () => {
  assertNoPrivateKeyMaterial(renderAgentInstructions(skill));
  assertNoPrivateKeyMaterial(renderAgentInstructions(skill, manifest));
});

test('GET /api/skills/:id/instructions.md returns the same content as the direct render', async () => {
  const get = skillsStore.get;
  skillsStore.get = (id) => (id === skill.id ? skill : undefined);
  try {
    const response = await apiRouter.request(`/skills/${skill.id}/instructions.md`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    const body = await response.text();
    expect(body).toBe(renderAgentInstructions(skill));
  } finally {
    skillsStore.get = get;
  }
});

test('GET /api/skills/:id/instructions.md 404s for an unknown skill', async () => {
  const get = skillsStore.get;
  skillsStore.get = () => undefined;
  try {
    const response = await apiRouter.request('/skills/skill_missing/instructions.md');
    expect(response.status).toBe(404);
  } finally {
    skillsStore.get = get;
  }
});
