import {
  EXECUTION_ENVELOPE_NETWORKS,
  EXECUTION_ENVELOPE_OBJECT_CHANGE_TYPES,
  EXECUTION_ENVELOPE_REQUIRED_ARRAY_FIELDS,
  EXECUTION_ENVELOPE_REQUIRED_FIELDS,
  EXECUTION_ENVELOPE_REQUIRED_STRING_FIELDS,
  EXECUTION_ENVELOPE_RESOLVED_PARAM_BOOLEAN_FIELDS,
  EXECUTION_ENVELOPE_RESOLVED_PARAM_NUMBER_FIELDS,
  EXECUTION_ENVELOPE_RESOLVED_PARAM_REQUIRED_FIELDS,
  EXECUTION_ENVELOPE_RESOLVED_PARAM_STRING_FIELDS,
  EXECUTION_ENVELOPE_SIMULATION_REQUIRED_FIELDS,
  EXECUTION_ENVELOPE_SIMULATION_VERIFICATIONS,
  EXECUTION_ENVELOPE_VERSION,
} from '../../../packages/rill-sdk/src/execution-envelope';
import { buildActionInputSchema } from '../features/mcp/tool-schema';

const flowSchema = {
  type: 'object',
  required: ['nodes', 'edges'],
  properties: {
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'type'],
        properties: {
          id: { type: 'string', example: 'swap1' },
          type: {
            type: 'string',
            enum: ['cetus_swap', 'haedal_stake', 'deepbook_limit_order'],
            example: 'cetus_swap',
          },
          config: {
            type: 'object',
            additionalProperties: true,
            description:
              'Node config. For cetus_swap, pass `slippageBps` and let the compiler derive the ' +
              '`min_amount_out` floor from live pool state — an explicit `min_amount_out` is honoured ' +
              'as-is and is only correct if you priced it yourself, just now.',
            example: { amount_in: '100000000', slippageBps: '100' },
          },
          inputs: { type: 'object', additionalProperties: true },
        },
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        required: ['source', 'sourceHandle', 'target', 'targetHandle'],
        properties: {
          source: { type: 'string' },
          sourceHandle: { type: 'string' },
          target: { type: 'string' },
          targetHandle: { type: 'string', example: 'sui_coin' },
        },
      },
    },
  },
} as const;

const publishFlowSchema = {
  ...flowSchema,
  properties: {
    nodes: {
      ...flowSchema.properties.nodes,
      minItems: 1,
      maxItems: 1,
      items: {
        ...flowSchema.properties.nodes.items,
        properties: {
          ...flowSchema.properties.nodes.items.properties,
          type: { type: 'string', enum: ['deepbook_limit_order'] },
        },
      },
    },
    edges: {
      ...flowSchema.properties.edges,
      maxItems: 0,
    },
  },
} as const;

const agentWalletSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['packageId', 'walletId', 'capId'],
  properties: {
    packageId: { type: 'string' },
    walletId: { type: 'string' },
    capId: { type: 'string' },
    coinType: { type: 'string', default: '0x2::sui::SUI' },
  },
} as const;

const buildActionToolSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'description', 'inputSchema'],
  properties: {
    name: { type: 'string', enum: ['build_action'] },
    description: { type: 'string' },
    inputSchema: buildActionInputSchema(),
  },
} as const;

const strictSimulationSchema = {
  type: 'object',
  required: [...EXECUTION_ENVELOPE_SIMULATION_REQUIRED_FIELDS],
  properties: {
    ok: { type: 'boolean' },
    verification: { type: 'string', enum: [...EXECUTION_ENVELOPE_SIMULATION_VERIFICATIONS] },
    error: { type: 'string' },
    gasEstimate: { type: 'number' },
    balanceChanges: {
      type: 'array',
      items: {
        type: 'object',
        required: ['owner', 'coinType', 'amount'],
        properties: {
          owner: { type: 'string' },
          coinType: { type: 'string' },
          amount: { type: 'string' },
        },
      },
    },
    objectChanges: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type', 'objectId', 'objectType'],
        properties: {
          type: { type: 'string', enum: [...EXECUTION_ENVELOPE_OBJECT_CHANGE_TYPES] },
          objectId: { type: 'string' },
          objectType: { type: 'string' },
        },
      },
    },
  },
} as const;

