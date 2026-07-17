import { expect, test } from 'bun:test';
import { mainnetPackageIds, mainnetPools, testnetPackageIds, testnetPools } from '@mysten/deepbook-v3';
import { config } from '../../core/config';
import { apiRouter } from '../../http/routes/api.routes';
import { actionTools, assertKeylessToolArguments, handleMcpJsonRpc } from './mcp.service';
import { skillsStore, type PublishedSkill } from './skills.store';
import { buildToolDefs } from './tool-schema';

const skill = {
  id: 'skill_deepbook',
  name: 'DeepBook small ask',
  description: 'Place one bounded DeepBook limit order.',
  flow: { nodes: [{ id: 'order', type: 'deepbook_limit_order' }], edges: [] },
  toolDefs: buildToolDefs({
    nodes: [{ id: 'order', type: 'deepbook_limit_order' }],
    edges: [],
  }, 'skill_deepbook'),
  createdAt: '2026-07-16T00:00:00.000Z',
} satisfies PublishedSkill;

test('remote MCP exposes only the three Demo Day action tools', () => {
  expect(actionTools.map((tool) => tool.name)).toEqual([
    'list_actions',
    'describe_action',
    'build_action',
  ]);
});

test('build_action schema requires only public per-call build inputs', () => {
  const schema = actionTools[2].inputSchema;
  const wallet = schema.properties.agentWallet;

  expect(Object.keys(schema.properties)).toEqual(['actionId', 'sender', 'agentWallet', 'params']);
  expect(Object.keys(wallet.properties)).toEqual(['packageId', 'walletId', 'capId', 'coinType']);
  expect(wallet.required).toEqual(['packageId', 'walletId', 'capId']);
  expect(JSON.stringify(schema)).not.toMatch(/execute|force|private.?key/i);
});

test('published DeepBook metadata exposes the exact runtime parameters', () => {
  const tool = buildToolDefs({
    nodes: [{ id: 'order', type: 'deepbook_limit_order' }],
    edges: [],
  }, 'skill_deepbook');
  const schema = tool.inputSchema;
  const params = schema.properties.params;

  expect(tool.name).toBe('build_action');
  expect(Object.keys(schema.properties)).toEqual(['actionId', 'sender', 'agentWallet', 'params']);
  expect(schema.properties.actionId).toMatchObject({ type: 'string', const: 'skill_deepbook' });
  expect(Object.keys(params.properties)).toEqual([
    'poolKey',
    'balanceManagerId',
    'tradeCapId',
    'price',
    'quantity',
    'isBid',
    'payWithDeep',
    'clientOrderId',
    'depositSui',
  ]);
  expect(params.properties.isBid.type).toBe('boolean');
  expect(params.properties.payWithDeep.type).toBe('boolean');
  expect(params.required).toEqual(Object.keys(params.properties));
  expect(params.additionalProperties).toBe(false);
  expect(schema.additionalProperties).toBe(false);
});

test('remote MCP rejects execution and private-key fields', () => {
  expect(() => assertKeylessToolArguments({ execute: true })).toThrow('Hosted execution is forbidden');
  expect(() => assertKeylessToolArguments({ force: true })).toThrow('Hosted execution is forbidden');
  expect(() => assertKeylessToolArguments({ forceExecute: true })).toThrow('Hosted execution is forbidden');
  expect(() => assertKeylessToolArguments({ sender: '0x1', privateKey: 'nope' })).toThrow('Private key fields are forbidden');
  expect(() => assertKeylessToolArguments({ sender: '0x1', params: { secretKey: 'nope' } })).toThrow('Private key fields are forbidden');
});

test('tools/list returns the fixed action tool contract', async () => {
  const response = await handleMcpJsonRpc('skill_deepbook', {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  }, {
    getSkill: () => skill,
    runFlow: async () => { throw new Error('not called'); },
  });

  const tools = (response?.result as { tools: { name: string }[] }).tools;
  expect(tools.map((tool) => tool.name)).toEqual(['list_actions', 'describe_action', 'build_action']);
  expect(tools[2]).toEqual(skill.toolDefs);
});

test('list_actions reports build-only public metadata', async () => {
  const response = await handleMcpJsonRpc('skill_deepbook', {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'list_actions', arguments: {} },
  }, {
    getSkill: () => skill,
    runFlow: async () => { throw new Error('not called'); },
  });
  const result = response?.result as { content: [{ text: string }]; isError: boolean };

  expect(result.isError).toBe(false);
  expect(JSON.parse(result.content[0].text)).toEqual([{
    actionId: skill.id,
    name: skill.name,
    description: skill.description,
    walletBound: true,
    network: config.network,
  }]);
});

