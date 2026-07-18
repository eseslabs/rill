import { expect, test } from 'bun:test';
import { Transaction } from '@mysten/sui/transactions';
import { cetusSwapStepValidator, type CetusSwapStep } from './cetus';
import { makeReader, normalized, type StepContext } from './types';

const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const walletPackageId = id(1);
const cetusPackageId = id(2);
const guardPackageId = id(3);
const sender = id(4);
const coinTypeA = '0x2::sui::SUI';
const coinTypeB = `${id(20)}::usdc::USDC`;

/**
 * Builds a Cetus fragment PTB: [spend-shaped MoveCall(0), zero-coin MoveCall(1), router::swap(2),
 * guard::assert_min_value(3)], plus the matching StepContext/step pair — mirroring the real shape
 * cetus.adapter.ts + guard.ts's injectMinOutAssert build (a leading zero-coin for the unused side,
 * then the swap, then the mandatory guard on the swap's output).
 */
function buildFragment(options: {
  amount?: bigint;
  minOut?: bigint;
  poolId?: string;
  swapPoolId?: string;
  swapArity?: number;
  guardArity?: number;
  omitGuard?: boolean;
  guardTargetSuffix?: string;
  guardMinOut?: bigint;
  guardCoinSource?: 'swap-output' | 'unrelated';
  insertGapBeforeGuard?: boolean;
} = {}): { ctx: StepContext; step: CetusSwapStep } {
  const amount = options.amount ?? 100_000_000n;
  const minOut = options.minOut ?? 68_210n;
  const poolId = options.poolId ?? id(8);

  const tx = new Transaction();
  tx.setSender(sender);

  const spendResult = tx.moveCall({
    target: `${walletPackageId}::agent_wallet::spend`,
    typeArguments: [coinTypeA],
    arguments: [tx.object(id(5)), tx.object(id(6)), tx.pure.u64(amount), tx.object('0x6')],
  });
  const spendIndex = 0;

  const zeroCoin = tx.moveCall({
    target: '0x2::coin::zero',
    typeArguments: [coinTypeB],
    arguments: [],
  });

  const fullSwapArgs = [
    tx.object(id(9)), // globalConfig
    tx.object(options.swapPoolId ?? poolId),
    spendResult, // coinAIn
    zeroCoin, // coinBIn
    tx.pure.bool(true), // a2b
    tx.pure.bool(true), // by_amount_in
    tx.pure.u64(amount),
    tx.pure.u128(0n), // sqrt_price_limit
    tx.pure.bool(false), // partner flag
    tx.object('0x6'), // clock
  ];
  const swapArgs = options.swapArity !== undefined ? fullSwapArgs.slice(0, options.swapArity) : fullSwapArgs;

  const [outA, outB] = tx.moveCall({
    target: `${cetusPackageId}::router::swap`,
    typeArguments: [coinTypeA, coinTypeB],
    arguments: swapArgs as never,
  });
  const swapIndex = 2;

  if (options.insertGapBeforeGuard) {
    tx.moveCall({ target: '0x2::coin::zero', typeArguments: [coinTypeB], arguments: [] });
  }

  if (!options.omitGuard) {
    const fullGuardArgs = [options.guardCoinSource === 'unrelated' ? zeroCoin : outB, tx.pure.u64(options.guardMinOut ?? minOut)];
    const guardArgs = options.guardArity !== undefined ? fullGuardArgs.slice(0, options.guardArity) : fullGuardArgs;
    tx.moveCall({
      target: `${guardPackageId}::${options.guardTargetSuffix ?? 'guard::assert_min_value'}`,
      typeArguments: [coinTypeB],
      arguments: guardArgs as never,
    });
  }

  const data = tx.getData();
  const reader = makeReader(data);
  const ctx: StepContext = { data, reader, cursor: spendIndex + 1, spendIndex, spendAmountMist: amount };
  const step: CetusSwapStep = {
    nodeType: 'cetus_swap',
    poolId,
    minOutMist: minOut.toString(),
    spendAmountMist: amount.toString(),
  };
  return { ctx, step };
}

