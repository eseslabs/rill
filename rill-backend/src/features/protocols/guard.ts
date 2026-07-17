import type { Transaction } from '@mysten/sui/transactions';
import { config } from '../../core/config';
import { ValidationError } from '../../core/errors';

/**
 * Injects the on-chain slippage floor: `rill_guard::assert_min_value(outputCoin, minOut)`.
 *
 * Universal — any swap adapter (Cetus, DeepBook, …) calls this on its output coin so an agent can
 * never accept a worse-than-`minOut` fill. The assert borrows the coin, so it stays usable downstream.
 * No-op when `minOut <= 0` (no floor requested); fails closed when the guard package is absent.
 */
export function injectMinOutAssert(
  tx: Transaction,
  coin: unknown,
  coinType: string,
  minOut: bigint,
  warnings: string[],
  guardPackageId: string | undefined = config.guardPackageId,
): void {
  if (minOut <= 0n) return;
  if (!guardPackageId) {
    throw new ValidationError(
      `RILL_GUARD_PACKAGE_ID is required when min_amount_out=${minOut}; refusing an unguarded PTB.`,
    );
  }
  tx.moveCall({
    target: `${guardPackageId}::guard::assert_min_value`,
    typeArguments: [coinType],
    arguments: [coin as never, tx.pure.u64(minOut)],
  });
}
