import { CETUS, HAEDAL, SUI_CLOCK_ID } from './protocols';

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

function pick(node: { config?: Record<string, unknown>; inputs?: Record<string, unknown> }, key: string): unknown {
  return node.config?.[key] ?? node.inputs?.[key];
}

/** Resolve Cetus swap params — FE should pass full config; server defaults are fallback only. */
export function resolveCetusSwapConfig(
  node: { id: string; config?: Record<string, unknown>; inputs?: Record<string, unknown> },
): { config: CetusSwapNodeConfig; warnings: string[] } {
  const warnings: string[] = [];
  const fallback = (key: string, value: string) => {
    const v = pick(node, key);
    if (v == null || v === '') {
      warnings.push(`Node ${node.id}: config.${key} missing — using server default`);
      return value;
    }
    return String(v);
  };

  return {
    config: {
      integratePackageId: fallback('integratePackageId', CETUS.integratePackageId),
      globalConfigId: fallback('globalConfigId', CETUS.globalConfigId),
      pool: fallback('pool', CETUS.defaultPoolId),
      inputCoinType: fallback('inputCoinType', CETUS.defaultInputCoinType),
      amount_in: fallback('amount_in', '0'),
      min_amount_out: fallback('min_amount_out', '1'),
      minSqrtPrice: fallback('minSqrtPrice', CETUS.minSqrtPrice),
      maxSqrtPrice: fallback('maxSqrtPrice', CETUS.maxSqrtPrice),
      by_amount_in: pick(node, 'by_amount_in') !== false,
      sqrt_price_limit: pick(node, 'sqrt_price_limit') as string | undefined,
    },
    warnings,
  };
}

export function resolveHaedalStakeConfig(
  node: { id: string; config?: Record<string, unknown>; inputs?: Record<string, unknown> },
): { config: HaedalStakeNodeConfig; warnings: string[] } {
  const warnings: string[] = [];
  const fallback = (key: string, value: string) => {
    const v = pick(node, key);
    if (v == null || v === '') {
      warnings.push(`Node ${node.id}: config.${key} missing — using server default`);
      return value;
    }
    return String(v);
  };

  return {
    config: {
      stakeTarget: fallback('stakeTarget', HAEDAL.stakeTarget),
      suiSystemStateId: fallback('suiSystemStateId', HAEDAL.suiSystemStateId),
      stakingObjectId: fallback('stakingObjectId', HAEDAL.stakingObjectId),
      amount: fallback('amount', '0'),
      validator: (pick(node, 'validator') as string | undefined) ?? '0x0',
      minStakeMist: fallback('minStakeMist', HAEDAL.minStakeMist.toString()),
    },
    warnings,
  };
}

export interface DeepbookOrderNodeConfig {
  poolKey: string;
  balanceManagerId: string;
  tradeCapId?: string;
  price: number;
  quantity: number;
  isBid: boolean;
  payWithDeep: boolean;
  clientOrderId: string;
  /** SUI (human units) to deposit into the BalanceManager before placing the order (self-funding). 0 = none. */
  depositSui: number;
}

/** Resolve DeepBook limit-order params — FE/agent supplies them; the BalanceManager is pre-funded (onboarding). */
export function resolveDeepbookOrderConfig(
  node: { id: string; config?: Record<string, unknown>; inputs?: Record<string, unknown> },
): { config: DeepbookOrderNodeConfig; warnings: string[] } {
  const warnings: string[] = [];
  const req = (key: string): string => {
    const v = pick(node, key);
    if (v == null || v === '') throw new Error(`Node ${node.id}: DeepBook config.${key} is required.`);
    return String(v);
  };

  return {
    config: {
      poolKey: req('poolKey'),
      balanceManagerId: req('balanceManagerId'),
      tradeCapId: (pick(node, 'tradeCapId') as string | undefined) || undefined,
      price: Number(req('price')),
      quantity: Number(req('quantity')),
      isBid: pick(node, 'isBid') === true || pick(node, 'isBid') === 'true',
      payWithDeep: pick(node, 'payWithDeep') === true || pick(node, 'payWithDeep') === 'true',
      clientOrderId: String(pick(node, 'clientOrderId') ?? '1'),
      depositSui: Number(pick(node, 'depositSui') ?? 0) || 0,
    },
    warnings,
  };
}

export { SUI_CLOCK_ID };