const executionEnvelopeSchema = {
  type: 'object',
  required: [...EXECUTION_ENVELOPE_REQUIRED_FIELDS],
  properties: {
    version: { type: 'string', enum: [EXECUTION_ENVELOPE_VERSION] },
    actionId: { type: 'string' },
    actionDigest: { type: 'string' },
    network: { type: 'string', enum: [...EXECUTION_ENVELOPE_NETWORKS] },
    sender: { type: 'string' },
    walletPackageId: { type: 'string' },
    walletId: { type: 'string' },
    agentCapId: { type: 'string' },
    balanceManagerId: { type: 'string' },
    tradeCapId: { type: 'string' },
    resolvedParams: {
      type: 'object',
      required: [...EXECUTION_ENVELOPE_RESOLVED_PARAM_REQUIRED_FIELDS],
      properties: {
        ...Object.fromEntries(EXECUTION_ENVELOPE_RESOLVED_PARAM_STRING_FIELDS.map((field) => [field, { type: 'string' }])),
        ...Object.fromEntries(EXECUTION_ENVELOPE_RESOLVED_PARAM_NUMBER_FIELDS.map((field) => [field, { type: 'number' }])),
        ...Object.fromEntries(EXECUTION_ENVELOPE_RESOLVED_PARAM_BOOLEAN_FIELDS.map((field) => [field, { type: 'boolean' }])),
      },
    },
    ...Object.fromEntries(EXECUTION_ENVELOPE_REQUIRED_ARRAY_FIELDS.map((field) => [field, { type: 'array', items: { type: 'string' } }])),
    ...Object.fromEntries(EXECUTION_ENVELOPE_REQUIRED_STRING_FIELDS.map((field) => [field, { type: 'string' }])),
    unsignedPtb: { type: 'string' },
    preview: { type: 'string' },
    simulation: strictSimulationSchema,
    expiresAt: { type: 'string', format: 'date-time' },
  },
} as const;

const successEnvelope = (schema: Record<string, unknown>) => ({
  type: 'object',
  properties: {
    success: { type: 'boolean', example: true },
    data: schema,
  },
});

const errorEnvelope = {
  type: 'object',
  properties: {
    success: { type: 'boolean', example: false },
    error: { type: 'string' },
    type: { type: 'string' },
  },
};

const exampleSwapStakeFlow = {
  nodes: [
    {
      id: 'swap1',
      type: 'cetus_swap',
      // slippageBps, not min_amount_out: the floor is derived from pool state at compile time, so
      // it is priced when the swap is built rather than frozen when the flow was authored.
      config: { amount_in: '100000000', slippageBps: '100' },
    },
    {
      id: 'stake1',
      type: 'haedal_stake',
      config: { amount: '1000000000' },
    },
  ],
  edges: [],
};

