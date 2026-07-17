import { suiClient } from '../../core/config';
import { CETUS } from '../../core/protocols';

export interface PoolTypeArgs {
  coinTypeA: string;
  coinTypeB: string;
}

/** Parse `Pool<T0, T1>` from on-chain pool object type. */
export async function resolvePoolTypeArgs(poolId: string): Promise<PoolTypeArgs> {
  const obj = await suiClient.getObject({ objectId: poolId });
  const poolType = obj.object.type;
  if (!poolType) {
    throw new Error(`Pool object ${poolId} not found on ${process.env.SUI_NETWORK || 'mainnet'}`);
  }

  const match = poolType.match(/Pool<([^,]+),\s*([^>]+)>/);
  if (!match) {
    throw new Error(`Cannot parse pool type: ${poolType}`);
  }

  return { coinTypeA: match[1].trim(), coinTypeB: match[2].trim() };
}

export interface SwapPlan {
  module: 'pool_script' | 'router';
  function: 'swap_a2b' | 'swap_b2a' | 'swap';
  typeArguments: [string, string];
  sqrtPriceLimit: string;
  /** true = coinTypeA → coinTypeB */
  a2b: boolean;
  /** output coin type after swap */
  outputCoinType: string;
}

/** swap_a2b = T0→T1, swap_b2a = T1→T0 */
export function pickSwapFunction(
  inputCoinType: string,
  pool: PoolTypeArgs,
  minSqrtPrice: string,
  maxSqrtPrice: string,
): SwapPlan {
  const a2b = inputCoinType === pool.coinTypeA;
  return {
    module: 'router',
    function: 'swap',
    typeArguments: [pool.coinTypeA, pool.coinTypeB],
    sqrtPriceLimit: a2b ? minSqrtPrice : maxSqrtPrice,
    a2b,
    outputCoinType: a2b ? pool.coinTypeB : pool.coinTypeA,
  };
}

export function pickSwapFunctionLegacy(inputCoinType: string, pool: PoolTypeArgs): SwapPlan {
  const a2b = inputCoinType === pool.coinTypeA;
  return {
    module: 'pool_script',
    function: a2b ? 'swap_a2b' : 'swap_b2a',
    typeArguments: [pool.coinTypeA, pool.coinTypeB],
    sqrtPriceLimit: a2b ? CETUS.minSqrtPrice : CETUS.maxSqrtPrice,
    a2b,
    outputCoinType: a2b ? pool.coinTypeB : pool.coinTypeA,
  };
}

/** Cetus CLMM devInspect hits stub package version check — real mainnet txs still succeed. */
export function isCetusDevInspectVersionAbort(error?: string): boolean {
  return Boolean(error?.includes('checked_package_version'));
}
