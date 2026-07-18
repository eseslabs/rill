import { normalizeSuiAddress } from '@mysten/sui/utils';
import type { Command, StepContext, StepResult, StepValidator } from './types';
import { expectNormalizedMatch, targetOf } from './types';

export interface HaedalStakeStep {
  nodeType: 'haedal_stake';
  validator: string;
  spendAmountMist: string;
}

/** Mirrors haedal.adapter.ts's minStakeMist floor (1 SUI) — the on-chain protocol minimum for
 * `request_stake`. Checked against the WHOLE wallet spend for this PTB (ctx.spendAmountMist),
 * per the same reasoning deepbook.ts's single-funding-source checks use. */
const HAEDAL_MIN_STAKE_MIST = 1_000_000_000n;

/** Fail-closed runtime narrowing of the `unknown` step — mirrors deepbook.ts's stance that this
 * module never trusts its input shape; malformed/unexpected input is rejected, not coerced. */
function asHaedalStakeStep(step: unknown): HaedalStakeStep {
  const candidate = step as Partial<HaedalStakeStep> | null | undefined;
  if (
    !candidate ||
    candidate.nodeType !== 'haedal_stake' ||
    typeof candidate.validator !== 'string' ||
    typeof candidate.spendAmountMist !== 'string'
  ) {
    throw new Error('haedal_stake step is malformed.');
  }
  return candidate as HaedalStakeStep;
}

function findFrom(commands: readonly Command[], start: number, predicate: (command: Command) => boolean): number {
  for (let index = start; index < commands.length; index += 1) {
    if (predicate(commands[index])) return index;
  }
  return -1;
}

/**
 * Reads a `tx.pure.address(...)` argument: 32 raw bytes, no length prefix (confirmed against the
 * @mysten/sui Transaction builder's own BCS encoding). Not part of the shared Reader in ./types
 * (arity-limited to what Task 2's extraction covered) — this is the only step validator that needs
 * a bare address argument, so the helper stays local, matching the onboarding address reader
 * already local to policy.ts's inspectOnboarding.
 */
function pureAddress(ctx: StepContext, argument: unknown, label: string): string {
  const value = argument as { $kind?: string; Input?: number };
  if (value.$kind !== 'Input' || value.Input == null) throw new Error(`${label} is not a plain input.`);
  const input = ctx.data.inputs[value.Input];
  if (!input || input.$kind !== 'Pure') throw new Error(`${label} must be a static pure value.`);
  const bytes = Buffer.from(input.Pure.bytes, 'base64');
  if (bytes.length !== 32) throw new Error(`${label} is not a 32-byte address.`);
  return normalizeSuiAddress(`0x${bytes.toString('hex')}`);
}

/**
 * Haedal liquid-staking `interface::request_stake`.
 *
 * Arg layout confirmed against rill-backend's haedal.adapter.ts MoveCall: [suiSystemState,
 * stakingObject, coin, address validator] = 4 args (coin is index 2, validator is index 3). The
 * system-state/staking-object ids are treated as fixed protocol constants here (unlike DeepBook's
 * per-run BalanceManager/pool), so this validator does not pin them — only the funding coin's
 * provenance and the target validator address, which ARE owner-approved per-step data.
 *
 * The funding coin must be provably a SplitCoins off ctx.spendIndex — same provenance pattern
 * deepbook.ts uses for its deposit — so the stake can never be funded from an unrelated coin the
 * backend happens to also hold. The 1-SUI Haedal protocol minimum is enforced against the whole
 * wallet spend for this PTB, mirroring the adapter's own `minStakeMist` guard.
 */
export const haedalStakeStepValidator: StepValidator = (ctx: StepContext, rawStep: unknown): StepResult => {
  const step = asHaedalStakeStep(rawStep);
  const { data, reader } = ctx;
  const commands = data.commands;

  if (ctx.spendAmountMist < HAEDAL_MIN_STAKE_MIST) {
    throw new Error('Haedal stake is below the 1 SUI minimum.');
  }

  const stakeIndex = findFrom(commands, ctx.cursor, (command) => targetOf(command).endsWith('::interface::request_stake'));
  const stake = commands[stakeIndex];
  if (stakeIndex === -1 || !stake || stake.$kind !== 'MoveCall') {
    throw new Error('PTB is missing ordered Haedal stake.');
  }
  reader.exactArity(stake.MoveCall.arguments, 4, 'PTB Haedal stake');

  const coinArgument = stake.MoveCall.arguments[2] as { $kind?: string; NestedResult?: [number, number] };
  if (coinArgument.$kind !== 'NestedResult' || coinArgument.NestedResult?.[1] !== 0) {
    throw new Error('Haedal stake coin is not wallet-funded.');
  }
  const split = commands[coinArgument.NestedResult[0]];
  if (
    !split ||
    split.$kind !== 'SplitCoins' ||
    split.SplitCoins.coin.$kind !== 'Result' ||
    split.SplitCoins.coin.Result !== ctx.spendIndex
  ) {
    throw new Error('Haedal stake coin is not wallet-funded.');
  }

  expectNormalizedMatch(
    pureAddress(ctx, stake.MoveCall.arguments[3], 'Haedal stake validator'),
    step.validator,
    'PTB Haedal stake validator mismatch.',
  );

  return {
    cursor: stakeIndex + 1,
    targets: [targetOf(stake)],
    objectIds: [],
    guards: [],
  };
};
