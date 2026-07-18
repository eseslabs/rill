import type { Transaction } from '@mysten/sui/transactions';
import { config } from '../../core/config';
import { ValidationError } from '../../core/errors';
import { parseU64String } from '../../../../packages/rill-sdk/src/amounts';
import { SUI_COIN_TYPE } from '../../core/agent-wallet';
import type { FlowNode } from './types';

/**
 * Parse a guardrail node's `minValue` config into a validated u64 bigint (defaulting to `0n` when
 * absent/empty). Routes through the SDK's `parseU64String` instead of a raw `BigInt(...)` so
 * malformed input (a decimal, a negative, garbage) throws `ValidationError` (-> 422) rather than
 * crashing the process with an uncaught `SyntaxError`/`RangeError` (R6).
 *
 * A result of `0n` (unset or explicitly zero) always pushes a "no protection enforced" warning —
 * a guardrail with no floor configured must never look enforced when it silently isn't (R1).
 */
export function resolveGuardrailMinValue(node: FlowNode, warnings: string[]): bigint {
  const raw = node.config?.minValue;
  let minValue: bigint;
  if (raw === undefined || raw === null || raw === '') {
    minValue = 0n;
  } else {
    try {
      minValue = parseU64String(String(raw), `Node ${node.id}: config.minValue`);
    } catch (err) {
      throw new ValidationError(err instanceof Error ? err.message : String(err));
    }
  }

  if (minValue <= 0n) {
    warnings.push(
      `Guardrail ${node.id} has no minimum value configured — no protection is enforced.`,
    );
  }

  return minValue;
}

/** Resolve a guardrail node's configured coin type (used only when it guards the root budget coin
 *  directly — a pass-through guardrail instead asserts each incoming coin's own, actual coin type). */
export function resolveGuardrailCoinType(node: FlowNode): string {
  return String(node.config?.coinType || SUI_COIN_TYPE);
}

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