// --- Happy path -----------------------------------------------------------------------------

test('happy path: a valid Cetus swap+guard fragment validates and reports the right targets/objects/cursor', () => {
  const { ctx, step } = buildFragment();
  const result = cetusSwapStepValidator(ctx, step);
  expect(result.cursor).toBe(4); // spend(0), zero(1), swap(2), guard(3) -> cursor 4
  expect(result.targets).toEqual([
    `${normalized(id(2))}::router::swap`,
    `${normalized(id(3))}::guard::assert_min_value`,
  ]);
  expect(result.objectIds).toEqual([normalized(id(8))]);
  expect(result.guards).toEqual([`${normalized(id(3))}::guard::assert_min_value`]);
});

// --- Required attack tests (per plan Task 5) -------------------------------------------------

test('a missing guard on a cetus_swap step is rejected', () => {
  const { ctx, step } = buildFragment({ omitGuard: true });
  expect(() => cetusSwapStepValidator(ctx, step)).toThrow('missing the required on-chain slippage guard');
});

test('a min-out below the declared step floor is rejected', () => {
  const { ctx, step } = buildFragment({ guardMinOut: 68_209n });
  expect(() => cetusSwapStepValidator(ctx, step)).toThrow('below the declared step floor');
});

test('the wrong pool on the swap is rejected', () => {
  const { ctx, step } = buildFragment({ swapPoolId: id(99) });
  expect(() => cetusSwapStepValidator(ctx, step)).toThrow('PTB Cetus swap poolId mismatch');
});

// --- Additional regression coverage -----------------------------------------------------------

test('a min-out exactly at the declared step floor is accepted', () => {
  const { ctx, step } = buildFragment({ guardMinOut: 68_210n });
  expect(() => cetusSwapStepValidator(ctx, step)).not.toThrow();
});

test('a min-out above the declared step floor is accepted (backend gave a better floor)', () => {
  const { ctx, step } = buildFragment({ guardMinOut: 100_000n });
  expect(() => cetusSwapStepValidator(ctx, step)).not.toThrow();
});

test('a swap with the wrong arity is rejected', () => {
  const { ctx, step } = buildFragment({ swapArity: 9 });
  expect(() => cetusSwapStepValidator(ctx, step)).toThrow('exactly 10 arguments');
});

test('a guard with the wrong arity is rejected', () => {
  const { ctx, step } = buildFragment({ guardArity: 1 });
  expect(() => cetusSwapStepValidator(ctx, step)).toThrow('exactly 2 arguments');
});

test('a guard asserting on an unrelated coin (not the swap output) is rejected', () => {
  const { ctx, step } = buildFragment({ guardCoinSource: 'unrelated' });
  expect(() => cetusSwapStepValidator(ctx, step)).toThrow('does not assert on the swap output coin');
});

test('a guard that is not immediately following the swap (a gap in between) is rejected', () => {
  const { ctx, step } = buildFragment({ insertGapBeforeGuard: true });
  expect(() => cetusSwapStepValidator(ctx, step)).toThrow('missing the required on-chain slippage guard');
});

test('a guard with a target that is not ::guard::assert_min_value is rejected', () => {
  const { ctx, step } = buildFragment({ guardTargetSuffix: 'guard::assert_something_else' });
  expect(() => cetusSwapStepValidator(ctx, step)).toThrow('missing the required on-chain slippage guard');
});

test('a malformed step (wrong nodeType) is rejected', () => {
  const { ctx } = buildFragment();
  expect(() => cetusSwapStepValidator(ctx, { nodeType: 'haedal_stake' })).toThrow('malformed');
});

test('a missing swap altogether is rejected', () => {
  const { ctx, step } = buildFragment();
  const noSwapCtx: StepContext = { ...ctx, cursor: 1000 };
  expect(() => cetusSwapStepValidator(noSwapCtx, step)).toThrow('missing ordered Cetus swap');
});
