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
            enum: ['cetus_swap', 'haedal_stake'],
            example: 'cetus_swap',
          },
          config: {
            type: 'object',
            additionalProperties: true,
            example: { amount_in: '100000000', min_amount_out: '1' },
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
      config: { amount_in: '100000000', min_amount_out: '1' },
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
        'Autonomous Move flow compiler for Sui — introspect packages, compile PTBs, simulate, publish MCP skills, and execute on-chain.',
    },
    servers: [{ url: apiBase, description: 'Current deployment' }],
    tags: [
      { name: 'Introspect', description: 'Move package discovery' },
      { name: 'Compiler', description: 'Flow → PTB compilation and simulation' },
      { name: 'Skills', description: 'MCP skill publish and execution' },
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
          summary: 'Compile a visual flow graph into PTB bytes',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['flow'],
                  properties: { flow: flowSchema },
                },
                example: { flow: exampleSwapStakeFlow },
              },
            },
          },
          responses: {
            '200': {
              description: 'Serialized transaction bytes',
              content: {
                'application/json': {
                  schema: successEnvelope({
                    type: 'object',
                    properties: {
                      txBytes: { type: 'string', description: 'Base64 PTB bytes' },
                      warnings: { type: 'array', items: { type: 'string' } },
                    },
                  }),
                },
              },
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
                  required: ['flow'],
                  properties: { flow: flowSchema },
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
                    properties: {
                      simulation: {
                        type: 'object',
                        properties: {
                          ok: { type: 'boolean' },
                          gasEstimate: { type: 'number' },
                          simulatedViaFallback: { type: 'boolean' },
                          error: { type: 'string' },
                        },
                      },
                      warnings: { type: 'array', items: { type: 'string' } },
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
                  required: ['flow'],
                  properties: {
                    flow: flowSchema,
                    policyId: { type: 'string' },
                  },
                },
                example: { flow: exampleSwapStakeFlow },
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
                    properties: {
                      skillId: { type: 'string' },
                      mcpUrl: { type: 'string', format: 'uri' },
                      toolDefs: { type: 'object' },
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
                  schema: successEnvelope({ type: 'array', items: { type: 'object' } }),
                },
              },
            },
          },
        },
      },
      '/execute': {
        post: {
          tags: ['Skills'],
          summary: 'Simulate or execute a flow (or published skill)',
          description:
            'Set `execute: true` to sign and submit on-chain. Requires a configured local signer on the server.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    flow: flowSchema,
                    skillId: { type: 'string' },
                    params: { type: 'object', additionalProperties: true },
                    execute: { type: 'boolean', default: false },
                    forceExecute: { type: 'boolean', default: false },
                  },
                },
                example: {
                  flow: exampleSwapStakeFlow,
                  execute: false,
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Simulation or execution result',
              content: {
                'application/json': {
                  schema: successEnvelope({
                    type: 'object',
                    properties: {
                      simulation: { type: 'object' },
                      executed: { type: 'boolean' },
                      digest: { type: 'string' },
                      warnings: { type: 'array', items: { type: 'string' } },
                    },
                  }),
                },
              },
            },
            '400': {
              description: 'Missing flow or skillId',
              content: { 'application/json': { schema: errorEnvelope } },
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
