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

export { SUI_CLOCK_ID };
