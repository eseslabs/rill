export {
  RillClient,
  type BuildActionInput,
  type CallSkillInput,
  type RillClientOptions,
} from './client';
export { RillApiError } from './errors';
export { assertExecutionEnvelope, digestUnsignedPtb } from './execution-envelope';
export { decimalToBaseUnits, parseU64String, U64_MAX } from './amounts';
export { findToken, TOKENS, type TokenInfo } from './tokens';
export {
  CapabilityManifestSchema,
  RULE_KINDS,
  toDeclaration,
  toOnChainRuleParams,
  toSignerPolicy,
  type AssetScopeRule,
  type BudgetRule,
  type CapabilityDeclaration,
  type CapabilityDeclarationCap,
  type CapabilityManifest,
  type CapabilityRule,
  type OnChainRuleConfigValue,
  type OnChainRuleParams,
  type PerTxRule,
  type ProtocolScopeRule,
  type RateLimitRule,
  type RecipientAllowlistRule,
  type RuleKind,
  type SignerPolicy,
  type SlippageFloorRule,
  type TimeWindowRule,
} from './capability-manifest';
export type {
  ActionToolDefinition,
  ActionToolName,
  AgentWalletBinding,
  ApiError,
  ApiResponse,
  ApiSuccess,
  DeepBookResolvedParams,
  ExecutionEnvelope,
  FlowEdge,
  FlowGraph,
  FlowNode,
  HealthInfo,
  IntrospectFunction,
  JsonSchema,
  McpToolCallResult,
  PublishResult,
  PublishedSkill,
  ResolvedManifest,
  RillNetwork,
  SimulationResult,
  SkillRunResult,
  StrictSimulationResult,
  ToolDef,
} from './types';

import type { FlowGraph } from './types';

/** Preset node types supported by the compiler today. */
export const NODE_TYPES = {
  CETUS_SWAP: 'cetus_swap',
  HAEDAL_STAKE: 'haedal_stake',
} as const;

/** Helper: single-node Haedal stake flow. */
export function haedalStakeFlow(amountMist: number | bigint, nodeId = 'h1'): FlowGraph {
  return {
    nodes: [{ id: nodeId, type: NODE_TYPES.HAEDAL_STAKE, inputs: { amount: Number(amountMist) } }],
    edges: [],
  };
}

/** Helper: single-node Cetus swap flow (mainnet). */
export function cetusSwapFlow(
  amountInMist: number | bigint,
  options: { minAmountOut?: number | bigint; pool?: string; inputCoinType?: string } = {},
  nodeId = 's1',
): FlowGraph {
  return {
    nodes: [
      {
        id: nodeId,
        type: NODE_TYPES.CETUS_SWAP,
        inputs: {
          amount_in: Number(amountInMist),
          min_amount_out: Number(options.minAmountOut ?? 0),
          ...(options.pool ? { pool: options.pool } : {}),
        },
        ...(options.inputCoinType ? { config: { inputCoinType: options.inputCoinType } } : {}),
      },
    ],
    edges: [],
  };
}