test('describe_action publishes runtime parameters and local signing rules', async () => {
  const response = await handleMcpJsonRpc('skill_deepbook', {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'describe_action', arguments: { actionId: skill.id } },
  }, {
    getSkill: () => skill,
    runFlow: async () => { throw new Error('not called'); },
  });
  const result = response?.result as { content: [{ text: string }]; isError: boolean };
  const deepbookPackageId = (
    config.network === 'testnet' ? testnetPackageIds : mainnetPackageIds
  ).DEEPBOOK_PACKAGE_ID;
  const buildSchema = skill.toolDefs.inputSchema as ReturnType<typeof buildToolDefs>['inputSchema'];

  expect(result.isError).toBe(false);
  expect(JSON.parse(result.content[0].text)).toEqual({
    actionId: skill.id,
    name: skill.name,
    description: skill.description,
    network: config.network,
    runtimeParameters: buildSchema.properties.params,
    agentWallet: buildSchema.properties.agentWallet,
    requiresSetup: true,
    setupSchema: {
      type: 'object',
      properties: {
        budgetMist: { type: 'string', description: 'Total wallet budget in MIST.' },
        perTxMist: { type: 'string', description: 'Maximum spend per transaction in MIST.' },
        minimumRemainingMist: { type: 'string', description: 'Minimum remaining budget in MIST.' },
        expiresAtMs: { type: 'string', description: 'Wallet expiration timestamp in milliseconds.' },
        clientOrderId: { type: 'string', description: 'Unique u64 client order ID.' },
      },
      required: ['budgetMist', 'perTxMist'],
      additionalProperties: false,
    },
    walletPackageId: config.agentWallet?.packageId ?? '<agentWallet.packageId>',
    deepbookPackageId,
    defaultPoolKey: config.network === 'testnet' ? 'SUI_DBUSDC' : 'SUI_USDC',
    defaultPoolId: (config.network === 'testnet' ? testnetPools : mainnetPools)[config.network === 'testnet' ? 'SUI_DBUSDC' : 'SUI_USDC']?.address ?? '',
    requiredTargets: [
      `${config.agentWallet?.packageId ?? '<agentWallet.packageId>'}::agent_wallet::spend`,
      `${deepbookPackageId}::balance_manager::deposit`,
      `${deepbookPackageId}::balance_manager::generate_proof_as_trader`,
      `${deepbookPackageId}::pool::place_limit_order`,
    ],
    requiredPublicObjects: [
      { role: 'AgentWallet', source: 'agentWallet.walletId' },
      { role: 'AgentCap', source: 'agentWallet.capId' },
      { role: 'BalanceManager', source: 'params.balanceManagerId' },
      { role: 'TradeCap', source: 'params.tradeCapId' },
      { role: 'DeepBookPool', source: 'params.poolKey resolved on the selected network' },
      { role: 'Clock', objectId: '0x6' },
    ],
    requiredGuards: [],
    simulationRule: 'Rill Cloud and rill-wallet both require a verified successful simulation.',
    signingRule: 'Only local rill-wallet.execute_rill_action may validate, re-simulate, sign, and submit.',
  });
  expect(JSON.stringify(JSON.parse(result.content[0].text).runtimeParameters)).not.toContain('sender');
});

test('build_action uses the per-call public AgentWallet binding', async () => {
  let received: unknown[] = [];
  const params = {
    poolKey: 'SUI_DBUSDC',
    balanceManagerId: '0x4',
    tradeCapId: '0x5',
    price: 1,
    quantity: 0.005,
    isBid: false,
    payWithDeep: false,
    clientOrderId: '71601',
    depositSui: 0.006,
  };
  const response = await handleMcpJsonRpc('skill_deepbook', {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'build_action',
      arguments: {
        actionId: skill.id,
        sender: '0x1',
        agentWallet: { packageId: '0x2', walletId: '0x3', capId: '0x6' },
        params,
      },
    },
  }, {
    getSkill: () => skill,
    runFlow: async (...args) => {
      received = args;
      return { version: '1' } as never;
    },
  });

  expect((response?.result as { isError: boolean }).isError).toBe(false);
  expect(received).toEqual([
    skill.flow,
    params,
    {
      actionId: skill.id,
      sender: '0x1',
      agentWallet: {
        packageId: '0x2',
        walletId: '0x3',
        capId: '0x6',
        coinType: '0x2::sui::SUI',
      },
    },
  ]);
});

