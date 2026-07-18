import { expect, test } from 'bun:test';
import { Transaction } from '@mysten/sui/transactions';
import { haedalStakeStepValidator, type HaedalStakeStep } from './haedal';
import { makeReader, normalized, type StepContext } from './types';

const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const walletPackageId = id(1);
const haedalPackageId = id(2);
const sender = id(3);
const coinTypeSui = '0x2::sui::SUI';
const validator = id(30);

/**
 * Builds a Haedal fragment PTB: [spend-shaped MoveCall(0), SplitCoins(1), request_stake MoveCall(2)],
 * plus the matching StepContext/step pair — mirroring the real shape haedal.adapter.ts builds when
 * funding from the root budget (fundSuiCoin → a SplitCoins off the wallet spend result).
 */
function buildFragment(options: {
  amount?: bigint;
  splitAmount?: bigint;
  validatorId?: string;
  stakeArgs?: 'validator' | 'unrelated';
  omitStake?: boolean;
  arity?: number;
  bypassWalletFunding?: boolean;
  coinArgKind?: 'split' | 'plain-object';
} = {}): { ctx: StepContext; step: HaedalStakeStep } {
  const amount = options.amount ?? 1_000_000_000n;

  const tx = new Transaction();
  tx.setSender(sender);

  const spendResult = tx.moveCall({
    target: `${walletPackageId}::agent_wallet::spend`,
    typeArguments: [coinTypeSui],
    arguments: [tx.object(id(4)), tx.object(id(5)), tx.pure.u64(amount), tx.object('0x6')],
  });
  const spendIndex = 0;

  let coinArg: unknown;
  if (options.coinArgKind === 'plain-object') {
    coinArg = tx.object(id(50));
  } else {
    const [split] = tx.splitCoins(options.bypassWalletFunding ? tx.gas : spendResult, [
      options.splitAmount ?? amount,
    ]);
    coinArg = split;
  }

  if (!options.omitStake) {
    const fullArgs = [
      tx.object(id(10)), // suiSystemState
      tx.object(id(11)), // stakingObject
      coinArg,
      tx.pure.address(options.validatorId ?? validator),
    ];
    const stakeArgs = options.arity !== undefined ? fullArgs.slice(0, options.arity) : fullArgs;
    tx.moveCall({
      target: `${haedalPackageId}::interface::request_stake`,
      typeArguments: [],
      arguments: stakeArgs as never,
    });
  }

  const data = tx.getData();
  const reader = makeReader(data);
  const ctx: StepContext = { data, reader, cursor: spendIndex + 1, spendIndex, spendAmountMist: amount };
  const step: HaedalStakeStep = {
    nodeType: 'haedal_stake',
    validator,
    spendAmountMist: amount.toString(),
  };
  return { ctx, step };
}

// --- Happy path -----------------------------------------------------------------------------

test('happy path: a valid Haedal stake fragment validates and reports the right targets/cursor', () => {
  const { ctx, step } = buildFragment();
  const result = haedalStakeStepValidator(ctx, step);
  expect(result.cursor).toBe(3); // spend(0), split(1), stake(2) -> cursor 3
  expect(result.targets).toEqual([`${normalized(haedalPackageId)}::interface::request_stake`]);
  expect(result.objectIds).toEqual([]);
  expect(result.guards).toEqual([]);
});

// --- Required attack tests (per plan Task 6) -------------------------------------------------

test('a wrong validator address is rejected', () => {
  const { ctx, step } = buildFragment({ validatorId: id(99) });
  expect(() => haedalStakeStepValidator(ctx, step)).toThrow('validator mismatch');
});

test('a spend below the 1-SUI Haedal minimum is rejected', () => {
  const { ctx, step } = buildFragment({ amount: 999_999_999n });
  expect(() => haedalStakeStepValidator(ctx, step)).toThrow('below the 1 SUI minimum');
});

test('a spend exactly at the 1-SUI Haedal minimum is accepted', () => {
  const { ctx, step } = buildFragment({ amount: 1_000_000_000n });
  expect(() => haedalStakeStepValidator(ctx, step)).not.toThrow();
});

// --- Additional regression coverage -------------------------------------------------------------

test('a stake coin that bypasses the wallet spend output is rejected', () => {
  const { ctx, step } = buildFragment({ bypassWalletFunding: true });
  expect(() => haedalStakeStepValidator(ctx, step)).toThrow('not wallet-funded');
});

test('a stake coin that is a plain object (not a SplitCoins result) is rejected', () => {
  const { ctx, step } = buildFragment({ coinArgKind: 'plain-object' });
  expect(() => haedalStakeStepValidator(ctx, step)).toThrow('not wallet-funded');
});

test('a stake with the wrong arity is rejected', () => {
  const { ctx, step } = buildFragment({ arity: 3 });
  expect(() => haedalStakeStepValidator(ctx, step)).toThrow('exactly 4 arguments');
});

test('a missing stake call altogether is rejected', () => {
  const { ctx, step } = buildFragment({ omitStake: true });
  expect(() => haedalStakeStepValidator(ctx, step)).toThrow('missing ordered Haedal stake');
});

test('a malformed step (wrong nodeType) is rejected', () => {
  const { ctx } = buildFragment();
  expect(() => haedalStakeStepValidator(ctx, { nodeType: 'cetus_swap' })).toThrow('malformed');
});
