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

// Publish accepts any structurally-valid flow the compiler can build (single or chained Cetus
// swap / Haedal stake / DeepBook limit order) — the same shape /compile and /simulate take.
const publishFlowSchema = flowSchema;

const agentWalletSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['packageId', 'walletId', 'capId'],
  properties: {
    packageId: { type: 'string' },
    walletId: { type: 'string' },
    capId: { type: 'string' },
    coinType: { type: 'string', default: '0x2::sui::SUI' },
    // Every bound agent wallet requires a capabilityManifest — there is no legacy manifest-less
    // spend() fallback (see `core/agent-wallet.ts`'s `normalizeAgentWallet`). Both fields stay
    // optional at the JSON-schema level only so a missing one gets normalizeAgentWallet's clear
    // ValidationError instead of a generic schema-required error.
    capabilityManifest: {
      type: 'object',
      additionalProperties: true,
      description: 'Wallet-level CapabilityManifest (rules[]) — required to bind an agent wallet; '
        + 'builds the request_spend/prove/confirm_spend sequence. A wallet bound without one is '
        + 'rejected.',
    },
    versionId: {
      type: 'string',
      description: 'Shared agent_wallet Version object ID — required alongside capabilityManifest '
        + 'unless AGENT_WALLET_VERSION_ID is configured on the server.',
    },
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

// ---- CapabilityManifest (U7/R11: /capabilities/preview) --------------------------------------
// Mirrors `packages/rill-sdk/src/capability-manifest.ts`'s `CapabilityManifestSchema` — one object
// schema per rule kind, discriminated on `kind`.

const budgetRuleSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'totalMist'],
  properties: {
    kind: { type: 'string', enum: ['budget'] },
    totalMist: { type: 'string', description: 'Lifetime spend ceiling, decimal u64 base units.' },
  },
} as const;

const perTxRuleSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'maxMist'],
  properties: {
    kind: { type: 'string', enum: ['per_tx'] },
    maxMist: { type: 'string', description: 'Per-transaction spend ceiling, decimal u64 base units.' },
  },
} as const;

const rateLimitRuleSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'windowMs', 'maxMist'],
  properties: {
    kind: { type: 'string', enum: ['rate_limit'] },
    windowMs: { type: 'string', description: 'Rolling window length in milliseconds.' },
    maxMist: { type: 'string', description: 'Max spend within any one window, decimal u64 base units.' },
  },
} as const;

const protocolScopeRuleSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'allowedPackages'],
  properties: {
    kind: { type: 'string', enum: ['protocol_scope'] },
    allowedPackages: { type: 'array', items: { type: 'string' }, minItems: 1 },
  },
} as const;

const slippageFloorRuleSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'minOutMist'],
  properties: {
    kind: { type: 'string', enum: ['slippage_floor'] },
    minOutMist: { type: 'string' },
  },
} as const;

const assetScopeRuleSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'allowedCoinTypes'],
  properties: {
    kind: { type: 'string', enum: ['asset_scope'] },
    allowedCoinTypes: { type: 'array', items: { type: 'string' }, minItems: 1 },
  },
} as const;

const recipientAllowlistRuleSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'addresses'],
  properties: {
    kind: { type: 'string', enum: ['recipient_allowlist'] },
    addresses: { type: 'array', items: { type: 'string' }, minItems: 1 },
  },
} as const;

const timeWindowRuleSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'notBeforeMs', 'notAfterMs'],
  properties: {
    kind: { type: 'string', enum: ['time_window'] },
    notBeforeMs: { type: 'string', description: 'Unix ms lower bound (inclusive); must be < notAfterMs.' },
    notAfterMs: { type: 'string', description: 'Unix ms upper bound (exclusive).' },
  },
} as const;

const capabilityRuleSchema = {
  oneOf: [
    budgetRuleSchema,
    perTxRuleSchema,
    rateLimitRuleSchema,
    protocolScopeRuleSchema,
    slippageFloorRuleSchema,
    assetScopeRuleSchema,
    recipientAllowlistRuleSchema,
    timeWindowRuleSchema,
  ],
  discriminator: { propertyName: 'kind' },
} as const;

const capabilityManifestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['walletCoinType', 'rules'],
  properties: {
    walletCoinType: { type: 'string', example: '0x2::sui::SUI' },
    rules: { type: 'array', items: capabilityRuleSchema },
  },
} as const;

const onChainRuleParamsSchema = {
  type: 'object',
  required: ['module', 'config'],
  properties: {
    module: { type: 'string', description: 'The Move module the rule\'s prove/config-attach functions live in.' },
    config: { type: 'object', additionalProperties: true },
  },
} as const;

const signerPolicySchema = {
  type: 'object',
  properties: {
    maxAmountMist: { type: 'string' },
    perTxMaxMist: { type: 'string' },
    window: {
      type: 'object',
      properties: { windowMs: { type: 'string' }, maxMist: { type: 'string' } },
    },
    allowedPackages: { type: 'array', items: { type: 'string' } },
    minSlippageOutMist: { type: 'string' },
    allowedCoinTypes: { type: 'array', items: { type: 'string' } },
    allowedRecipients: { type: 'array', items: { type: 'string' } },
    timeWindow: {
      type: 'object',
      required: ['notBeforeMs', 'notAfterMs'],
      properties: {
        notBeforeMs: { type: 'string' },
        notAfterMs: { type: 'string' },
      },
    },
  },
} as const;

