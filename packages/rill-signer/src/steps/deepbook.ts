import type { Command, StepContext, StepResult, StepValidator } from './types';
import { SUI_COIN_TYPE, expectNormalizedMatch, normalizeCoinType, normalized, targetOf } from './types';

export interface DeepBookOrderStep {
  nodeType: 'deepbook_limit_order';
  poolId: string;
  balanceManagerId: string;
  tradeCapId: string;
  spendAmountMist: string;
  order: {
    clientOrderId: string;
    orderType: string;
    selfMatchingOption: string;
    price: string;
    quantity: string;
    isBid: boolean;
    payWithDeep: boolean;
    expiration: string;
  };
}

const ORDER_STRING_FIELDS = [
  'clientOrderId',
  'orderType',
  'selfMatchingOption',
  'price',
  'quantity',
  'expiration',
] as const;

/** Fail-closed runtime narrowing of the `unknown` step — this module never trusts its input shape,
 * matching the rest of this package's stance that malformed/unexpected input is rejected, not coerced. */
function asDeepBookOrderStep(step: unknown): DeepBookOrderStep {
  const candidate = step as Partial<DeepBookOrderStep> | null | undefined;
  if (
    !candidate ||
    candidate.nodeType !== 'deepbook_limit_order' ||
    typeof candidate.poolId !== 'string' ||
    typeof candidate.balanceManagerId !== 'string' ||
    typeof candidate.tradeCapId !== 'string' ||
    typeof candidate.spendAmountMist !== 'string' ||
    !candidate.order ||
    typeof candidate.order !== 'object'
  ) {
    throw new Error('deepbook_limit_order step is malformed.');
  }
  const order = candidate.order as Partial<DeepBookOrderStep['order']>;
  for (const field of ORDER_STRING_FIELDS) {
    if (typeof order[field] !== 'string') {
      throw new Error(`deepbook_limit_order step.order.${field} is malformed.`);
    }
  }
  if (typeof order.isBid !== 'boolean' || typeof order.payWithDeep !== 'boolean') {
    throw new Error('deepbook_limit_order step.order boolean fields are malformed.');
  }
  return candidate as DeepBookOrderStep;
}

/** Identical in behavior to policy.ts's assertTypeArguments — duplicated locally (not extracted to
 * steps/types.ts) since it was not part of Task 2's extraction list and each step validator's
 * typeArguments shape differs enough that a shared abstraction isn't obviously right yet. */
function assertTypeArguments(actual: readonly string[], expected: readonly string[], label: string): void {
  const normalizedActual = actual.map((value) => normalizeCoinType(value));
  if (
    normalizedActual.length !== expected.length ||
    !normalizedActual.every((value, index) => value === expected[index])
  ) {
    throw new Error(`${label} typeArguments mismatch.`);
  }
}

function findFrom(commands: readonly Command[], start: number, predicate: (command: Command) => boolean): number {
  for (let index = start; index < commands.length; index += 1) {
    if (predicate(commands[index])) return index;
  }
  return -1;
}

/**
 * Behavior-preserving extraction of inspect()'s DeepBook deposit -> trader-proof -> limit-order
 * fragment (packages/rill-signer/src/policy.ts). Reads the step's OWN declared
 * {poolId, balanceManagerId, tradeCapId, order} instead of policy.* — the generic caller (a later
 * task, not this one) is responsible for pinning envelope.steps == policy.steps, so by the time this
 * runs, `step` IS the owner-approved plan for this node. This validator's job is independently
 * verifying the ACTUAL PTB bytes match that declared shape, exactly as inspect() did for the single
 * hardcoded DeepBook path — including asserting the deposit is a NestedResult of a SplitCoins from
 * ctx.spendIndex whose amount equals ctx.spendAmountMist.
 *
 * Deliberately NOT included here (by contract, not oversight): the PTB-wide command manifest / "solo
 * SplitCoins+MergeCoins" / terminal merge-to-gas checks that inspect() also performed. Those are
 * inherently whole-transaction invariants — universal across every step type, not DeepBook-specific —
 * and belong to the generic caller (inspectGeneric, a later task), which runs them once regardless of
 * how many steps compose the PTB. Reproducing them per-step here would break any multi-step flow that
 * legitimately has more than one SplitCoins (e.g. Cetus + Haedal + DeepBook each fund their own leg).
 */
