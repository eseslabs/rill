import type { Transaction } from '@mysten/sui/transactions';
import { config } from '../../core/config';

/**
 * Injects the on-chain slippage floor: `rill_guard::assert_min_value(outputCoin, minOut)`.
 *
 * Universal — any swap adapter (Cetus, DeepBook, …) calls this on its output coin so an agent can
 * never accept a worse-than-`minOut` fill. The assert borrows the coin, so it stays usable downstream.
 * No-op when `minOut <= 0` (no floor requested); warns (doesn't silently pass) if the guard package
 * isn't configured, so a missing floor is never mistaken for an enforced one.
 */
export function injectMinOutAssert(
  tx: Transaction,
  coin: unknown,
  coinType: string,
  minOut: bigint,
  warnings: string[],
): void {
  if (minOut <= 0n) return;
  const pkg = config.guardPackageId;
  if (!pkg) {
    warnings.push(
      `min_amount_out=${minOut} requested but RILL_GUARD_PACKAGE_ID is not set — slippage floor NOT enforced on-chain.`,
    );
    return;
  }
  tx.moveCall({
    target: `${pkg}::guard::assert_min_value`,
    typeArguments: [coinType],
    arguments: [coin as never, tx.pure.u64(minOut)],
  });
}
