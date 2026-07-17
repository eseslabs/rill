import { suiClient } from '../../core/config';
import { ValidationError } from '../../core/errors';
import type { FlowGraph } from '../protocols/types';
import { resolvePoolTypeArgs } from './pool-resolver';

const Q64 = 64n;
const FEE_DENOM = 1_000_000n; // Cetus fee_rate is in millionths
const BPS_DENOM = 10_000n;

/**
 * Expected raw output for a CLMM swap, from the pool's current sqrt price.
 *
 * Cetus stores `current_sqrt_price` as Q64.64 over *raw* token amounts, so
 * price = (sqrt_price / 2^64)^2 = amount_b_raw / amount_a_raw, and no decimal
 * adjustment is needed. All arithmetic is exact BigInt — never floats, which
 * would silently round a money value.
 *
 * Ignores price impact and tick crossing: this is the spot rate, not a simulation.
 * Real output is <= this for any non-zero trade, so a floor derived from it errs
 * toward reverting rather than toward under-protecting.
 */
export function expectedOutFromSqrtPrice(
  amountIn: bigint,
  sqrtPriceX64: bigint,
  a2b: boolean,
  feeRate: bigint,
): bigint {
  if (amountIn <= 0n) throw new ValidationError('amountIn must be positive');
  if (sqrtPriceX64 <= 0n) throw new ValidationError('pool sqrt price must be positive');
  if (feeRate < 0n || feeRate >= FEE_DENOM) {
    throw new ValidationError(`pool fee_rate ${feeRate} is out of range (0..999999 millionths)`);
  }

  const gross = a2b
    ? (amountIn * sqrtPriceX64 * sqrtPriceX64) >> (Q64 * 2n)
    : (amountIn << (Q64 * 2n)) / (sqrtPriceX64 * sqrtPriceX64);

  return (gross * (FEE_DENOM - feeRate)) / FEE_DENOM;
}

/** The on-chain floor: expected output minus the caller's slippage tolerance. */
export function applySlippage(expectedOut: bigint, slippageBps: bigint): bigint {
  if (slippageBps < 0n || slippageBps >= BPS_DENOM) {
    throw new ValidationError(
      `slippageBps must be between 0 and 9999; ${slippageBps} would leave no floor at all.`,
    );
  }
  return (expectedOut * (BPS_DENOM - slippageBps)) / BPS_DENOM;
}

export interface Quote {
  expectedOut: string;
  minAmountOut: string;
  sqrtPriceX64: string;
  feeRate: string;
  /** Always true: this is a spot quote, not a simulation. Surface it to the caller. */
  ignoresPriceImpact: true;
  note: string;
}

export const SPOT_QUOTE_NOTE =
  'Spot-price quote from pool state; ignores price impact and tick crossing. ' +
  'On a thin pool the real fill is lower, so this floor may revert the swap. That is fail-closed.';

export class QuoteService {
  /** Reads pool state directly — no devInspect, so it works where Cetus simulation aborts. */
  async quoteCetus(
    poolId: string,
    amountIn: bigint,
    a2b: boolean,
    slippageBps: bigint,
  ): Promise<Quote> {
    // `include: { json: true }` is the gRPC client's decoded Move struct. The SDK warns the JSON
    // shape can vary by API implementation, so every field read below is validated rather than
    // trusted — a missing/renamed field must fail the quote, never silently quote zero.
    let json: Record<string, unknown> | null | undefined;
    try {
      const res = await suiClient.getObject({ objectId: poolId, include: { json: true } });
      json = res.object?.json as Record<string, unknown> | null | undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ValidationError(`Could not read pool ${poolId} from chain: ${message}`);
    }

    if (!json) {
      throw new ValidationError(`Pool ${poolId} not found or has no readable Move struct content.`);
    }

    const sqrtRaw = json.current_sqrt_price;
    const feeRaw = json.fee_rate;
    if (sqrtRaw == null || feeRaw == null) {
      throw new ValidationError(
        `Pool ${poolId} has no current_sqrt_price/fee_rate; it may not be a Cetus CLMM pool.`,
      );
    }

    // A paused pool cannot fill at all; quoting one would hand back a floor for a swap that
    // can never execute.
    if (json.is_pause === true) {
      throw new ValidationError(`Pool ${poolId} is paused; refusing to quote a swap that cannot fill.`);
    }

    const sqrtPriceX64 = BigInt(String(sqrtRaw));
    const feeRate = BigInt(String(feeRaw));
    const expectedOut = expectedOutFromSqrtPrice(amountIn, sqrtPriceX64, a2b, feeRate);
    const minAmountOut = applySlippage(expectedOut, slippageBps);

    return {
      expectedOut: expectedOut.toString(),
      minAmountOut: minAmountOut.toString(),
      sqrtPriceX64: sqrtPriceX64.toString(),
      feeRate: feeRate.toString(),
      ignoresPriceImpact: true,
      note: SPOT_QUOTE_NOTE,
    };
  }
}