export function buildOpenApiDocument(publicBaseUrl: string) {
  const apiBase = `${publicBaseUrl}/api`;

  return {
    openapi: '3.0.3',
    info: {
      title: 'Rill API',
      version: '1.0.0',
      description:
        'Keyless Move flow compiler for Sui — builds unsigned PTBs, simulates, and serves MCP tools. Thiny signs; agent_wallet enforces on-chain caps.',
    },
    servers: [{ url: apiBase, description: 'Current deployment' }],
    tags: [
      { name: 'Introspect', description: 'Move package discovery' },
      { name: 'Compiler', description: 'Flow → PTB compilation and simulation' },
      { name: 'Skills', description: 'MCP skill publish and execution' },
      { name: 'Walrus', description: 'Decentralized audit trail storage' },
      { name: 'MCP', description: 'Model Context Protocol JSON-RPC' },
    ],
    paths: {
      '/introspect': {
        post: {
          tags: ['Introspect'],
          summary: 'List public Move functions in a package',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['packageId'],
                  properties: {
                    packageId: {
                      type: 'string',
                      example: '0x0a6ff2b974e08b65649d334c38db5ca046b78b4a5d892087740b9cdb3eb08e47',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Normalized function list',
              content: {
                'application/json': {
                  schema: successEnvelope({ type: 'array', items: { type: 'object' } }),
                },
              },
            },
          },
        },
      },
      '/resolve': {
        post: {
          tags: ['Introspect'],
          summary: 'Resolve semantic manifest for a Move function',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['packageId', 'moduleName', 'functionName'],
                  properties: {
                    packageId: { type: 'string' },
                    moduleName: { type: 'string', example: 'interface' },
                    functionName: { type: 'string', example: 'request_stake' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Semantic manifest',
              content: {
                'application/json': {
                  schema: successEnvelope({ type: 'object' }),
                },
              },
            },
          },
        },
      },
      '/compile': {
        post: {
          tags: ['Compiler'],
          summary: 'Compile a visual flow into an unsigned PTB + human preview',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['flow'],
                  properties: {
                    flow: flowSchema,
                    sender: { type: 'string' },
                    agentWallet: agentWalletSchema,
                  },
                },
                example: { flow: exampleSwapStakeFlow },
              },
            },
          },
          responses: {
            '200': {
              description: 'Unsigned PTB (base64) + preview',
              content: {
                'application/json': {
                  schema: successEnvelope({
                    type: 'object',
                    required: ['unsignedPtb', 'preview', 'warnings', 'agentWalletBound', 'budgetSpendMist'],
                    properties: {
                      unsignedPtb: { type: 'string', description: 'Base64 unsigned PTB — sign via Thiny/wallet' },
                      preview: { type: 'string' },
                      warnings: { type: 'array', items: { type: 'string' } },
                      agentWalletBound: { type: 'boolean' },
                      budgetSpendMist: { type: 'string' },
                    },
                  }),
                },
              },
            },
          },
        },
      },
      '/quote': {
        post: {
          tags: ['Compiler'],
          summary: 'Spot-quote a Cetus swap from pool state (no devInspect)',
          description:
            'Reads the pool object\'s current_sqrt_price (Q64.64) and fee_rate and computes the expected ' +
            'output with exact integer math, then applies slippageBps to derive the on-chain floor passed to ' +
            'rill_guard::assert_min_value. Deliberately avoids devInspect/simulateTransaction: Cetus aborts in ' +
            'checked_package_version on testnet.\n\n' +
            '**Limit:** this is a spot quote — it ignores price impact and tick crossing. Against thin liquidity ' +
            'the real fill is lower than expectedOut, so minAmountOut can be too high and the swap reverts. ' +
            'That is fail-closed: a reverted swap is safe, an unprotected one is not.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['poolId', 'amountIn', 'a2b', 'slippageBps'],
                  properties: {
                    poolId: { type: 'string', description: 'Cetus CLMM pool object id' },
                    amountIn: { type: 'string', description: 'Raw base units of the input coin (u64 string)' },
                    a2b: {
                      type: 'boolean',
                      description: 'true = coinTypeA → coinTypeB; false = B → A (e.g. SUI → USDC on a USDC/SUI pool)',
                    },
                    slippageBps: {
                      type: 'integer',
                      minimum: 0,
                      maximum: 9999,
                      description: 'Slippage tolerance in basis points. 10000 is rejected — it would leave no floor.',
                    },
                  },
                },
                example: {
                  poolId: '0x2603c08065a848b719f5f465e40dbef485ec4fd9c967ebe83a7565269a74a2b2',
                  amountIn: '100000000',
                  a2b: false,
                  slippageBps: 100,
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Spot quote and the derived on-chain floor',
              content: {
                'application/json': {
                  schema: successEnvelope({
                    type: 'object',
                    required: ['expectedOut', 'minAmountOut', 'sqrtPriceX64', 'feeRate', 'ignoresPriceImpact', 'note'],
                    properties: {
                      expectedOut: { type: 'string', description: 'Expected raw output at the current spot price' },
                      minAmountOut: {
                        type: 'string',
                        description: 'expectedOut reduced by slippageBps — the floor asserted on chain',
                      },
                      sqrtPriceX64: { type: 'string', description: 'Pool current_sqrt_price (Q64.64) the quote used' },
                      feeRate: { type: 'string', description: 'Pool fee_rate in millionths (2500 = 0.25%)' },
                      ignoresPriceImpact: {
                        type: 'boolean',
                        description: 'Always true — spot quote, not a simulation. Do not hide this from users.',
                      },
                      note: { type: 'string', description: 'Human-readable statement of the above caveat' },
                    },
                  }),
                },
              },
            },
            '422': {
              description: 'Pool unreadable, paused, not a CLMM pool, or slippageBps leaves no floor',
            },
          },
        },
      },
      '/simulate': {
        post: {
          tags: ['Compiler'],
          summary: 'Compile and devInspect a flow (gas estimate, balance changes)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['flow'],
                  properties: {
                    flow: flowSchema,
                    sender: { type: 'string' },
                    agentWallet: agentWalletSchema,
                  },
                },
                example: { flow: exampleSwapStakeFlow },
              },
            },
          },
          responses: {
            '200': {
              description: 'Simulation result',
              content: {
                'application/json': {
                  schema: successEnvelope({
                    type: 'object',
                    required: ['unsignedPtb', 'preview', 'simulation', 'warnings', 'agentWalletBound'],
                    properties: {
                      unsignedPtb: { type: 'string' },
                      preview: { type: 'string' },
                      simulation: strictSimulationSchema,
                      warnings: { type: 'array', items: { type: 'string' } },
                      agentWalletBound: { type: 'boolean' },
                    },
                  }),
                },
              },
            },
          },
        },
      },
      '/publish': {
        post: {
          tags: ['Skills'],
          summary: 'Publish a flow as an MCP-callable skill',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['flow'],
                  properties: {
                    flow: publishFlowSchema,
                    policyId: { type: 'string' },
                  },
                },
                example: {
                  flow: {
                    nodes: [{ id: 'order', type: 'deepbook_limit_order' }],
                    edges: [],
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Published skill metadata',
              content: {
                'application/json': {
                  schema: successEnvelope({
                    type: 'object',
                    required: ['skillId', 'name', 'description', 'mcpUrl', 'skillUrl', 'toolDefs', 'warnings'],
                    properties: {
                      skillId: { type: 'string' },
                      name: { type: 'string' },
                      description: { type: 'string' },
                      mcpUrl: { type: 'string', format: 'uri' },
                      skillUrl: { type: 'string', format: 'uri' },
                      toolDefs: buildActionToolSchema,
                      warnings: { type: 'array', items: { type: 'string' } },
                    },
                  }),
                },
              },
            },
          },
        },
      },
      '/skills': {
        get: {
          tags: ['Skills'],
          summary: 'List published MCP skills',
          responses: {
            '200': {
              description: 'Skill list',
              content: {
                'application/json': {
                  schema: successEnvelope({
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['id', 'name', 'description', 'mcpUrl', 'skillUrl', 'toolDefs', 'createdAt'],
                      properties: {
                        id: { type: 'string' },
                        name: { type: 'string' },
                        description: { type: 'string' },
                        mcpUrl: { type: 'string', format: 'uri' },
                        skillUrl: { type: 'string', format: 'uri' },
                        toolDefs: buildActionToolSchema,
                        createdAt: { type: 'string', format: 'date-time' },
                      },
                    },
                  }),
                },
              },
            },
          },
        },
      },
      '/execute': {
        post: {
          tags: ['Skills'],
          summary: 'Build a strictly simulated ExecutionEnvelope for local signing',
          description: 'Keyless endpoint. It never signs or submits and rejects unknown execution fields.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['skillId', 'params', 'sender', 'agentWallet'],
                  properties: {
                    skillId: { type: 'string' },
                    params: { type: 'object', additionalProperties: true },
                    sender: { type: 'string' },
                    agentWallet: agentWalletSchema,
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Unsigned ExecutionEnvelope',
              content: {
                'application/json': {
                  schema: successEnvelope(executionEnvelopeSchema),
                },
              },
            },
          },
        },
      },
      '/audit/{blobId}': {
        get: {
          tags: ['Walrus'],
          summary: 'Read audit trail JSON stored on Walrus',
          parameters: [
            {
              name: 'blobId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'Audit record',
              content: {
                'application/json': {
                  schema: successEnvelope({ type: 'object' }),
                },
              },
            },
          },
        },
      },
      '/mcp/{skillId}': {
        post: {
          tags: ['MCP'],
          summary: 'MCP JSON-RPC endpoint for a published skill',
          parameters: [
            {
              name: 'skillId',
              in: 'path',
              required: true,
              schema: { type: 'string', example: 'skill_a1b2c3d4e5' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  description: 'JSON-RPC 2.0 request (tools/list, tools/call, etc.)',
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'JSON-RPC response',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    },
  };
}