const capabilityDeclarationSchema = {
  type: 'object',
  required: ['summaryLines', 'caps'],
  properties: {
    summaryLines: { type: 'array', items: { type: 'string' } },
    caps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['label', 'value'],
        properties: { label: { type: 'string' }, value: { type: 'string' } },
      },
    },
  },
} as const;

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
        'Keyless Move flow compiler for Sui — builds unsigned PTBs, simulates, and serves MCP tools. Thiny signs; agent_wallet enforces on-chain caps.',
    },
    servers: [{ url: apiBase, description: 'Current deployment' }],
    tags: [
      { name: 'Introspect', description: 'Move package discovery' },
      { name: 'Compiler', description: 'Flow → PTB compilation and simulation' },
      { name: 'Capabilities', description: 'CapabilityManifest preview — read-only, pure projections' },
      { name: 'Skills', description: 'MCP skill publish and execution' },
      { name: 'Walrus', description: 'Decentralized audit trail storage' },
      { name: 'MCP', description: 'Model Context Protocol JSON-RPC' },
    ],
    paths: {
      '/introspect': {
        post: {
          tags: ['Introspect'],
          summary: 'Not implemented — always returns 501 (R15)',
          description:
            'This build\'s gRPC client does not expose Move package bytecode/ABI, so dynamic '
            + 'introspection is genuinely unsupported here — every call returns 501 with a stable '
            + '`type: "NotImplemented"`, never a fabricated 200. Use `/resolve` with a curated '
            + '`packageId`/`moduleName`/`functionName` (Cetus, Haedal) instead.',
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
            '501': {
              description: 'Always returned — package introspection is not implemented in this build.',
              content: {
                'application/json': { schema: errorEnvelope },
              },
            },
          },
        },
      },
      '/resolve': {
        post: {
          tags: ['Introspect'],
          summary: 'Resolve semantic manifest for a Move function',
          description:
            'Returns a curated manifest for known targets (currently Cetus `router::swap` and '
            + 'Haedal `interface::request_stake`). Anything else falls through to dynamic '
            + 'resolution, which depends on `/introspect` and is therefore always 501 in this '
            + 'build (R15) — `/resolve` is only ever a 200 for the curated targets above.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['packageId', 'moduleName', 'functionName'],
                  properties: {
                    packageId: { type: 'string' },
                    moduleName: { type: 'string', example: 'router' },
                    functionName: { type: 'string', example: 'swap' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Semantic manifest (curated targets only)',
              content: {
                'application/json': {
                  schema: successEnvelope({ type: 'object' }),
                },
              },
            },
            '501': {
              description: 'Non-curated target — dynamic resolution needs /introspect, which is not implemented.',
              content: {
                'application/json': { schema: errorEnvelope },
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
                    useServerWallet: {
                      type: 'boolean',
                      description:
                        'Opt in to binding the operator-configured server wallet when no '
                        + '`agentWallet` is supplied (R13). Without this flag, a wallet-less '
                        + 'request never binds any wallet — funding falls back to `tx.gas`.',
                    },
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
                    useServerWallet: {
                      type: 'boolean',
                      description:
                        'Opt in to binding the operator-configured server wallet when no '
                        + '`agentWallet` is supplied (R13). Without this flag, a wallet-less '
                        + 'request never binds any wallet — funding falls back to `tx.gas`.',
                    },
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
      '/capabilities/preview': {
        post: {
          tags: ['Capabilities'],
          summary: 'Preview a CapabilityManifest\'s three projections before publishing',
          description:
            '(U7/R11) "See exactly what you\'re granting" before an owner attaches a manifest to a '
            + 'wallet. Read-only, pure projection — never signs, never touches a chain client, never '
            + 'persists anything. Returns the on-chain `add_rule`/`prove` params the compiler would '
            + 'assemble into a PTB, the signer\'s flat pre-flight policy shape, and the human/'
            + 'agent-readable declaration rendered into skill.md / agent-instructions elsewhere. '
            + 'An empty-rules or otherwise invalid manifest is rejected with 422 and the SDK\'s own '
            + 'honest message — a manifest with zero rules grants unlimited spend, which is unsafe, '
            + 'not a lenient default (KTD-6).',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['manifest'],
                  properties: { manifest: capabilityManifestSchema },
                },
                example: {
                  manifest: {
                    walletCoinType: '0x2::sui::SUI',
                    rules: [
                      { kind: 'budget', totalMist: '5000000000' },
                      { kind: 'rate_limit', windowMs: '3600000', maxMist: '1000000000' },
                      { kind: 'slippage_floor', minOutMist: '990000000' },
                    ],
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The manifest\'s three synchronized projections',
              content: {
                'application/json': {
                  schema: successEnvelope({
                    type: 'object',
                    required: ['onChainRules', 'signerPolicy', 'declaration'],
                    properties: {
                      onChainRules: { type: 'array', items: onChainRuleParamsSchema },
                      signerPolicy: signerPolicySchema,
                      declaration: capabilityDeclarationSchema,
                    },
                  }),
                },
              },
            },
            '422': {
              description:
                'Invalid, or empty-rules, manifest — rejected with the SDK\'s own validation '
                + 'message(s) (KTD-6); there is no honest "no restrictions" default.',
              content: {
                'application/json': { schema: errorEnvelope },
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
            '422': {
              description:
                'Refused — strict simulation failed, so no signable ExecutionEnvelope is returned '
                + '(R3/KTD-4, unconditional; no bypass field). `data` carries the refusal object '
                + '(`refused`, `actionId`, `reason`, `simulation`), not an envelope.',
              content: {
                'application/json': { schema: errorEnvelope },
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
            '404': {
              description:
                'Generic, sanitized error (R15) — covers "not found", oversized blob, malformed '
                + 'JSON, and schema-invalid content alike; no raw error detail is ever forwarded.',
              content: {
                'application/json': { schema: errorEnvelope },
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