test('every remote tool rejects forbidden fields with structured tool errors', async () => {
  const response = await handleMcpJsonRpc('skill_deepbook', {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'list_actions', arguments: { execute: true } },
  }, {
    getSkill: () => skill,
    runFlow: async () => { throw new Error('not called'); },
  });
  const result = response?.result as { content: [{ text: string }]; isError: boolean };

  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0].text)).toEqual({
    code: 'forbidden_arguments',
    message: 'Hosted execution is forbidden; request an ExecutionEnvelope and sign locally.',
  });
});

test('publishing stores metadata without compiling runtime objects', async () => {
  const save = skillsStore.save;
  let published: PublishedSkill | undefined;
  skillsStore.save = (value) => { published = value; };

  try {
    const response = await apiRouter.request('/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flow: skill.flow }),
    });
    const body = await response.json() as {
      success: boolean;
      data: {
        name: string;
        description: string;
        toolDefs: PublishedSkill['toolDefs'];
        warnings: string[];
      };
    };

    expect(response.status).toBe(200);
    expect(body.data.warnings).toEqual([
      'Published metadata only; build_action requires run-specific wallet, BalanceManager, TradeCap, sender, and runtime order params.',
    ]);
    expect(published?.flow).toEqual(skill.flow);
    if (!published) throw new Error('expected published metadata');
    expect(published?.name).toBe('DeepBook limit order');
    expect(published?.name).not.toBe(published?.toolDefs.name);
    expect(body.data.name).toBe(published.name);
    expect(body.data.description).toBe(published.description);
    expect(body.data.toolDefs.name).toBe('build_action');
  } finally {
    skillsStore.save = save;
  }
});

test('publishing rejects anything except one edge-free DeepBook hero node', async () => {
  const save = skillsStore.save;
  let saved = false;
  skillsStore.save = () => { saved = true; };

  try {
    const invalidFlows = [
      { nodes: [], edges: [] },
      { nodes: [{ id: 'swap', type: 'cetus_swap' }], edges: [] },
      {
        nodes: [
          { id: 'order-1', type: 'deepbook_limit_order' },
          { id: 'order-2', type: 'deepbook_limit_order' },
        ],
        edges: [],
      },
      {
        nodes: [{ id: 'order', type: 'deepbook_limit_order' }],
        edges: [{ source: 'order', sourceHandle: 'out', target: 'order', targetHandle: 'in' }],
      },
    ];

    for (const flow of invalidFlows) {
      const response = await apiRouter.request('/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ flow }),
      });
      expect(response.status).toBe(400);
    }
    expect(saved).toBe(false);
  } finally {
    skillsStore.save = save;
  }
});

test('unknown remote tools return a structured JSON-RPC error', async () => {
  const response = await handleMcpJsonRpc('skill_deepbook', {
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'execute_action', arguments: {} },
  }, {
    getSkill: () => skill,
    runFlow: async () => { throw new Error('not called'); },
  });

  expect(response?.error).toEqual({
    code: -32602,
    message: 'Unknown tool: execute_action',
  });
});

test('remote tools reject non-object arguments with JSON-RPC invalid params', async () => {
  const response = await handleMcpJsonRpc('skill_deepbook', {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'list_actions', arguments: 'invalid' },
  }, {
    getSkill: () => skill,
    runFlow: async () => { throw new Error('not called'); },
  });

  expect(response?.error).toEqual({
    code: -32602,
    message: 'Tool arguments must be an object.',
  });
});

test('build_action rejects fields outside the public AgentWallet binding', async () => {
  let called = false;
  const response = await handleMcpJsonRpc('skill_deepbook', {
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: {
      name: 'build_action',
      arguments: {
        actionId: skill.id,
        sender: '0x1',
        agentWallet: {
          packageId: '0x2',
          walletId: '0x3',
          capId: '0x4',
          owner: 'not-accepted',
        },
        params: {},
      },
    },
  }, {
    getSkill: () => skill,
    runFlow: async () => {
      called = true;
      return { version: '1' } as never;
    },
  });
  const result = response?.result as { content: [{ text: string }]; isError: boolean };

  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0].text)).toEqual({
    code: 'build_rejected',
    message: 'Unexpected agentWallet field: owner.',
  });
  expect(called).toBe(false);
});
