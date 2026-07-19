import { expect, test } from 'bun:test';
import server from '../index';
import { apiRouter } from './routes/api.routes';
import { assertKeylessToolArguments, handleMcpJsonRpc } from '../features/mcp/mcp.service';
import { skillsStore, type PublishedSkill } from '../features/mcp/skills.store';
import { skillRunnerService } from '../features/mcp/skill-runner.service';
import { buildToolDefs } from '../features/mcp/tool-schema';
import { buildOpenApiDocument } from './openapi';
import { assertExecutionEnvelope } from '../../../packages/rill-sdk/src/execution-envelope';
import type { ExecutionEnvelope } from '../../../packages/rill-sdk/src/types';
import { config } from '../core/config';
import { introspectService } from '../features/introspect/introspect.service';

type ObjectSchema = {
  additionalProperties?: boolean;
  minItems?: number;
  maxItems?: number;
  items?: ObjectSchema;
  required?: string[];
  properties: Record<string, unknown>;
};

type Operation = {
  requestBody: { content: { 'application/json': { schema: ObjectSchema } } };
  responses: { '200': { content: { 'application/json': { schema: { properties: { data: ObjectSchema } } } } } };
};

const document = buildOpenApiDocument('https://api.example.com') as unknown as {
  paths: Record<string, { post: Operation }>;
};

const operation = (path: string) => document.paths[path].post;
const requestSchema = (path: string) => operation(path).requestBody.content['application/json'].schema;
const responseSchema = (path: string) =>
  operation(path).responses['200'].content['application/json'].schema.properties.data;

const testSkill = {
  id: 'skill_contract',
  name: 'DeepBook limit order',
  description: 'Contract test skill',
  flow: { nodes: [{ id: 'order', type: 'deepbook_limit_order' }], edges: [] },
  toolDefs: buildToolDefs({
    nodes: [{ id: 'order', type: 'deepbook_limit_order' }],
    edges: [],
  }, 'skill_contract'),
  createdAt: '2026-07-16T00:00:00.000Z',
} satisfies PublishedSkill;

const testEnvelope = {
  version: '1',
  actionId: testSkill.id,
  actionDigest: 'digest',
  network: 'testnet',
  sender: `0x${'1'.repeat(64)}`,
  walletPackageId: `0x${'2'.repeat(64)}`,
  walletId: `0x${'3'.repeat(64)}`,
  agentCapId: `0x${'4'.repeat(64)}`,
  balanceManagerId: `0x${'5'.repeat(64)}`,
  tradeCapId: `0x${'6'.repeat(64)}`,
  resolvedParams: {
    poolKey: 'SUI_DBUSDC',
    poolId: `0x${'7'.repeat(64)}`,
    price: 1,
    quantity: 0.01,
    isBid: false,
    payWithDeep: false,
    clientOrderId: '71601',
    depositSui: 0.01,
    spendAmountMist: '10000000',
  },
  allowedTargets: ['0x2::module::call'],
  requiredObjectIds: [`0x${'3'.repeat(64)}`],
  requiredGuards: [],
  unsignedPtb: Buffer.from('{"version":2}').toString('base64'),
  preview: 'DeepBook limit order',
  simulation: {
    ok: true,
    verification: 'verified',
    gasEstimate: 1,
    balanceChanges: [],
    objectChanges: [],
  },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
} satisfies ExecutionEnvelope;

// There is ONE agent_wallet package now — every bound wallet requires a capabilityManifest +
// versionId (no legacy manifest-less spend() fallback).
const DEFAULT_MANIFEST = {
  walletCoinType: '0x2::sui::SUI',
  rules: [{ kind: 'budget', totalMist: '5000000000' }],
};

const request = (extra: Record<string, unknown>) => apiRouter.request('/execute', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    skillId: 'skill_demo',
    sender: `0x${'1'.repeat(64)}`,
    agentWallet: {
      packageId: `0x${'2'.repeat(64)}`,
      walletId: `0x${'3'.repeat(64)}`,
      capId: `0x${'4'.repeat(64)}`,
      versionId: `0x${'9'.repeat(64)}`,
      capabilityManifest: DEFAULT_MANIFEST,
    },
    params: {},
    ...extra,
  }),
});

