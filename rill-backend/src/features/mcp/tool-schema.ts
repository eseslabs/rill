import type { FlowGraph } from '../compiler/compiler.service';

export const HERO_ACTION_NAME = 'DeepBook limit order';
export const HERO_ACTION_DESCRIPTION = 'Build one wallet-bound DeepBook limit order for strict local execution.';

export function isHeroActionFlow(flow: FlowGraph): boolean {
  const allowedWrappers = new Set(['ptb', 'guardrail']);
  const orderNodes = flow.nodes.filter((n) => n.type === 'deepbook_limit_order');
  const unsupportedNodes = flow.nodes.filter(
    (n) => n.type !== 'deepbook_limit_order' && !allowedWrappers.has(n.type),
  );
  const invalidEdge = flow.edges.some((e) => {
    if (e.source === e.target) return true;
    const srcType = flow.nodes.find((n) => n.id === e.source)?.type;
    const tgtType = flow.nodes.find((n) => n.id === e.target)?.type;
    if (!srcType || !tgtType) return true;
    const srcAllowed = allowedWrappers.has(srcType);
    const tgtAllowed = allowedWrappers.has(tgtType);
    return !srcAllowed && !tgtAllowed;
  });
  return orderNodes.length === 1 && unsupportedNodes.length === 0 && !invalidEdge;
}

export function buildRuntimeParamsSchema() {
  const properties = {
    poolKey: { type: 'string', description: 'Installed DeepBook pool key.' },
    balanceManagerId: { type: 'string', description: 'Run-specific pre-provisioned BalanceManager object ID.' },
    tradeCapId: { type: 'string', description: 'Run-specific delegated TradeCap object ID.' },
    price: { type: 'number', description: 'Limit price in human DeepBook units.' },
    quantity: { type: 'number', description: 'Base-asset quantity in human DeepBook units.' },
    isBid: { type: 'boolean', description: 'True for bid, false for ask.' },
    payWithDeep: { type: 'boolean', description: 'Whether fees are paid in DEEP.' },
    clientOrderId: { type: 'string', description: 'Unique run-specific u64 client order ID.' },
    depositSui: { type: 'number', description: 'SUI released by AgentWallet and deposited before order placement.' },
  };
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
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
      // F7: opts this call into the redesigned Rule + Hot Potato agent_wallet package
      // (request_spend/confirm_spend) instead of the legacy spend() call — see
      // `core/agent-wallet.ts`'s `normalizeAgentWallet`. Both remain optional and absent by
      // default, so an MCP caller that never mentions them keeps building the live v2 spend().
      capabilityManifest: {
        type: 'object',
        additionalProperties: true,
        description: 'Wallet-level CapabilityManifest (rules[]) — when set, builds the redesigned '
          + 'request_spend/prove/confirm_spend sequence instead of the legacy spend() call.',
      },
      versionId: {
        type: 'string',
        description: 'Shared agent_wallet Version object ID — required alongside capabilityManifest '
          + 'unless AGENT_WALLET_VERSION_ID is configured on the server.',
      },
    },
    required: ['packageId', 'walletId', 'capId'],
    additionalProperties: false,
  };
}

export function buildActionInputSchema(actionId?: string) {
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
      params: buildRuntimeParamsSchema(),
    },
    required: ['actionId', 'sender', 'agentWallet', 'params'],
    additionalProperties: false,
  };
}

export function buildToolDefs(_flow: FlowGraph, actionId: string) {
  return {
    name: 'build_action' as const,
    description: HERO_ACTION_DESCRIPTION,
    inputSchema: buildActionInputSchema(actionId),
  };
}