export const quoteService = new QuoteService();

/**
 * Derive `min_amount_out` for every `cetus_swap` node that declares a `slippageBps` tolerance
 * but no explicit floor. Runs at compile time, deliberately.
 *
 * Slippage tolerance is the durable intent worth saving in a flow; the floor is a function of a
 * price that moves. A published skill is re-compiled on every agent run, so a floor baked in by
 * the UI at publish time would assert last week's price — too low to protect once the price rises,
 * and guaranteed to revert once it falls. Deriving it here means every path (simulate, publish,
 * and an autonomous MCP run days later) gets a floor computed against current pool state.
 *
 * Fails closed: if the pool cannot be read, the compile throws. A swap whose floor is unknown is
 * exactly the bug `min_amount_out: "1"` was — a permissive default wearing a number.
 */
export async function applyQuotedFloors(flow: FlowGraph, warnings: string[]): Promise<void> {
  for (const node of flow.nodes) {
    if (node.type !== 'cetus_swap') continue;

    const config = node.config;
    const slippageRaw = config?.slippageBps;
    // No declared tolerance, or a floor is already pinned: nothing to derive.
    //
    // Skipping a pinned floor is only safe because `min_amount_out` is not a RUNTIME_KEY — it can
    // reach config solely through the owner's flow, never through the agent's call. If the agent
    // could set it, this `continue` would be the whole hole: the agent pins 1, and the derivation
    // meant to constrain it never runs.
    if (config == null || slippageRaw == null || slippageRaw === '') continue;
    if (config.min_amount_out != null && config.min_amount_out !== '') continue;

    const slippageBps = BigInt(String(slippageRaw));
    const pool = String(config.pool ?? '');
    const inputCoinType = String(config.inputCoinType ?? '');
    const amountIn = BigInt(String(config.amount_in ?? '0'));

    if (!pool || !inputCoinType) {
      throw new ValidationError(
        `Node ${node.id}: slippageBps needs both pool and inputCoinType to derive a floor; refusing to compile an unguarded swap.`,
      );
    }
    if (amountIn <= 0n) {
      throw new ValidationError(
        `Node ${node.id}: amount_in must be positive to derive a slippage floor.`,
      );
    }

    // Mirror the adapter's own direction check (pickSwapFunction) so the quoted floor always
    // describes the swap that actually gets compiled. Re-thrown as a ValidationError: blocking the
    // compile is correct, but the caller has to be told why, not handed an opaque 500.
    let poolTypes;
    try {
      poolTypes = await resolvePoolTypeArgs(pool);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ValidationError(
        `Node ${node.id}: cannot derive a slippage floor — ${message}`,
      );
    }
    const a2b = inputCoinType === poolTypes.coinTypeA;

    const quote = await quoteService.quoteCetus(pool, amountIn, a2b, slippageBps);
    config.min_amount_out = quote.minAmountOut;

    warnings.push(
      `Node ${node.id}: min_amount_out=${quote.minAmountOut} derived from pool spot price ` +
        `(expected ${quote.expectedOut}, slippage ${slippageBps}bps). ${SPOT_QUOTE_NOTE}`,
    );
  }
}