export const deepbookStepValidator: StepValidator = (ctx: StepContext, rawStep: unknown): StepResult => {
  const step = asDeepBookOrderStep(rawStep);
  const { data, reader } = ctx;
  const commands = data.commands;

  const depositIndex = findFrom(commands, ctx.cursor, (command) => targetOf(command).endsWith('::balance_manager::deposit'));
  const deposit = commands[depositIndex];
  if (depositIndex === -1 || !deposit || deposit.$kind !== 'MoveCall') {
    throw new Error('PTB is missing ordered DeepBook deposit.');
  }
  reader.exactArity(deposit.MoveCall.arguments, 2, 'PTB DeepBook deposit');
  assertTypeArguments(deposit.MoveCall.typeArguments, [SUI_COIN_TYPE], 'PTB DeepBook deposit');
  expectNormalizedMatch(
    reader.objectArgument(deposit.MoveCall.arguments[0], 'DeepBook deposit BalanceManager'),
    step.balanceManagerId,
    'PTB DeepBook deposit BalanceManager mismatch.',
  );
  const depositedCoin = deposit.MoveCall.arguments[1];
  if (depositedCoin.$kind !== 'NestedResult' || depositedCoin.NestedResult[1] !== 0) {
    throw new Error('DeepBook deposit is not wallet-funded.');
  }
  const splitIndex = depositedCoin.NestedResult[0];
  const split = commands[splitIndex];
  if (
    !split ||
    split.$kind !== 'SplitCoins' ||
    split.SplitCoins.coin.$kind !== 'Result' ||
    split.SplitCoins.coin.Result !== ctx.spendIndex ||
    split.SplitCoins.amounts.length !== 1
  ) {
    throw new Error('DeepBook deposit is not wallet-funded.');
  }
  const depositAmountMist = reader.u64(split.SplitCoins.amounts[0], 'DeepBook deposit amount');
  if (depositAmountMist !== ctx.spendAmountMist) {
    throw new Error('DeepBook deposit does not consume the full wallet spend.');
  }

  const proofIndex = findFrom(
    commands,
    depositIndex + 1,
    (command) => targetOf(command).endsWith('::balance_manager::generate_proof_as_trader'),
  );
  const proof = commands[proofIndex];
  if (proofIndex === -1 || !proof || proof.$kind !== 'MoveCall') {
    throw new Error('PTB is missing ordered DeepBook trader proof.');
  }
  reader.exactArity(proof.MoveCall.arguments, 2, 'PTB DeepBook trader proof');
  assertTypeArguments(proof.MoveCall.typeArguments, [], 'PTB DeepBook trader proof');
  expectNormalizedMatch(
    reader.objectArgument(proof.MoveCall.arguments[0], 'DeepBook proof BalanceManager'),
    step.balanceManagerId,
    'PTB DeepBook proof BalanceManager mismatch.',
  );
  expectNormalizedMatch(
    reader.objectArgument(proof.MoveCall.arguments[1], 'DeepBook proof TradeCap'),
    step.tradeCapId,
    'PTB DeepBook proof TradeCap mismatch.',
  );

  const orderIndex = findFrom(commands, proofIndex + 1, (command) => targetOf(command).endsWith('::pool::place_limit_order'));
  const order = commands[orderIndex];
  if (orderIndex === -1 || !order || order.$kind !== 'MoveCall') {
    throw new Error('PTB is missing ordered DeepBook limit order.');
  }
  reader.exactArity(order.MoveCall.arguments, 12, 'PTB DeepBook order');
  if (order.MoveCall.typeArguments.length !== 2) {
    throw new Error('PTB DeepBook order must have exactly 2 type arguments.');
  }
  if (normalizeCoinType(order.MoveCall.typeArguments[0]) !== SUI_COIN_TYPE) {
    throw new Error('PTB DeepBook order base typeArguments mismatch.');
  }
  expectNormalizedMatch(
    reader.objectArgument(order.MoveCall.arguments[11], 'DeepBook order clock'),
    '0x6',
    'PTB DeepBook order clock mismatch.',
  );
  expectNormalizedMatch(
    reader.objectArgument(order.MoveCall.arguments[0], 'DeepBook order pool'),
    step.poolId,
    'PTB DeepBook order poolId mismatch.',
  );
  expectNormalizedMatch(
    reader.objectArgument(order.MoveCall.arguments[1], 'DeepBook order BalanceManager'),
    step.balanceManagerId,
    'PTB DeepBook order BalanceManager mismatch.',
  );
  const proofArgument = order.MoveCall.arguments[2];
  if (proofArgument.$kind !== 'Result' || proofArgument.Result !== proofIndex) {
    throw new Error('PTB DeepBook order is not authorized by the required TradeCap proof.');
  }
  const isBid = reader.byte(order.MoveCall.arguments[8], 'DeepBook order isBid');
  const payWithDeep = reader.byte(order.MoveCall.arguments[9], 'DeepBook order payWithDeep');
  if (isBid > 1 || payWithDeep > 1) throw new Error('PTB DeepBook order contains an invalid boolean.');

  const onChainOrder = {
    clientOrderId: reader.u64(order.MoveCall.arguments[3], 'DeepBook order clientOrderId').toString(),
    orderType: String(reader.byte(order.MoveCall.arguments[4], 'DeepBook order orderType')),
    selfMatchingOption: String(reader.byte(order.MoveCall.arguments[5], 'DeepBook order selfMatchingOption')),
    price: reader.u64(order.MoveCall.arguments[6], 'DeepBook order price').toString(),
    quantity: reader.u64(order.MoveCall.arguments[7], 'DeepBook order quantity').toString(),
    isBid: isBid === 1,
    payWithDeep: payWithDeep === 1,
    expiration: reader.u64(order.MoveCall.arguments[10], 'DeepBook order expiration').toString(),
  };
  for (const [name, expected] of Object.entries(step.order)) {
    if (onChainOrder[name as keyof typeof onChainOrder] !== expected) {
      throw new Error(`PTB DeepBook order manifest mismatch (${name}).`);
    }
  }

  return {
    cursor: orderIndex + 1,
    targets: [targetOf(deposit), targetOf(proof), targetOf(order)],
    objectIds: [normalized(step.balanceManagerId), normalized(step.tradeCapId), normalized(step.poolId)],
    guards: [],
  };
};
