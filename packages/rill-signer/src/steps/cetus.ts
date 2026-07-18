import type { Command, StepContext, StepResult, StepValidator } from './types';
import { expectNormalizedMatch, normalized, targetOf } from './types';

export interface CetusSwapStep {
  nodeType: 'cetus_swap';
  poolId: string;
  /** The on-chain slippage floor asserted by rill_guard on the swap output. */
  minOutMist: string;
  spendAmountMist: string;
}

/** Fail-closed runtime narrowing of the `unknown` step — mirrors deepbook.ts's stance that this
 * module never trusts its input shape; malformed/unexpected input is rejected, not coerced. */
function asCetusSwapStep(step: unknown): CetusSwapStep {
  const candidate = step as Partial<CetusSwapStep> | null | undefined;
  if (
    !candidate ||
    candidate.nodeType !== 'cetus_swap' ||
    typeof candidate.poolId !== 'string' ||
    typeof candidate.minOutMist !== 'string' ||
    typeof candidate.spendAmountMist !== 'string'
  ) {
    throw new Error('cetus_swap step is malformed.');
  }
  return candidate as CetusSwapStep;
}

function findFrom(commands: readonly Command[], start: number, predicate: (command: Command) => boolean): number {
  for (let index = start; index < commands.length; index += 1) {
    if (predicate(commands[index])) return index;
  }
  return -1;
}

/**
 * Cetus CLMM `router::swap` + its MANDATORY, immediately-following `guard::assert_min_value`
 * on-chain slippage floor.
 *
 * Arg layout confirmed against rill-backend's cetus.adapter.ts `router::swap` MoveCall: [globalConfig,
 * pool, coinAIn, coinBIn, bool a2b, bool by_amount_in, u64 amount, u128 sqrt_price_limit,
 * bool partner_flag, clock] = 10 args (pool is index 1). guard.ts's `injectMinOutAssert` call:
 * [coin, u64 minOut] = 2 args (min is index 1).
 *
 * The guard is non-optional here: a swap step with no `guard::assert_min_value` MoveCall directly
 * after it (not merely somewhere later in the PTB — a gap would let an attacker interleave commands
 * that move the swap output before it's checked) is rejected outright. This is what turns the
 * declared `minOutMist` floor into an actual on-chain guarantee instead of a value the backend could
 * simply omit or that could be checked against a decoy coin.
 */
export const cetusSwapStepValidator: StepValidator = (ctx: StepContext, rawStep: unknown): StepResult => {
  const step = asCetusSwapStep(rawStep);
  const { data, reader } = ctx;
  const commands = data.commands;

  const swapIndex = findFrom(commands, ctx.cursor, (command) => targetOf(command).endsWith('::router::swap'));
  const swap = commands[swapIndex];
  if (swapIndex === -1 || !swap || swap.$kind !== 'MoveCall') {
    throw new Error('PTB is missing ordered Cetus swap.');
  }
  reader.exactArity(swap.MoveCall.arguments, 10, 'PTB Cetus swap');
  expectNormalizedMatch(
    reader.objectArgument(swap.MoveCall.arguments[1], 'Cetus swap pool'),
    step.poolId,
    'PTB Cetus swap poolId mismatch.',
  );

  const guardIndex = swapIndex + 1;
  const guard = commands[guardIndex];
  if (!guard || guard.$kind !== 'MoveCall' || !targetOf(guard).endsWith('::guard::assert_min_value')) {
    throw new Error('PTB Cetus swap is missing the required on-chain slippage guard immediately after it.');
  }
  reader.exactArity(guard.MoveCall.arguments, 2, 'PTB Cetus guard');

  // The guard's coin argument must be the swap's OWN output (a NestedResult of the swap command),
  // not some other coin the backend happens to also hold — otherwise a "guard" that checks a decoy
  // coin while the real swap output escapes unchecked would satisfy every other assertion here.
  const guardCoinArgument = guard.MoveCall.arguments[0] as { $kind?: string; NestedResult?: [number, number] };
  if (guardCoinArgument.$kind !== 'NestedResult' || guardCoinArgument.NestedResult?.[0] !== swapIndex) {
    throw new Error('PTB Cetus guard does not assert on the swap output coin.');
  }

  const minOut = reader.u64(guard.MoveCall.arguments[1], 'Cetus guard min value');
  if (minOut < BigInt(step.minOutMist)) {
    throw new Error('PTB Cetus guard minOut is below the declared step floor.');
  }

  return {
    cursor: guardIndex + 1,
    targets: [targetOf(swap), targetOf(guard)],
    objectIds: [normalized(step.poolId)],
    guards: [targetOf(guard)],
  };
};
