import { ValidationError } from './errors';
import { CETUS, HAEDAL, SUI_CLOCK_ID } from './protocols';
import type { FlowGraph, FlowNode } from '../features/protocols/types';

export interface CetusSwapNodeConfig {
  integratePackageId: string;
  globalConfigId: string;
  pool: string;
  inputCoinType: string;
  amount_in: string;
  min_amount_out: string;
  minSqrtPrice: string;
  maxSqrtPrice: string;
  by_amount_in?: boolean;
  sqrt_price_limit?: string;
}

export interface HaedalStakeNodeConfig {
  stakeTarget: string;
  suiSystemStateId: string;
  stakingObjectId: string;
  amount: string;
  validator?: string;
  minStakeMist: string;
}

export const RUNTIME_KEYS: Record<string, readonly string[]> = {
  cetus_swap: ['amount_in', 'min_amount_out'],
  haedal_stake: ['amount'],
  deepbook_limit_order: [
    'poolKey',
    'balanceManagerId',
    'tradeCapId',
    'price',
    'quantity',
    'isBid',
    'payWithDeep',
    'clientOrderId',
    'depositSui',
  ],
};

const FLOW_INPUT_KEYS: Record<string, readonly string[]> = {
  ...RUNTIME_KEYS,
  cetus_swap: [...RUNTIME_KEYS.cetus_swap, 'pool'],
};

function selectAllowedEntries(
  source: Record<string, unknown> | undefined,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!source || allowedKeys.length === 0) {
    return {};
  }

  return Object.fromEntries(Object.entries(source).filter(([key]) => allowedKeys.includes(key)));
}

function fallbackString(
  node: FlowNode,
  warnings: string[],
  key: string,
  fallbackValue: string,
): string {
  const value = pick(node, key);
  if (value == null || value === '') {
    warnings.push(`Node ${node.id}: config.${key} missing — using server default`);
    return fallbackValue;
  }

  return String(value);
}

function isTrueLike(value: unknown): boolean {
  return value === true || value === 'true';
}

export function resolveEffectiveFlow(
  flow: FlowGraph,
  runtimeParams: Record<string, unknown> = {},
): FlowGraph {
  const runtimeParamKeys = Object.keys(runtimeParams);

  for (const key of runtimeParamKeys) {
    const matchesFlow = flow.nodes.some((node) => RUNTIME_KEYS[node.type]?.includes(key));
    if (!matchesFlow) {
      throw new ValidationError(
        `Runtime parameter "${key}" does not match an allowed runtime key for any node in this flow.`,
      );
    }
  }

  for (const [nodeType, runtimeKeys] of Object.entries(RUNTIME_KEYS)) {
    if (!runtimeParamKeys.some((key) => runtimeKeys.includes(key))) continue;
    const matchingNodes = flow.nodes.filter((node) => node.type === nodeType).length;
    if (matchingNodes > 1) {
      throw new ValidationError(
        `Flat runtime params for "${nodeType}" require one matching node; found ${matchingNodes}.`,
      );
    }
  }

  return {
    edges: flow.edges.map((edge) => ({ ...edge })),
    nodes: flow.nodes.map((node) => {
      const runtimeKeys = RUNTIME_KEYS[node.type] ?? [];
      const flowInputKeys = FLOW_INPUT_KEYS[node.type] ?? [];

      return {
        ...node,
        config: {
          ...(node.config ?? {}),
          ...selectAllowedEntries(node.inputs, flowInputKeys),
          ...selectAllowedEntries(runtimeParams, runtimeKeys),
        },
        inputs: undefined,
      };
    }),
  };
}

function pick(node: FlowNode, key: string): unknown {
  return node.config?.[key];
}

/** Resolve Cetus swap params — FE should pass full config; server defaults are fallback only. */
export function resolveCetusSwapConfig(
  node: FlowNode,
): { config: CetusSwapNodeConfig; warnings: string[] } {
  const warnings: string[] = [];

  return {
    config: {
      integratePackageId: fallbackString(node, warnings, 'integratePackageId', CETUS.integratePackageId),
      globalConfigId: fallbackString(node, warnings, 'globalConfigId', CETUS.globalConfigId),
      pool: fallbackString(node, warnings, 'pool', CETUS.defaultPoolId),
      inputCoinType: fallbackString(node, warnings, 'inputCoinType', CETUS.defaultInputCoinType),
      amount_in: fallbackString(node, warnings, 'amount_in', '0'),
      min_amount_out: fallbackString(node, warnings, 'min_amount_out', '1'),
      minSqrtPrice: fallbackString(node, warnings, 'minSqrtPrice', CETUS.minSqrtPrice),
      maxSqrtPrice: fallbackString(node, warnings, 'maxSqrtPrice', CETUS.maxSqrtPrice),
      by_amount_in: pick(node, 'by_amount_in') !== false,
      sqrt_price_limit: pick(node, 'sqrt_price_limit') as string | undefined,
    },
    warnings,
  };
}

export function resolveHaedalStakeConfig(
  node: FlowNode,
): { config: HaedalStakeNodeConfig; warnings: string[] } {
  const warnings: string[] = [];

  return {
    config: {
      stakeTarget: fallbackString(node, warnings, 'stakeTarget', HAEDAL.stakeTarget),
      suiSystemStateId: fallbackString(node, warnings, 'suiSystemStateId', HAEDAL.suiSystemStateId),
      stakingObjectId: fallbackString(node, warnings, 'stakingObjectId', HAEDAL.stakingObjectId),
      amount: fallbackString(node, warnings, 'amount', '0'),
      validator: (pick(node, 'validator') as string | undefined) ?? '0x0',
      minStakeMist: fallbackString(node, warnings, 'minStakeMist', HAEDAL.minStakeMist.toString()),
    },
    warnings,
  };
}

export interface DeepbookOrderNodeConfig {
  /** Optional — when absent the order params aren't needed (the flow provisions a BalanceManager instead). */
  poolKey?: string;
  /** Optional — when absent, Rill provisions a BalanceManager (DeepBook account) in the PTB. */
  balanceManagerId?: string;
  tradeCapId?: string;
  price?: number;
  quantity?: number;
  isBid: boolean;
  payWithDeep: boolean;
  clientOrderId: string;
  /** SUI (human units) to deposit into the BalanceManager before placing the order (self-funding). 0 = none. */
  depositSui: number;
}

/**
 * Resolve DeepBook limit-order params. Nothing is required at this layer — when `balanceManagerId` is
 * absent the flow provisions a BalanceManager (and order params aren't needed); the adapter validates
 * order params only on the order path. This keeps simulate/compile from erroring before onboarding.
 */
export function resolveDeepbookOrderConfig(
  node: FlowNode,
): { config: DeepbookOrderNodeConfig; warnings: string[] } {
  const str = (key: string): string | undefined => {
    const v = pick(node, key);
    return v == null || v === '' ? undefined : String(v);
  };
  const num = (key: string): number | undefined => {
    const v = pick(node, key);
    return v == null || v === '' ? undefined : Number(v);
  };

  return {
    config: {
      poolKey: str('poolKey'),
      balanceManagerId: str('balanceManagerId'),
      tradeCapId: str('tradeCapId'),
      price: num('price'),
      quantity: num('quantity'),
      isBid: isTrueLike(pick(node, 'isBid')),
      payWithDeep: isTrueLike(pick(node, 'payWithDeep')),
      clientOrderId: String(pick(node, 'clientOrderId') ?? '1'),
      depositSui: Number(pick(node, 'depositSui') ?? 0) || 0,
    },
    warnings: [],
  };
}

export { SUI_CLOCK_ID };
