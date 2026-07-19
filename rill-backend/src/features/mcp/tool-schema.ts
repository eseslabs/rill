import type { FlowGraph } from '../compiler/compiler.service';

export const HERO_ACTION_NAME = 'DeepBook limit order';
export const HERO_ACTION_DESCRIPTION = 'Build one wallet-bound DeepBook limit order for strict local execution.';

/**
 * Human-facing name/description for a published skill, derived from the flow's action nodes — so a
 * published Cetus swap is called "Cetus swap", not the old hardcoded "DeepBook limit order". The
 * MCP `build_action` compiles the actual `skill.flow` regardless of type (same path `/simulate`
 * proves works for all three), so publishing any supported flow yields a working endpoint; this just
 * labels it honestly. DeepBook stays the canonical single-order hero.
 */
export function heroActionOf(flow: FlowGraph): { name: string; description: string } {
  const types = new Set(flow.nodes.map((n) => n.type));
  const hasSwap = types.has('cetus_swap');
  const hasStake = types.has('haedal_stake');
  if (hasSwap && hasStake) {
    return {
      name: 'Cetus swap → Haedal stake',
      description: 'Build one wallet-bound Cetus swap chained into a Haedal stake for strict local execution.',
    };
  }
  if (hasSwap) {
    return { name: 'Cetus swap', description: 'Build one wallet-bound Cetus swap for strict local execution.' };
  }
  if (hasStake) {
    return { name: 'Haedal stake', description: 'Build one wallet-bound Haedal stake for strict local execution.' };
  }
  if (types.has('deepbook_limit_order')) {
    return { name: HERO_ACTION_NAME, description: HERO_ACTION_DESCRIPTION };
  }
  return { name: 'Rill flow', description: 'Build one wallet-bound Rill action for strict local execution.' };
}

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

export type ActionKind = 'cetus_swap' | 'haedal_stake' | 'deepbook_limit_order';

/**
 * Which action a flow's `build_action` runtime params (and, in `mcp.service.ts`, `describe_action`
 * metadata) should be shaped for. Only an UNAMBIGUOUS single-action flow (one `cetus_swap` and no
 * `haedal_stake`, or vice versa) gets its own action-specific shape — every other combination
 * (DeepBook, a chained swap→stake, an empty/unknown flow, or no flow at all) keeps the long-standing
 * DeepBook shape, matching what `buildRuntimeParamsSchema()`'s no-argument call already returned
 * before this function learned about flows at all (the static `actionTools[2]` catalog entry in
 * `mcp.service.ts` still calls it with no flow, and must keep seeing the same shape it always has).
 * This mirrors `skill-runner.service.ts`'s `runFlow` dispatch (exactly one supported action node —
 * a single `cetus_swap` or `haedal_stake` — takes the generic path; everything else, including a
 * combo flow, falls back to/through the DeepBook shape here for describe/schema purposes even
 * though `runFlow` itself would reject a combo flow at build time).
 */
export function actionKindOf(flow?: FlowGraph): ActionKind {
  if (!flow) return 'deepbook_limit_order';
  const types = new Set(flow.nodes.map((n) => n.type));
  const hasSwap = types.has('cetus_swap');
  const hasStake = types.has('haedal_stake');
  if (hasSwap && !hasStake) return 'cetus_swap';
  if (hasStake && !hasSwap) return 'haedal_stake';
  return 'deepbook_limit_order';
}

/**
 * Common return shape for every `build*RuntimeParamsSchema` helper below — widened to a
 * `Record<string, ...>` (rather than each helper's own literal object type) so
 * `buildRuntimeParamsSchema`'s return type is ONE shape, not a union of three incompatible literal
 * types. Callers that read a specific action's params off a flow they already know the shape of
 * (e.g. tests) can still index by name; nothing here narrows away a real property.
 */
interface RuntimeParamsSchema {
  type: 'object';
  properties: Record<string, { type: string; description: string }>;
  required: string[];
  additionalProperties: false;
}

function buildDeepbookRuntimeParamsSchema(): RuntimeParamsSchema {
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

function buildCetusSwapRuntimeParamsSchema(): RuntimeParamsSchema {
  const properties = {
    amount_in: {
      type: 'string',
      description: 'Amount to swap, in the input coin\'s base units (e.g. mist for SUI).',
    },
    min_amount_out: {
      type: 'string',
      description: 'Minimum acceptable output, in the output coin\'s base units — the on-chain '
        + 'slippage floor asserted by rill_guard.',
    },
    pool: {
      type: 'string',
      description: 'Optional Cetus pool object ID override; the published skill\'s own pool is used '
        + 'when omitted.',
    },
  };
  return {
    type: 'object',
    properties,
    required: ['amount_in', 'min_amount_out'],
    additionalProperties: false,
  };
}

function buildHaedalStakeRuntimeParamsSchema(): RuntimeParamsSchema {
  const properties = {
    amount: { type: 'string', description: 'Amount of SUI to stake, in mist.' },
  };
  return {
    type: 'object',
    properties,
    required: ['amount'],
    additionalProperties: false,
  };
}

/**
 * Runtime `params` schema for `build_action`, shaped for the action the flow actually contains
 * (U-restore: this regressed to DeepBook-only when the keyless refactor narrowed `runFlow` to
 * DeepBook — the compiler always supported Cetus swap / Haedal stake, only the MCP-facing schema
 * had fallen behind). `flow` is optional so every existing no-flow call site (the static
 * `actionTools[2]` catalog entry) keeps getting the DeepBook shape it always has.
 */
export function buildRuntimeParamsSchema(flow?: FlowGraph): RuntimeParamsSchema {
  const action = actionKindOf(flow);
  if (action === 'cetus_swap') return buildCetusSwapRuntimeParamsSchema();
  if (action === 'haedal_stake') return buildHaedalStakeRuntimeParamsSchema();
  return buildDeepbookRuntimeParamsSchema();
}

export function buildAgentWalletSchema() {
  return {
    type: 'object',
    properties: {
      packageId: { type: 'string', description: 'Published AgentWallet package ID.' },
      walletId: { type: 'string', description: 'Run-specific shared AgentWallet object ID.' },
      capId: { type: 'string', description: 'Run-specific AgentCap object ID held by the local signer.' },
      coinType: { type: 'string', description: 'AgentWallet coin type; defaults to 0x2::sui::SUI.' },
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
  return {
    name: 'build_action' as const,
    description: HERO_ACTION_DESCRIPTION,
    inputSchema: buildActionInputSchema(actionId, flow),
  };
}