async function requestTestSkill(arguments_: Record<string, unknown>) {
  const get = skillsStore.get;
  skillsStore.get = () => testSkill;
  try {
    return await apiRouter.request(`/mcp/${testSkill.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'build_action', arguments: arguments_ },
      }),
    });
  } finally {
    skillsStore.get = get;
  }
}

test('REST rejects execute=true', async () => {
  expect((await request({ execute: true })).status).toBe(400);
});

test('REST rejects forceExecute=true', async () => {
  expect((await request({ forceExecute: true })).status).toBe(400);
});

test('compile and simulate reject hosted execution fields', async () => {
  for (const path of ['/compile', '/simulate']) {
    for (const field of ['execute', 'forceExecute']) {
      const response = await apiRouter.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          flow: { nodes: [], edges: [] },
          [field]: true,
        }),
      });
      expect(response.status).toBe(400);
    }
  }
});

test('MCP rejects execute attempts', () => {
  expect(() => assertKeylessToolArguments({ execute: true })).toThrow('Hosted execution is forbidden');
});

test('MCP rejects forceExecute attempts', () => {
  expect(() => assertKeylessToolArguments({ forceExecute: true })).toThrow('Hosted execution is forbidden');
});

test('MCP tool schema requires sender', () => {
  const tool = buildToolDefs({ nodes: [], edges: [] }, 'demo');
  expect(tool.inputSchema.required).toContain('sender');
});

test('MCP keyless guard allows sender-free discovery arguments', () => {
  expect(() => assertKeylessToolArguments({})).not.toThrow();
  expect(() => assertKeylessToolArguments({ actionId: testSkill.id })).not.toThrow();
});

test('MCP returns structured tool errors for forbidden execution and blank sender arguments', async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ execute: true }, 'Hosted execution is forbidden'],
    [{ forceExecute: true }, 'Hosted execution is forbidden'],
    [{
      actionId: testSkill.id,
      sender: '   ',
      agentWallet: {
        packageId: testEnvelope.walletPackageId,
        walletId: testEnvelope.walletId,
        capId: testEnvelope.agentCapId,
      },
      params: {},
    }, 'sender is required'],
  ];

  for (const [arguments_, message] of cases) {
    const response = await requestTestSkill(arguments_);
    const body = await response.json() as {
      result: { isError: boolean; structuredContent: { message: string } };
    };
    expect(response.status).toBe(200);
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.message).toContain(message);
  }
});

test('MCP rejects missing and wrong tool names as invalid params before validating arguments', async () => {
  const get = skillsStore.get;
  skillsStore.get = () => testSkill;
  try {
    for (const [name, message] of [
      [undefined, 'tools/call requires a tool name.'],
      ['rill_wrong_tool', 'Unknown tool: rill_wrong_tool'],
    ] as const) {
      const response = await handleMcpJsonRpc(testSkill.id, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name, arguments: { execute: true } },
      });
      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 2,
        error: {
          code: -32602,
          message,
        },
      });
    }
  } finally {
    skillsStore.get = get;
  }
});

test('REST and MCP build-action surfaces return the canonical envelope', async () => {
  const get = skillsStore.get;
  const runFlow = skillRunnerService.runFlow;
  const actionIds: string[] = [];
  skillsStore.get = () => testSkill;
  skillRunnerService.runFlow = async (_flow, _params, options) => {
    actionIds.push(options.actionId);
    return testEnvelope;
  };

  try {
    const restResponse = await request({ skillId: testSkill.id });
    const restBody = await restResponse.json() as { data: unknown };
    expect(assertExecutionEnvelope(restBody.data)).toEqual(testEnvelope);

    const mcpResponse = await handleMcpJsonRpc(testSkill.id, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'build_action',
        arguments: {
          actionId: testSkill.id,
          sender: testEnvelope.sender,
          agentWallet: {
            packageId: testEnvelope.walletPackageId,
            walletId: testEnvelope.walletId,
            capId: testEnvelope.agentCapId,
            versionId: `0x${'9'.repeat(64)}`,
            capabilityManifest: DEFAULT_MANIFEST,
          },
          params: {},
        },
      },
    }, {
      getSkill: () => testSkill,
      runFlow: async (_flow, _params, options) => {
        actionIds.push(options.actionId);
        return testEnvelope;
      },
    }) as { result: { content: { text: string }[] } };
    expect(assertExecutionEnvelope(JSON.parse(mcpResponse.result.content[0].text))).toEqual(testEnvelope);
    expect(actionIds).toEqual([testSkill.id, testSkill.id]);
  } finally {
    skillsStore.get = get;
    skillRunnerService.runFlow = runFlow;
  }
});

test('compile API and OpenAPI expose the actual keyless fields', async () => {
  const response = await apiRouter.request('/compile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      flow: { nodes: [], edges: [] },
      sender: `0x${'1'.repeat(64)}`,
      agentWallet: {
        packageId: `0x${'2'.repeat(64)}`,
        walletId: `0x${'3'.repeat(64)}`,
        capId: `0x${'4'.repeat(64)}`,
        versionId: `0x${'9'.repeat(64)}`,
        capabilityManifest: DEFAULT_MANIFEST,
      },
    }),
  });
  const body = await response.json() as { data: Record<string, unknown> };
  const fields = ['agentWalletBound', 'budgetSpendMist', 'preview', 'unsignedPtb', 'warnings'];

  expect(response.status).toBe(200);
  expect(Object.keys(body.data).sort()).toEqual(fields);
  // useServerWallet (R13, U5) added alongside agentWallet/flow/sender — an anonymous request now
  // only binds the operator wallet when it opts in via this flag.
  expect(Object.keys(requestSchema('/compile').properties).sort()).toEqual(['agentWallet', 'flow', 'sender', 'useServerWallet']);
  expect(responseSchema('/compile').required?.slice().sort()).toEqual(fields);
  expect(Object.keys(responseSchema('/compile').properties).sort()).toEqual(fields);
});

test('simulate and publish OpenAPI expose their actual request and response fields', () => {
  const simulationSchema = responseSchema('/simulate').properties.simulation as ObjectSchema;

  expect(Object.keys(requestSchema('/simulate').properties).sort()).toEqual(['agentWallet', 'flow', 'sender', 'useServerWallet']);
  expect(responseSchema('/simulate').required?.slice().sort()).toEqual([
    'agentWalletBound',
    'preview',
    'simulation',
    'unsignedPtb',
    'warnings',
  ]);
  expect(Object.keys(responseSchema('/simulate').properties).sort()).toEqual([
    'agentWalletBound',
    'preview',
    'simulation',
    'unsignedPtb',
    'warnings',
  ]);
  expect(simulationSchema.required).toContain('verification');
  expect(simulationSchema.properties.verification).toEqual({
    type: 'string',
    enum: ['verified', 'unverified'],
  });
  expect(simulationSchema.properties).not.toHaveProperty('simulatedViaFallback');
  const publishSchema = responseSchema('/publish');
  const toolDefs = publishSchema.properties.toolDefs as ObjectSchema;
  const inputSchema = toolDefs.properties.inputSchema as ObjectSchema;
  const params = inputSchema.properties.params as ObjectSchema;
  expect(publishSchema.required).toEqual([
    'skillId',
    'name',
    'description',
    'mcpUrl',
    'skillUrl',
    'toolDefs',
    'warnings',
  ]);
  expect(toolDefs.required).toEqual(['name', 'description', 'inputSchema']);
  expect(toolDefs.properties.name).toEqual({ type: 'string', enum: ['build_action'] });
  expect(Object.keys(inputSchema.properties)).toEqual(['actionId', 'sender', 'agentWallet', 'params']);
  expect(params.additionalProperties).toBe(false);
});

test('publish rejects unknown fields and documents a strict request body', async () => {
  const save = skillsStore.save;
  let saved = false;
  skillsStore.save = () => { saved = true; };

  try {
    const response = await apiRouter.request('/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        flow: { nodes: [], edges: [] },
        execute: true,
      }),
    });

    // Unknown fields are still rejected by `.strict()`, now surfaced as a 422 with a readable
    // message (the zodErrorToMessage hook) instead of the default 400 + "[object Object]".
    expect(response.status).toBe(422);
    expect(saved).toBe(false);
    expect(requestSchema('/publish').additionalProperties).toBe(false);
    const flow = requestSchema('/publish').properties.flow as ObjectSchema;
    // Publish is no longer DeepBook-only — the flow shape is the general compile/simulate shape.
    expect(flow.properties.nodes).toBeDefined();
    expect(flow.properties.edges).toBeDefined();
  } finally {
    skillsStore.save = save;
  }
});

test('build-action OpenAPI exposes only the canonical ExecutionEnvelope', () => {
  const fields = [
    'actionDigest',
    'actionId',
    'agentCapId',
    'allowedTargets',
    'balanceManagerId',
    'expiresAt',
    'network',
    'preview',
    'requiredGuards',
    'requiredObjectIds',
    'resolvedParams',
    'sender',
    'simulation',
    'tradeCapId',
    'unsignedPtb',
    'version',
    'walletId',
    'walletPackageId',
  ];
  const schema = responseSchema('/execute');
  const simulation = schema.properties.simulation as ObjectSchema;

  expect(schema.required?.slice().sort()).toEqual(fields);
  expect(Object.keys(schema.properties).sort()).toEqual(fields);
  expect(simulation.required?.slice().sort()).toEqual([
    'balanceChanges',
    'gasEstimate',
    'objectChanges',
    'ok',
    'verification',
  ]);
});

test('health describes the Walrus read endpoint without claiming availability', async () => {
  const response = await server.fetch(new Request('http://localhost/health'));
  const health = await response.json() as { walrus: Record<string, unknown> };
  expect(health.walrus).toEqual({
    readEndpoint: '/api/audit/:blobId',
    availability: 'unchecked',
    uploadsEnabled: false,
  });
});

// --- Flow-size cap (R13) ------------------------------------------------------------------

function buildOversizedFlow(count: number) {
  return {
    nodes: Array.from({ length: count }, (_, i) => ({ id: `n${i}`, type: 'guardrail' })),
    edges: [],
  };
}

test('compile and simulate reject a 21-node flow with 422 (R13)', async () => {
  const flow = buildOversizedFlow(21);
  for (const path of ['/compile', '/simulate']) {
    const response = await apiRouter.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flow }),
    });
    const body = await response.json() as { success: boolean; type: string };
    expect(response.status).toBe(422);
    expect(body.success).toBe(false);
    expect(body.type).toBe('FlowTooLarge');
  }
});

test('compile and simulate accept a flow at exactly the 20-node cap', async () => {
  const flow = buildOversizedFlow(20);
  const response = await apiRouter.request('/compile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ flow }),
  });
  expect(response.status).toBe(200);
});

// A flow of 21 disconnected nodes with NO deepbook_limit_order is already rejected at 400 by
// PublishSchema's existing hero-action refine (`isHeroActionFlow` requires exactly one
// deepbook_limit_order node) before the node-count cap check ever runs — that's a stricter,
// pre-existing gate the cap check never gets to add anything to. But `isHeroActionFlow` also
// tolerates `ptb`/`guardrail` wrapper nodes alongside the one order node, so a flow with one order
// node plus 20 guardrail wrappers (21 nodes total, structurally still a valid "hero action" flow)
// DOES reach the cap check — this is the actually-reachable 422 path for `/publish` (R13).
test('publish rejects a 21-node flow with 422 when it would otherwise pass the hero-action check', async () => {
  const flow = {
    nodes: [
      { id: 'order', type: 'deepbook_limit_order' },
      ...Array.from({ length: 20 }, (_, i) => ({ id: `guard${i}`, type: 'guardrail' })),
    ],
    edges: [],
  };
  const response = await apiRouter.request('/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ flow }),
  });
  const body = await response.json() as { success: boolean; type: string };
  expect(response.status).toBe(422);
  expect(body.type).toBe('FlowTooLarge');
});

// Publish is no longer DeepBook-only, so an oversized flow is now caught by the node-count cap
// (R13) regardless of action type — a 21-node flow returns 422 FlowTooLarge.
test('publish rejects an oversized flow at 422 (node-count cap)', async () => {
  const response = await apiRouter.request('/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ flow: buildOversizedFlow(21) }),
  });
  const body = await response.json() as { success: boolean; type: string };
  expect(response.status).toBe(422);
  expect(body.type).toBe('FlowTooLarge');
});

// --- Server-wallet fallback opt-in (R13) --------------------------------------------------

test('compile without agentWallet and without useServerWallet never binds the configured operator wallet', async () => {
  const original = config.agentWallet;
  config.agentWallet = {
    packageId: `0x${'a'.repeat(64)}`,
    walletId: `0x${'b'.repeat(64)}`,
    capId: `0x${'c'.repeat(64)}`,
    coinType: '0x2::sui::SUI',
  };
  // haedal_stake needs no network access to compile (static object ids) — unlike cetus_swap, which
  // would hit a real RPC to resolve pool type args.
  const flow = {
    nodes: [{ id: 'stake1', type: 'haedal_stake', config: { amount: '1000000000' } }],
    edges: [],
  };
  try {
    const withoutFlag = await apiRouter.request('/compile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flow }),
    });
    const withoutFlagBody = await withoutFlag.json() as { data: { agentWalletBound: boolean } };
    expect(withoutFlag.status).toBe(200);
    expect(withoutFlagBody.data.agentWalletBound).toBe(false);

    // The operator's env-configured wallet (`loadAgentWalletFromEnv`) carries no capabilityManifest
    // — there is no more legacy manifest-less spend() fallback, so `useServerWallet: true` against a
    // flow that needs funding now fails closed with the SAME ValidationError any other manifest-less
    // binding gets, just raised one layer deeper (by the compiler, since `resolveAgentWallet`'s
    // server-wallet branch does not itself call `normalizeAgentWallet` — see its doc comment in
    // api.routes.ts). Uses the full app (not the bare apiRouter): a thrown ValidationError only
    // becomes a structured 422 through index.ts's onError handler.
    const withFlag = await server.fetch(new Request('http://localhost/api/compile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flow, useServerWallet: true }),
    }));
    const withFlagBody = await withFlag.json() as { success: boolean; type: string };
    expect(withFlag.status).toBe(422);
    expect(withFlagBody.success).toBe(false);
    expect(withFlagBody.type).toBe('ValidationError');
  } finally {
    config.agentWallet = original;
  }
});

test('an explicit agentWallet still binds without useServerWallet', async () => {
  const flow = {
    nodes: [{ id: 'stake1', type: 'haedal_stake', config: { amount: '1000000000' } }],
    edges: [],
  };
  const response = await apiRouter.request('/compile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      flow,
      agentWallet: {
        packageId: `0x${'a'.repeat(64)}`,
        walletId: `0x${'b'.repeat(64)}`,
        capId: `0x${'c'.repeat(64)}`,
        versionId: `0x${'9'.repeat(64)}`,
        capabilityManifest: DEFAULT_MANIFEST,
      },
    }),
  });
  const body = await response.json() as { data: { agentWalletBound: boolean } };
  expect(response.status).toBe(200);
  expect(body.data.agentWalletBound).toBe(true);
});

// --- Manifest-gated agent-wallet flow wired to /compile (the ONLY agent_wallet path) -----------

test('compile with agentWallet.capabilityManifest + versionId binds via the redesigned agent_wallet package', async () => {
  const flow = {
    nodes: [{ id: 'stake1', type: 'haedal_stake', config: { amount: '1000000000' } }],
    edges: [],
  };
  const response = await apiRouter.request('/compile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      flow,
      sender: `0x${'1'.repeat(64)}`,
      agentWallet: {
        packageId: `0x${'a'.repeat(64)}`,
        walletId: `0x${'b'.repeat(64)}`,
        capId: `0x${'c'.repeat(64)}`,
        versionId: `0x${'d'.repeat(64)}`,
        capabilityManifest: {
          walletCoinType: '0x2::sui::SUI',
          rules: [{ kind: 'budget', totalMist: '5000000000' }],
        },
      },
    }),
  });
  const body = await response.json() as {
    success: boolean;
    data: { agentWalletBound: boolean; budgetSpendMist: string };
  };

  expect(response.status).toBe(200);
  expect(body.success).toBe(true);
  expect(body.data.agentWalletBound).toBe(true);
  expect(body.data.budgetSpendMist).toBe('1000000000');
});

// A manifest-less request against the SAME /compile route is rejected — there is no legacy v2
// agent_wallet path left to fall back to.
test('compile without a capabilityManifest is rejected — no legacy v2 agent_wallet fallback', async () => {
  const flow = {
    nodes: [{ id: 'stake1', type: 'haedal_stake', config: { amount: '1000000000' } }],
    edges: [],
  };
  // Uses the full app (not the bare apiRouter): `normalizeAgentWallet` THROWS `ValidationError`
  // rather than returning a JSON error, which only becomes a structured 422 through index.ts's
  // `onError` handler.
  const response = await server.fetch(new Request('http://localhost/api/compile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      flow,
      sender: `0x${'1'.repeat(64)}`,
      agentWallet: {
        packageId: `0x${'a'.repeat(64)}`,
        walletId: `0x${'b'.repeat(64)}`,
        capId: `0x${'c'.repeat(64)}`,
      },
    }),
  }));
  const body = await response.json() as { success: boolean; type: string; error: string };

  expect(response.status).toBe(422);
  expect(body.success).toBe(false);
  expect(body.type).toBe('ValidationError');
  expect(body.error).toMatch(/bound without a capabilityManifest/);
});

// `normalizeAgentWallet` THROWS `ValidationError` rather than returning a JSON error — that only
// becomes a structured 422 through the full app's `onError` handler (`index.ts`'s `app.onError
// (errorHandler)`), not the bare `apiRouter` sub-router used everywhere else in this file (which has
// no error handler of its own and would otherwise surface a plain-text 500 — see the `/introspect`
// 501 test below for the same distinction).
test('compile with a capabilityManifest but no versionId, and no server-side env fallback, rejects with 422', async () => {
  const flow = {
    nodes: [{ id: 'stake1', type: 'haedal_stake', config: { amount: '1000000000' } }],
    edges: [],
  };
  const response = await server.fetch(new Request('http://localhost/api/compile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      flow,
      sender: `0x${'1'.repeat(64)}`,
      agentWallet: {
        packageId: `0x${'a'.repeat(64)}`,
        walletId: `0x${'b'.repeat(64)}`,
        capId: `0x${'c'.repeat(64)}`,
        capabilityManifest: {
          walletCoinType: '0x2::sui::SUI',
          rules: [{ kind: 'budget', totalMist: '5000000000' }],
        },
      },
    }),
  }));
  const body = await response.json() as { success: boolean; type: string; error: string };

  expect(response.status).toBe(422);
  expect(body.success).toBe(false);
  expect(body.type).toBe('ValidationError');
  expect(body.error).toMatch(/versionId/);
});

