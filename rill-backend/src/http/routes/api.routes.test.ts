import { afterAll, expect, mock, test } from 'bun:test';
import { apiRouter } from './api.routes';
import { skillsStore, type PublishedSkill } from '../../features/mcp/skills.store';
import { buildToolDefs } from '../../features/mcp/tool-schema';
import * as realSetupService from '../../features/setup/setup.service';

// Snapshot the real module before installing the mock. Bun's `mock.module` is
// process-global and, depending on the filesystem-driven order in which bun
// discovers test files (it leaks on the Linux CI runner but not on macOS), it
// bleeds these stubs into setup.service.test.ts — which then saw
// `buildSetupTransaction` return an empty PTB and `createdId` return '0x0'.
// The afterAll below restores the real module so no other file inherits the mock.
const realSetupModule = { ...realSetupService };

mock.module('../../features/setup/setup.service', () => ({
  prepareSetupPlan: async () => ({
    setupPtb: 'setup_base64',
    tradeCapPtb: 'tradecap_base64',
    runSetTemplate: { version: '1' },
    walletPackageId: '0x1',
    deepbookPackageId: '0x2',
  }),
  buildSetupTransaction: () => ({ getData: () => ({ commands: [] }) } as never),
  buildMintTradeCapTransaction: () => ({ getData: () => ({ commands: [] }) } as never),
  createdId: () => '0x0',
}));

const skill = {
  id: 'skill_setup_test',
  name: 'DeepBook limit order',
  description: 'Place one bounded DeepBook limit order.',
  flow: { nodes: [{ id: 'order', type: 'deepbook_limit_order' }], edges: [] },
  toolDefs: buildToolDefs({
    nodes: [{ id: 'order', type: 'deepbook_limit_order' }],
    edges: [],
  }, 'skill_setup_test'),
  createdAt: '2026-07-16T00:00:00.000Z',
} satisfies PublishedSkill;

test('POST /setup/prepare validates input and returns a setup plan', async () => {
  const originalSave = skillsStore.save.bind(skillsStore);
  skillsStore.save = (s) => { (skillsStore as unknown as { skills: Map<string, PublishedSkill> }).skills.set(s.id, s); };
  originalSave(skill);
  skillsStore.save = originalSave;

  const response = await apiRouter.request('/setup/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      skillId: skill.id,
      sender: '0x'.padEnd(66, '0'),
      budgetMist: '1000000000',
      perTxMist: '100000000',
    }),
  });

  expect(response.status).toBe(200);
  const body = (await response.json()) as { success: boolean; data: Record<string, unknown> };
  expect(body.success).toBe(true);
  expect(body.data).toEqual({
    setupPtb: 'setup_base64',
    tradeCapPtb: 'tradecap_base64',
    runSetTemplate: { version: '1' },
    walletPackageId: '0x1',
    deepbookPackageId: '0x2',
  });
});

test('POST /setup/prepare rejects missing required fields', async () => {
  const response = await apiRouter.request('/setup/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ skillId: skill.id }),
  });

  expect(response.status).toBe(400);
});

test('POST /setup/prepare returns 404 for unknown skill', async () => {
  const response = await apiRouter.request('/setup/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      skillId: 'skill_unknown',
      sender: '0x'.padEnd(66, '0'),
      budgetMist: '1000000000',
      perTxMist: '100000000',
    }),
  });

  expect(response.status).toBe(404);
});

afterAll(() => {
  mock.module('../../features/setup/setup.service', () => realSetupModule);
});
