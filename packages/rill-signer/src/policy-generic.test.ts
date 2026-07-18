import { expect, test } from 'bun:test';
import { Transaction } from '@mysten/sui/transactions';
import type { EnvelopeStep } from '../../rill-sdk/src/types';
import { inspectGeneric } from './policy';
import { normalized } from './steps/types';

const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const walletPackageId = id(1);
const cetusPackageId = id(2);
const guardPackageId = id(3);
const haedalPackageId = id(4);
const sender = id(5);
// NOTE: kept well clear of 0x1-0x6 (framework packages + the Sui clock object id) so no object id
// here accidentally normalizes to the same address as the clock, which would collapse in the
// deduped object-id Set inspectGeneric returns.
const walletId = id(16);
const agentCapId = id(17);
const coinTypeSui = '0x2::sui::SUI';
const coinTypeUsdc = `${id(21)}::usdc::USDC`;
const poolId = id(18);
const validatorAddr = id(30);

const swapAmount = 100_000_000n;
const stakeAmount = 1_000_000_000n;
const totalAmount = swapAmount + stakeAmount;
const minOut = 68_210n;

/**
 * Hand-built two-step Cetus -> Haedal PTB: one agent_wallet::spend, then a Cetus swap fragment
 * (its own SplitCoins off the spend + router::swap + guard::assert_min_value), then a Haedal stake
 * fragment (its own, separate SplitCoins off the same spend + request_stake), then a terminal
 * merge-to-gas of the spend remainder. Each protocol leg funds itself independently from the single
 * wallet spend — deepbook.ts's docstring documents this as the expected multi-step shape.
 */
function buildTwoStepPtb(options: { omitMerge?: boolean } = {}): Transaction {
  const tx = new Transaction();
  tx.setSender(sender);

  const spendResult = tx.moveCall({
    target: `${walletPackageId}::agent_wallet::spend`,
    typeArguments: [coinTypeSui],
    arguments: [tx.object(walletId), tx.object(agentCapId), tx.pure.u64(totalAmount), tx.object('0x6')],
  }); // index 0

  const [cetusCoin] = tx.splitCoins(spendResult, [swapAmount]); // index 1
  const zeroCoin = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [coinTypeUsdc], arguments: [] }); // index 2

  const [, outB] = tx.moveCall({
    target: `${cetusPackageId}::router::swap`,
    typeArguments: [coinTypeSui, coinTypeUsdc],
    arguments: [
      tx.object(id(9)), // globalConfig
      tx.object(poolId),
      cetusCoin,
      zeroCoin,
      tx.pure.bool(true),
      tx.pure.bool(true),
      tx.pure.u64(swapAmount),
      tx.pure.u128(0n),
      tx.pure.bool(false),
      tx.object('0x6'),
    ],
  }); // index 3

  tx.moveCall({
    target: `${guardPackageId}::guard::assert_min_value`,
    typeArguments: [coinTypeUsdc],
    arguments: [outB, tx.pure.u64(minOut)],
  }); // index 4

  const [haedalCoin] = tx.splitCoins(spendResult, [stakeAmount]); // index 5

  tx.moveCall({
    target: `${haedalPackageId}::interface::request_stake`,
    typeArguments: [],
    arguments: [tx.object(id(10)), tx.object(id(11)), haedalCoin, tx.pure.address(validatorAddr)],
  }); // index 6

  if (!options.omitMerge) {
    tx.mergeCoins(tx.gas, [spendResult]); // index 7
  }

  return tx;
}

const steps: EnvelopeStep[] = [
  { nodeType: 'cetus_swap', poolId, minOutMist: minOut.toString(), spendAmountMist: swapAmount.toString() },
  { nodeType: 'haedal_stake', validator: validatorAddr, spendAmountMist: stakeAmount.toString() },
];

test('inspectGeneric validates a hand-built two-step Cetus->Haedal PTB', () => {
  const tx = buildTwoStepPtb();
  const result = inspectGeneric(tx, { walletPackageId, walletId, agentCapId, steps });

  expect(result.spendAmountMist).toBe(totalAmount);
  expect(result.targets.sort()).toEqual(
    [
      `${normalized(cetusPackageId)}::router::swap`,
      `${normalized(guardPackageId)}::guard::assert_min_value`,
      `${normalized(haedalPackageId)}::interface::request_stake`,
    ].sort(),
  );
  expect(result.objectIds.sort()).toEqual(
    [normalized(walletId), normalized(agentCapId), normalized('0x6'), normalized(poolId)].sort(),
  );
  expect(result.guards).toEqual([`${normalized(guardPackageId)}::guard::assert_min_value`]);
  expect(result.callTargets).toEqual([
    `${normalized(walletPackageId)}::agent_wallet::spend`,
    `${normalized('0x2')}::coin::zero`,
    `${normalized(cetusPackageId)}::router::swap`,
    `${normalized(guardPackageId)}::guard::assert_min_value`,
    `${normalized(haedalPackageId)}::interface::request_stake`,
  ]);
});

test('inspectGeneric rejects a PTB missing the wallet spend', () => {
  const tx = new Transaction();
  tx.setSender(sender);
  tx.moveCall({ target: '0x2::coin::zero', typeArguments: [coinTypeSui], arguments: [] });
  expect(() => inspectGeneric(tx, { walletPackageId, walletId, agentCapId, steps: [] })).toThrow(
    'missing the wallet spend',
  );
});

test('inspectGeneric rejects an unknown step nodeType (fail-closed registry lookup)', () => {
  const tx = buildTwoStepPtb();
  const unknownSteps = [{ nodeType: 'navi_supply' } as unknown as EnvelopeStep];
  expect(() => inspectGeneric(tx, { walletPackageId, walletId, agentCapId, steps: unknownSteps })).toThrow(
    'No validator for step',
  );
});

test('inspectGeneric rejects a PTB whose terminal command is not the merge-to-gas', () => {
  const tx = buildTwoStepPtb({ omitMerge: true });
  expect(() => inspectGeneric(tx, { walletPackageId, walletId, agentCapId, steps })).toThrow(
    'merging only the wallet spend remainder into gas',
  );
});
