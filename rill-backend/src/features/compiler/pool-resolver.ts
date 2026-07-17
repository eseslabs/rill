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

/**
 * Cetus CLMM devInspect hits a stub package-version check (`checked_package_version`) that real
 * mainnet transactions don't — that's the ONE known false-abort devInspect produces, so the
 * `/simulate` classifier reports it as `verification: 'unverified'` instead of a hard failure.
 *
 * R3: matches the Cetus package id + the `checked_package_version` context together, not a bare
 * substring — an unrelated abort from some other package that happens to mention
 * "checked_package_version" in its own error text (e.g. a lookalike/malicious devInspect response,
 * or a different protocol with a similarly-named guard) must NOT be misclassified as this specific,
 * known-safe Cetus quirk. All three network-specific Cetus package ids are checked because the
 * version guard can be raised from the CLMM package, the legacy script package, or the integrate
 * package depending on which module the abort unwound through.
 */
const CETUS_VERSION_CHECK_PACKAGE_IDS = [
  CETUS.integratePackageId,
  CETUS.clmmPackageId,
  CETUS.scriptPackageId,
];

export function isCetusDevInspectVersionAbort(error?: string): boolean {
  if (!error || !error.includes('checked_package_version')) return false;
  return CETUS_VERSION_CHECK_PACKAGE_IDS.some((packageId) => error.includes(packageId));
}