test('AgentWalletSchema rejects an invalid capabilityManifest (KTD-6 empty rules) with a 400 before it ever reaches the compiler', async () => {
  const flow = {
    nodes: [{ id: 'stake1', type: 'haedal_stake', config: { amount: '1000000000' } }],
    edges: [],
  };
  const response = await apiRouter.request('/compile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      flow,
      sender: `0x${'1'.repeat(64)}`,
      agentWallet: {
        packageId: `0x${'a'.repeat(64)}`,
        walletId: `0x${'b'.repeat(64)}`,
        capId: `0x${'c'.repeat(64)}`,
        versionId: `0x${'d'.repeat(64)}`,
        capabilityManifest: { walletCoinType: '0x2::sui::SUI', rules: [] },
      },
    }),
  });

  expect(response.status).toBe(400);
});

// --- /introspect honest 501 (R15) -----------------------------------------------------------

test('introspectService.introspectPackage rejects with a stable 501 AppError, not a plain Error', async () => {
  await expect(introspectService.introspectPackage('0x2')).rejects.toMatchObject({
    name: 'NotImplemented',
    status: 501,
  });
});

test('POST /introspect surfaces the honest 501 over HTTP (via the full app, not the bare sub-router)', async () => {
  const response = await server.fetch(new Request('http://localhost/api/introspect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ packageId: '0x2' }),
  }));
  const body = await response.json() as { success: boolean; type: string };
  expect(response.status).toBe(501);
  expect(body.success).toBe(false);
  expect(body.type).toBe('NotImplemented');
});
