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
      // A flow that compiles to real MoveCalls: the preview is now derived from the compiled
      // bytes, so a flow with no on-chain calls is refused rather than previewed.
      flow: {
        nodes: [{ id: 'stake', type: 'haedal_stake', config: { amount: '1000000000' } }],
        edges: [],
      },
      sender: `0x${'1'.repeat(64)}`,
      agentWallet: {
        packageId: `0x${'2'.repeat(64)}`,
        walletId: `0x${'3'.repeat(64)}`,
        capId: `0x${'4'.repeat(64)}`,
      },
    }),
  });
  const body = await response.json() as { data: Record<string, unknown> };
  const fields = ['agentWalletBound', 'budgetSpendMist', 'preview', 'unsignedPtb', 'warnings'];

  expect(response.status).toBe(200);
  expect(Object.keys(body.data).sort()).toEqual(fields);
  expect(Object.keys(requestSchema('/compile').properties).sort()).toEqual(['agentWallet', 'flow', 'sender']);
  expect(responseSchema('/compile').required?.slice().sort()).toEqual(fields);
  expect(Object.keys(responseSchema('/compile').properties).sort()).toEqual(fields);
});

test('simulate and publish OpenAPI expose their actual request and response fields', () => {
  const simulationSchema = responseSchema('/simulate').properties.simulation as ObjectSchema;

  expect(Object.keys(requestSchema('/simulate').properties).sort()).toEqual(['agentWallet', 'flow', 'sender']);
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
    enum: ['verified', 'unverified', 'failed'],
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

    expect(response.status).toBe(400);
    expect(saved).toBe(false);
    expect(requestSchema('/publish').additionalProperties).toBe(false);
    const flow = requestSchema('/publish').properties.flow as ObjectSchema;
    const nodes = flow.properties.nodes as ObjectSchema;
    const edges = flow.properties.edges as ObjectSchema;
    expect(nodes.minItems).toBe(1);
    expect(nodes.maxItems).toBe(1);
    expect(nodes.items?.properties.type).toEqual({
      type: 'string',
      enum: ['deepbook_limit_order'],
    });
    expect(edges.maxItems).toBe(0);
  } finally {
    skillsStore.save = save;
  }
});

test('build-action OpenAPI exposes only the canonical ExecutionEnvelope', () => {
  const properties = [
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
  const required = properties.filter((f) => f !== 'balanceManagerId' && f !== 'tradeCapId');
  const schema = responseSchema('/execute');
  const simulation = schema.properties.simulation as ObjectSchema;

  expect(schema.required?.slice().sort()).toEqual(required);
  expect(Object.keys(schema.properties).sort()).toEqual(properties);
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
