import { mainnetPackageIds, mainnetPools, testnetPackageIds, testnetPools } from '@mysten/deepbook-v3';
import { skillsStore, type PublishedSkill } from './skills.store';
import { skillRunnerService } from './skill-runner.service';
import { config } from '../../core/config';
import { CETUS, HAEDAL, SUI_CLOCK_ID } from '../../core/protocols';
import { normalizeAgentWallet, type AgentWalletBinding } from '../../core/agent-wallet';
import type { CapabilityManifest } from '../../../../packages/rill-sdk/src/capability-manifest';
import {
  actionKindOf,
  buildActionInputSchema,
  HERO_ACTION_DESCRIPTION,
} from './tool-schema';

/** Protocol versions Rill speaks; echo the client's if known, else fall back to the latest. */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL_VERSION = '2025-03-26';

export const actionTools = [
  {
    name: 'list_actions',
    description: 'List actions available from this Rill endpoint. Returns build capability only; Rill never signs.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'describe_action',
    // Generic — this tool describes whatever action the published skill actually is (DeepBook,
    // Cetus swap, Haedal stake, or a swap→stake combo); it must not claim "DeepBook" for a skill
    // that isn't one.
    description: 'Describe the action\'s parameters, wallet binding, targets, and strict simulation rule.',
    inputSchema: {
      type: 'object',
      properties: { actionId: { type: 'string' } },
      required: ['actionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'build_action',
    description: HERO_ACTION_DESCRIPTION,
    inputSchema: buildActionInputSchema(),
  },
] as const;

const EMPTY_FIELDS: readonly string[] = [];
const ACTION_TOOL_NAMES: ReadonlySet<string> = new Set(actionTools.map((tool) => tool.name));
const BUILD_ACTION_FIELDS = ['actionId', 'sender', 'agentWallet', 'params'] as const;
const AGENT_WALLET_FIELDS = ['packageId', 'walletId', 'capId', 'coinType', 'capabilityManifest', 'versionId'] as const;

export interface McpDependencies {
  getSkill(id: string): PublishedSkill | undefined;
  runFlow: typeof skillRunnerService.runFlow;
}

const defaultDependencies: McpDependencies = {
  getSkill: (id) => skillsStore.get(id),
  runFlow: skillRunnerService.runFlow.bind(skillRunnerService),
};

function invalidParams(id: unknown, message: string) {
  return { jsonrpc: '2.0', id, error: { code: -32602, message } };
}

function toolResult(id: unknown, data: unknown, isError = false) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      structuredContent: data,
      isError,
    },
  };
}

function toolError(id: unknown, code: string, message: string) {
  return toolResult(id, { code, message }, true);
}

function assertOnlyFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`Unexpected ${label} field: ${unexpected}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(message);
  }
  return value.trim();
}

/**
 * Allow-listed field parsing PLUS resolution — `assertOnlyFields`/`requireNonEmptyString` below only
 * shape-check what the caller sent; `normalizeAgentWallet` (`core/agent-wallet.ts`, the SAME function
 * the HTTP `/compile`/`/simulate`/`/execute` routes use) is what actually resolves this call's binding
 * against the ONE agent_wallet package and enforces its `capabilityManifest`/`versionId` are present
 * — falling back to `AGENT_WALLET_PACKAGE_ID`/`AGENT_WALLET_VERSION_ID` when the caller omits its own
 * packageId/versionId. `packageId` is therefore no longer required to be present up front here — a
 * caller may omit it and let the server-configured package resolve automatically, exactly like the
 * HTTP path. A `capabilityManifest`-less binding is rejected there with a `ValidationError`.
 */
function readAgentWallet(value: unknown): AgentWalletBinding {
  if (!isRecord(value)) {
    throw new Error('agentWallet public binding is required.');
  }

  assertOnlyFields(value, AGENT_WALLET_FIELDS, 'agentWallet');

  return normalizeAgentWallet({
    packageId:
      value.packageId === undefined
        ? undefined
        : requireNonEmptyString(value.packageId, 'agentWallet.packageId must be a non-empty string.'),
    walletId: requireNonEmptyString(value.walletId, 'agentWallet.walletId is required.'),
    capId: requireNonEmptyString(value.capId, 'agentWallet.capId is required.'),
    coinType:
      value.coinType === undefined
        ? undefined
        : requireNonEmptyString(value.coinType, 'agentWallet.coinType must be a non-empty string.'),
    capabilityManifest: value.capabilityManifest as CapabilityManifest | undefined,
    versionId:
      value.versionId === undefined
        ? undefined
        : requireNonEmptyString(value.versionId, 'agentWallet.versionId must be a non-empty string.'),
  });
}

function readBuildActionArgs(args: Record<string, unknown>, skillId: string) {
  assertOnlyFields(args, BUILD_ACTION_FIELDS, 'build_action');

  if (args.actionId !== skillId) {
    throw new Error('Action is not available from this endpoint.');
  }

  const sender = requireNonEmptyString(args.sender, 'sender is required for keyless compilation.');
  const agentWallet = readAgentWallet(args.agentWallet);

  if (!isRecord(args.params)) {
    throw new Error('params must be an object.');
  }

  return {
    sender,
    agentWallet,
    params: args.params,
  };
}

/** `describe_action`'s AgentWallet PROVISIONING schema (budget/per-tx/expiry/clientOrderId) —
 *  action-agnostic: every action shares the same wallet-setup shape (`/setup/prepare` accepts
 *  `clientOrderId` regardless of the eventual action; it is simply unused by a flow that never
 *  places a DeepBook order). */
function describeActionSetupSchema() {
  return {
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
  };
}

/** `agent_wallet::request_spend`/`confirm_spend` — the one funding chokepoint every non-DeepBook
 *  action shares, regardless of how many action nodes the flow has. */
function agentWalletTargets(walletPackageId: string): string[] {
  return [
    `${walletPackageId}::agent_wallet::request_spend`,
    `${walletPackageId}::agent_wallet::confirm_spend`,
  ];
}

/** `AgentWallet`/`AgentCap` — the two required objects every non-DeepBook action shares. */
const COMMON_REQUIRED_OBJECTS = [
  { role: 'AgentWallet', source: 'agentWallet.walletId' },
  { role: 'AgentCap', source: 'agentWallet.capId' },
] as const;

const CLOCK_REQUIRED_OBJECT = { role: 'Clock', objectId: SUI_CLOCK_ID } as const;

/** The Cetus `router::swap` target, plus its mandatory on-chain slippage guard when one is
 *  configured — shared between the standalone-swap and swap→stake-combo `describe_action` shapes. */
function cetusSwapTarget(): string | undefined {
  return `${CETUS.integratePackageId}::router::swap`;
}
function cetusGuardTarget(): string | undefined {
  return config.guardPackageId ? `${config.guardPackageId}::guard::assert_min_value` : undefined;
}
function cetusRequiredPublicObjects() {
  return [{ role: 'CetusPool', source: "params.pool, defaulting to the published skill's pool" }];
}

/** The Haedal `interface::request_stake` target + its two fixed protocol objects — shared between
 *  the standalone-stake and swap→stake-combo `describe_action` shapes. */
function haedalRequiredPublicObjects() {
  return [
    { role: 'SuiSystemState', objectId: HAEDAL.suiSystemStateId },
    { role: 'HaedalStakingObject', objectId: HAEDAL.stakingObjectId },
  ];
}

/**
 * Honest, action-appropriate `describe_action` metadata (targets, required public objects, and any
 * action-specific defaults) — derived from `skill.flow` via `actionKindOf` (`tool-schema.ts`, the
 * SAME dispatch `skill-runner.service.ts`'s `runFlow` and `buildRuntimeParamsSchema` use), so a
 * Cetus swap skill is never described with DeepBook fields (BalanceManager/TradeCap/poolKey) and a
 * Haedal stake skill never claims a DeepBook pool. DeepBook's branch is byte-identical to what this
 * endpoint always returned; the standalone swap/stake branches build the exact same objects as
 * before (via the small helpers above) — only the NEW combo branch is additive.
 */
function describeActionMetadata(skill: PublishedSkill, walletPackageId: string) {
  const kind = actionKindOf(skill.flow);

  if (kind === 'cetus_swap') {
    const guardTarget = cetusGuardTarget();
    return {
      cetusPackageId: CETUS.integratePackageId,
      defaultPoolId: CETUS.defaultPoolId,
      requiredTargets: [
        ...agentWalletTargets(walletPackageId),
        cetusSwapTarget(),
        ...(guardTarget ? [guardTarget] : []),
      ],
      requiredPublicObjects: [...COMMON_REQUIRED_OBJECTS, ...cetusRequiredPublicObjects(), CLOCK_REQUIRED_OBJECT],
      requiredGuards: guardTarget ? [guardTarget] : [],
    };
  }

  if (kind === 'haedal_stake') {
    return {
      haedalPackageId: HAEDAL.packageId,
      requiredTargets: [...agentWalletTargets(walletPackageId), HAEDAL.stakeTarget],
      requiredPublicObjects: [...COMMON_REQUIRED_OBJECTS, ...haedalRequiredPublicObjects(), CLOCK_REQUIRED_OBJECT],
      requiredGuards: [],
    };
  }

  if (kind === 'cetus_swap_to_haedal_stake') {
    const guardTarget = cetusGuardTarget();
    return {
      cetusPackageId: CETUS.integratePackageId,
      defaultPoolId: CETUS.defaultPoolId,
      haedalPackageId: HAEDAL.packageId,
      requiredTargets: [
        ...agentWalletTargets(walletPackageId),
        cetusSwapTarget(),
        ...(guardTarget ? [guardTarget] : []),
        HAEDAL.stakeTarget,
      ],
      requiredPublicObjects: [
        ...COMMON_REQUIRED_OBJECTS,
        ...cetusRequiredPublicObjects(),
        ...haedalRequiredPublicObjects(),
        CLOCK_REQUIRED_OBJECT,
      ],
      requiredGuards: guardTarget ? [guardTarget] : [],
    };
  }

  const deepbookPackageId = (
    config.network === 'testnet' ? testnetPackageIds : mainnetPackageIds
  ).DEEPBOOK_PACKAGE_ID;
  const defaultPoolKey = config.network === 'testnet' ? 'SUI_DBUSDC' : 'SUI_USDC';
  const defaultPoolId = (config.network === 'testnet' ? testnetPools : mainnetPools)[defaultPoolKey]?.address ?? '';
  return {
    deepbookPackageId,
    defaultPoolKey,
    defaultPoolId,
    // There is ONE agent_wallet package now (the manifest-gated Rule + Hot Potato design) — a
    // compiled build_action PTB always calls request_spend/confirm_spend, never the retired
    // legacy spend(). (Any per-manifest-rule `prove` calls aren't listed here: this discovery
    // response can't know the caller's capability manifest ahead of time.)
    requiredTargets: [
      ...agentWalletTargets(walletPackageId),
      `${deepbookPackageId}::balance_manager::deposit`,
      `${deepbookPackageId}::balance_manager::generate_proof_as_trader`,
      `${deepbookPackageId}::pool::place_limit_order`,
    ],
    requiredPublicObjects: [
      ...COMMON_REQUIRED_OBJECTS,
      { role: 'BalanceManager', source: 'params.balanceManagerId' },
      { role: 'TradeCap', source: 'params.tradeCapId' },
      { role: 'DeepBookPool', source: 'params.poolKey resolved on the selected network' },
      CLOCK_REQUIRED_OBJECT,
    ],
    requiredGuards: [],
  };
}

function containsField(value: unknown, names: ReadonlySet<string>): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => containsField(item, names));
  return Object.entries(value).some(([key, nested]) =>
    names.has(key.replace(/[^a-z]/gi, '').toLowerCase()) || containsField(nested, names)
  );
}

export function assertKeylessToolArguments(args: Record<string, unknown>): void {
  if (containsField(args, new Set(['execute', 'force', 'forceexecute']))) {
    throw new Error('Hosted execution is forbidden; request an ExecutionEnvelope and sign locally.');
  }
  if (containsField(args, new Set(['privatekey', 'secretkey', 'suiprivatekey', 'rillsuiprivatekey', 'mnemonic', 'keypair']))) {
    throw new Error('Private key fields are forbidden; Rill Cloud accepts public object IDs only.');
  }
}

/**
 * MCP JSON-RPC handler — compatible with the official MCP SDK's Streamable HTTP transport, so the
 * same endpoint works for Thiny (`mcpHttpPlugin`), Claude Code (`--transport http`), and OpenCode
 * (remote MCP). Returns `null` for notifications (the caller replies HTTP 202 with no body, per spec).
 */
export async function handleMcpJsonRpc(
  skillId: string,
  body: Record<string, unknown>,
  dependencies: McpDependencies = defaultDependencies,
): Promise<Record<string, unknown> | null> {
  // Defense in depth for batch entries (R14): a JSON-RPC batch may contain a non-object element
  // (e.g. a bare string/number) even though the type signature promises `Record<string, unknown>`
  // — the caller (`api.routes.ts`'s `/mcp/:skillId`) maps raw parsed-JSON array elements straight
  // into this function.
  if (!isRecord(body)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: expected a JSON-RPC request object.' } };
  }

  const method = String(body.method ?? '');
  // A Notification is identified by its *method* namespace (e.g. `notifications/initialized`), not
  // by a missing `id` — those are two different spec concepts (R14). Notifications get no response.
  const isNotification = method.startsWith('notifications/');
  if (isNotification) {
    return null;
  }

  // A non-notification request MUST carry an `id` so the caller can correlate the response. The
  // previous `body.id ?? null` conflated "no id" with "notification", silently swallowing id-less
  // requests as 202-with-no-body instead of reporting the spec violation (R14).
  const hasId = Object.prototype.hasOwnProperty.call(body, 'id');
  if (!hasId) {
    return {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request: "id" is required for a non-notification request.' },
    };
  }
  const id = body.id ?? null;

  const skill = dependencies.getSkill(skillId);
  if (!skill) {
    return invalidParams(id, 'Skill not found');
  }

  if (method === 'initialize') {
    const requested = (body.params as { protocolVersion?: string } | undefined)?.protocolVersion;
    const protocolVersion =
      requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: {
          name: 'rill-actions',
          version: '1.0.0',
          description: 'Keyless action builder — returns an ExecutionEnvelope for local signing.',
        },
      },
    };
  }

  // MCP liveness check.
  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: [actionTools[0], actionTools[1], skill.toolDefs],
      },
    };
  }

  if (method === 'tools/call') {
    if (!body.params || typeof body.params !== 'object' || Array.isArray(body.params)) {
      return invalidParams(id, 'tools/call requires params.');
    }
    const params = body.params as { name?: unknown; arguments?: unknown };
    if (typeof params.name !== 'string') return invalidParams(id, 'tools/call requires a tool name.');
    if (
      params.arguments !== undefined &&
      (!params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments))
    ) {
      return invalidParams(id, 'Tool arguments must be an object.');
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (!ACTION_TOOL_NAMES.has(params.name)) {
      return invalidParams(id, `Unknown tool: ${params.name}`);
    }
    try {
      assertKeylessToolArguments(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError(id, 'forbidden_arguments', message);
    }
    switch (params.name) {
      case 'list_actions':
        try {
          assertOnlyFields(args, EMPTY_FIELDS, 'list_actions');
        } catch (error) {
          return toolError(id, 'invalid_arguments', error instanceof Error ? error.message : String(error));
        }
        return toolResult(id, [{
          actionId: skill.id,
          name: skill.name,
          description: skill.description,
          walletBound: true,
          network: config.network,
        }]);
      case 'describe_action':
        try {
          assertOnlyFields(args, ['actionId'], 'describe_action');
        } catch (error) {
          return toolError(id, 'invalid_arguments', error instanceof Error ? error.message : String(error));
        }
        if (args.actionId !== skill.id) {
          return toolError(id, 'action_unavailable', 'Action is not available from this endpoint.');
        }
        const walletPackageId = config.agentWallet?.packageId ?? '<agentWallet.packageId>';
        return toolResult(id, {
          actionId: skill.id,
          name: skill.name,
          description: skill.description,
          network: config.network,
          runtimeParameters: skill.toolDefs.inputSchema.properties.params,
          agentWallet: skill.toolDefs.inputSchema.properties.agentWallet,
          requiresSetup: true,
          setupSchema: describeActionSetupSchema(),
          walletPackageId,
          ...describeActionMetadata(skill, walletPackageId),
          simulationRule: 'Rill Cloud and rill-wallet both require a verified successful simulation.',
          signingRule: 'Only local rill-wallet.execute_rill_action may validate, re-simulate, sign, and submit.',
        });
      case 'build_action':
        try {
          const build = readBuildActionArgs(args, skill.id);
          const data = await dependencies.runFlow(skill.flow, build.params, {
            actionId: skill.id,
            sender: build.sender,
            agentWallet: build.agentWallet,
          });
          // `runFlow` returns a structured refusal (not an ExecutionEnvelope) instead of throwing
          // when strict simulation failed (R3/KTD-4) — surface it as an MCP tool error so an agent
          // client can't mistake `structuredContent` for something signable.
          const isRefusal = 'refused' in data && data.refused === true;
          return toolResult(id, data, isRefusal);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return toolError(id, 'build_rejected', message);
        }
      default:
        return invalidParams(id, `Unknown tool: ${String(params.name)}`);
    }
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}
