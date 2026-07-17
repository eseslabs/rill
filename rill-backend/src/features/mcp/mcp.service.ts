import { mainnetPackageIds, mainnetPools, testnetPackageIds, testnetPools } from '@mysten/deepbook-v3';
import { skillsStore, type PublishedSkill } from './skills.store';
import { skillRunnerService } from './skill-runner.service';
import { config } from '../../core/config';
import {
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
    description: 'Describe the DeepBook action parameters, wallet binding, targets, and strict simulation rule.',
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
const AGENT_WALLET_FIELDS = ['packageId', 'walletId', 'capId', 'coinType'] as const;

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

function readAgentWallet(value: unknown) {
  if (!isRecord(value)) {
    throw new Error('agentWallet public binding is required.');
  }

  assertOnlyFields(value, AGENT_WALLET_FIELDS, 'agentWallet');

  return {
    packageId: requireNonEmptyString(value.packageId, 'agentWallet.packageId is required.'),
    walletId: requireNonEmptyString(value.walletId, 'agentWallet.walletId is required.'),
    capId: requireNonEmptyString(value.capId, 'agentWallet.capId is required.'),
    coinType:
      value.coinType === undefined
        ? '0x2::sui::SUI'
        : requireNonEmptyString(value.coinType, 'agentWallet.coinType must be a non-empty string.'),
  };
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
  const id = body.id ?? null;
  const method = String(body.method ?? '');

  // Notifications (no `id`, e.g. notifications/initialized) get no JSON-RPC response.
  if (method.startsWith('notifications/') || id === null) {
    return null;
  }

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
        const deepbookPackageId = (
          config.network === 'testnet' ? testnetPackageIds : mainnetPackageIds
        ).DEEPBOOK_PACKAGE_ID;
        const defaultPoolKey = config.network === 'testnet' ? 'SUI_DBUSDC' : 'SUI_USDC';
        const defaultPoolId = (config.network === 'testnet' ? testnetPools : mainnetPools)[defaultPoolKey]?.address ?? '';
        return toolResult(id, {
          actionId: skill.id,
          name: skill.name,
          description: skill.description,
          network: config.network,
          runtimeParameters: skill.toolDefs.inputSchema.properties.params,
          agentWallet: skill.toolDefs.inputSchema.properties.agentWallet,
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
          walletPackageId,
          deepbookPackageId,
          defaultPoolKey,
          defaultPoolId,
          requiredTargets: [
            `${walletPackageId}::agent_wallet::spend`,
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
      case 'build_action':
        try {
          const build = readBuildActionArgs(args, skill.id);
          const data = await dependencies.runFlow(skill.flow, build.params, {
            actionId: skill.id,
            sender: build.sender,
            agentWallet: build.agentWallet,
          });
          return toolResult(id, data);
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
