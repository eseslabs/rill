import { RUNTIME_KEYS } from '../../core/node-config';
import type { FlowGraph } from '../compiler/compiler.service';

export const HERO_ACTION_NAME = 'DeepBook limit order';
export const HERO_ACTION_DESCRIPTION = 'Build one wallet-bound DeepBook limit order for strict local execution.';

/** Node types that can be published as part of a composed flow. */
const SUPPORTED_ACTION_TYPES = new Set(Object.keys(RUNTIME_KEYS));
const WRAPPER_TYPES = new Set(['ptb', 'guardrail']);
const SUPPORTED_NODE_TYPES = new Set([...SUPPORTED_ACTION_TYPES, ...WRAPPER_TYPES]);

const RUNTIME_PARAM_DESCRIPTIONS: Record<string, string> = {
  amount_in: 'Amount of input coin to swap (mist).',
  min_amount_out: 'Minimum output amount (slippage floor, mist).',
  amount: 'Amount of SUI to stake (mist).',
  poolKey: 'Installed DeepBook pool key.',
  balanceManagerId: 'Run-specific pre-provisioned BalanceManager object ID.',
  tradeCapId: 'Run-specific delegated TradeCap object ID.',
  price: 'Limit price in human DeepBook units.',
  quantity: 'Base-asset quantity in human DeepBook units.',
  isBid: 'True for bid, false for ask.',
  payWithDeep: 'Whether fees are paid in DEEP.',
  clientOrderId: 'Unique run-specific u64 client order ID.',
  depositSui: 'SUI released by AgentWallet and deposited before order placement.',
};

export function isSupportedFlow(flow: FlowGraph): boolean {
  const unsupportedNodes = flow.nodes.filter((n) => !SUPPORTED_NODE_TYPES.has(n.type));
  const invalidEdge = flow.edges.some((e) => {
    if (e.source === e.target) return true;
    const srcType = flow.nodes.find((n) => n.id === e.source)?.type;
    const tgtType = flow.nodes.find((n) => n.id === e.target)?.type;
    if (!srcType || !tgtType) return true;
    return !SUPPORTED_NODE_TYPES.has(srcType) || !SUPPORTED_NODE_TYPES.has(tgtType);
  });
  const actionNodes = flow.nodes.filter((n) => SUPPORTED_ACTION_TYPES.has(n.type));
  return actionNodes.length > 0 && unsupportedNodes.length === 0 && !invalidEdge;
}

/**
 * @deprecated Kept for backward compatibility with any caller still using the old hero-flow check.
 * New code should use `isSupportedFlow`.
 */
export function isHeroActionFlow(flow: FlowGraph): boolean {
  return isSupportedFlow(flow);
}

export interface RuntimeParamDef {
  name: string;
  type: string;
  description: string;
}

export function getFlowRuntimeParams(flow: FlowGraph): RuntimeParamDef[] {
  const params: RuntimeParamDef[] = [];
  for (const node of flow.nodes) {
    const keys = RUNTIME_KEYS[node.type] ?? [];
    for (const key of keys) {
      params.push({
        name: key,
        type: key === 'isBid' || key === 'payWithDeep' ? 'boolean' : key === 'price' || key === 'quantity' || key === 'depositSui' ? 'number' : 'string',
        description: RUNTIME_PARAM_DESCRIPTIONS[key] ?? `Runtime parameter ${key}`,
      });
    }
  }
  return params;
}

export function buildRuntimeParamsSchema(flow?: FlowGraph) {
  const emptyProperties = {} as Record<string, { type: string; description: string }>;
  if (!flow) {
    return { type: 'object', properties: emptyProperties, additionalProperties: false };
  }
  const params = getFlowRuntimeParams(flow);
  const properties = params.reduce(
    (acc, p) => {
      acc[p.name] = { type: p.type, description: p.description };
      return acc;
    },
    {} as Record<string, { type: string; description: string }>,
  );
  return {
    type: 'object',
    properties,
    required: params.map((p) => p.name),
    additionalProperties: false,
  };
}

export function buildAgentWalletSchema() {
  return {
    type: 'object',
    properties: {
      packageId: { type: 'string', description: 'Published AgentWallet package ID.' },
      walletId: { type: 'string', description: 'Run-specific shared AgentWallet object ID.' },
      capId: { type: 'string', description: 'Run-specific AgentCap object ID held by the local signer.' },
      coinType: { type: 'string', description: 'AgentWallet coin type; defaults to 0x2::sui::SUI.' },
    },
    required: ['packageId', 'walletId', 'capId'],
    additionalProperties: false,
  };
}

export function buildActionInputSchema(actionId?: string, flow?: FlowGraph) {
  return {
    type: 'object',
    properties: {
      actionId: {
        type: 'string',
        ...(actionId ? { const: actionId } : {}),
        description: 'Published Rill action ID.',
      },
      sender: { type: 'string', description: 'Expected local signer Sui address; Rill never signs.' },
      agentWallet: buildAgentWalletSchema(),
      params: buildRuntimeParamsSchema(flow),
    },
    required: ['actionId', 'sender', 'agentWallet', 'params'],
    additionalProperties: false,
  };
}

export function buildToolDefs(flow: FlowGraph, actionId: string) {
  const nodeTypes = flow.nodes.map((n: { type: string }) => n.type).join(' → ');
  return {
    name: 'build_action' as const,
    description: `Execute composed Sui flow: ${nodeTypes}`,
    inputSchema: buildActionInputSchema(actionId, flow),
  };
}
