import { expect, test } from 'bun:test';
import { Transaction } from '@mysten/sui/transactions';
import { deepbookStepValidator, type DeepBookOrderStep } from './deepbook';
import { makeReader, normalized, type StepContext } from './types';

const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const walletPackageId = id(1);
const deepbookPackageId = id(2);
const sender = id(3);

const defaultOrder = {
  clientOrderId: '71601',
  orderType: '0',
  selfMatchingOption: '0',
  price: '1000000',
  quantity: '5000000',
  isBid: false,
  payWithDeep: false,
  expiration: '1844674407370955161',
};

/**
 * Builds a DeepBook fragment PTB: [spend-shaped MoveCall(0), SplitCoins(1), deposit MoveCall,
 * proof MoveCall, order MoveCall], plus the matching StepContext/step pair, mirroring the shape
 * policy.test.ts's `envelope()` helper builds (spend -> deposit -> proof -> order).
 */
function buildFragment(options: {
  amount?: bigint;
  balanceManagerId?: string;
  tradeCapId?: string;
  poolId?: string;
  order?: Partial<typeof defaultOrder>;
  omitDeposit?: boolean;
  depositBalanceManagerId?: string;
  splitAmount?: bigint;
  bypassWalletFunding?: boolean;
  proofBalanceManagerId?: string;
  proofTradeCapId?: string;
  orderPoolId?: string;
  orderBalanceManagerId?: string;
  orderClockId?: string;
  skipProofAuthorization?: boolean;
} = {}): { ctx: StepContext; step: DeepBookOrderStep } {
  const amount = options.amount ?? 6_000_000n;
  const balanceManagerId = options.balanceManagerId ?? id(16);
  const tradeCapId = options.tradeCapId ?? id(7);
  const poolId = options.poolId ?? id(8);
  const order = { ...defaultOrder, ...options.order };

  const tx = new Transaction();
  tx.setSender(sender);
  // Stand-in for agent_wallet::spend. deepbookStepValidator itself never inspects this command's
  // shape (that is the generic caller's job, per inspectGeneric in a later task) — it only needs a
  // command whose Result the deposit split provably descends from, at index ctx.spendIndex.
  const spendResult = tx.moveCall({
    target: `${walletPackageId}::agent_wallet::spend`,
    typeArguments: ['0x2::sui::SUI'],
    arguments: [tx.object(id(4)), tx.object(id(5)), tx.pure.u64(amount), tx.object('0x6')],
  });
  const spendIndex = 0;

  if (!options.omitDeposit) {
    const [coin] = tx.splitCoins(
      options.bypassWalletFunding ? tx.gas : spendResult,
      [options.splitAmount ?? amount],
    );
    tx.moveCall({
      target: `${deepbookPackageId}::balance_manager::deposit`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [tx.object(options.depositBalanceManagerId ?? balanceManagerId), coin],
    });
  }

  const proof = tx.moveCall({
    target: `${deepbookPackageId}::balance_manager::generate_proof_as_trader`,
    arguments: [
      tx.object(options.proofBalanceManagerId ?? balanceManagerId),
      tx.object(options.proofTradeCapId ?? tradeCapId),
    ],
  });

  tx.moveCall({
    target: `${deepbookPackageId}::pool::place_limit_order`,
    typeArguments: ['0x2::sui::SUI', id(9)],
    arguments: [
      tx.object(options.orderPoolId ?? poolId),
      tx.object(options.orderBalanceManagerId ?? balanceManagerId),
      options.skipProofAuthorization ? tx.object(id(77)) : proof,
      tx.pure.u64(BigInt(order.clientOrderId)),
      tx.pure.u8(Number(order.orderType)),
      tx.pure.u8(Number(order.selfMatchingOption)),
      tx.pure.u64(BigInt(order.price)),
      tx.pure.u64(BigInt(order.quantity)),
      tx.pure.bool(order.isBid),
      tx.pure.bool(order.payWithDeep),
      tx.pure.u64(BigInt(order.expiration)),
      tx.object(options.orderClockId ?? '0x6'),
    ],
  });

  const data = tx.getData();
  const reader = makeReader(data);
  const ctx: StepContext = { data, reader, cursor: spendIndex + 1, spendIndex, spendAmountMist: amount };
  const step: DeepBookOrderStep = {
    nodeType: 'deepbook_limit_order',
    poolId,
    balanceManagerId,
    tradeCapId,
    spendAmountMist: amount.toString(),
    order,
  };
  return { ctx, step };
}

// --- Happy path -----------------------------------------------------------------------------

test('happy path: a valid DeepBook fragment validates and reports the right targets/objects/cursor', () => {
  const { ctx, step } = buildFragment();
  const result = deepbookStepValidator(ctx, step);
  expect(result.cursor).toBe(5); // spend(0), split(1), deposit(2), proof(3), order(4) -> cursor 5
  expect(result.targets).toEqual([
    `${normalized(deepbookPackageId)}::balance_manager::deposit`,
    `${normalized(deepbookPackageId)}::balance_manager::generate_proof_as_trader`,
    `${normalized(deepbookPackageId)}::pool::place_limit_order`,
  ]);
  expect(result.objectIds.sort()).toEqual(
    [normalized(id(16)), normalized(id(7)), normalized(id(8))].sort(),
  );
  expect(result.guards).toEqual([]);
});

// --- Required ~4 attack tests (per plan Task 3) ----------------------------------------------

test('missing deposit is rejected', () => {
  const { ctx, step } = buildFragment({ omitDeposit: true });
  expect(() => deepbookStepValidator(ctx, step)).toThrow('missing ordered DeepBook deposit');
});

test('wrong BalanceManager on the deposit is rejected', () => {
  const { ctx, step } = buildFragment({ depositBalanceManagerId: id(99) });
  expect(() => deepbookStepValidator(ctx, step)).toThrow('deposit BalanceManager mismatch');
});

test('a split amount that does not match the declared spend is rejected', () => {
  const { ctx, step } = buildFragment({ splitAmount: 5_999_999n });
  expect(() => deepbookStepValidator(ctx, step)).toThrow('does not consume the full wallet spend');
});

// --- Additional regression coverage (every assertion inspect() made for this fragment) --------

test('a deposit that bypasses the wallet spend output is rejected', () => {
  const { ctx, step } = buildFragment({ bypassWalletFunding: true });
  expect(() => deepbookStepValidator(ctx, step)).toThrow('wallet-funded');
});

test('wrong TradeCap on the trader proof is rejected', () => {
  const { ctx, step } = buildFragment({ proofTradeCapId: id(99) });
  expect(() => deepbookStepValidator(ctx, step)).toThrow('proof TradeCap mismatch');
});

test('wrong BalanceManager on the trader proof is rejected', () => {
  const { ctx, step } = buildFragment({ proofBalanceManagerId: id(99) });
  expect(() => deepbookStepValidator(ctx, step)).toThrow('proof BalanceManager mismatch');
});

test('wrong pool identity on the order is rejected', () => {
  const { ctx, step } = buildFragment({ orderPoolId: id(99) });
  expect(() => deepbookStepValidator(ctx, step)).toThrow('order poolId mismatch');
});

test('wrong BalanceManager on the order is rejected', () => {
  const { ctx, step } = buildFragment({ orderBalanceManagerId: id(99) });
  expect(() => deepbookStepValidator(ctx, step)).toThrow('order BalanceManager mismatch');
});

test('an order not authorized by the trader proof result is rejected', () => {
  const { ctx, step } = buildFragment({ skipProofAuthorization: true });
  expect(() => deepbookStepValidator(ctx, step)).toThrow('not authorized by the required TradeCap proof');
});

test('order with the wrong clock is rejected', () => {
  const { ctx, step } = buildFragment({ orderClockId: id(99) });
  expect(() => deepbookStepValidator(ctx, step)).toThrow('order clock mismatch');
});

for (const [field, value] of [
  ['clientOrderId', '71602'],
  ['orderType', '1'],
  ['selfMatchingOption', '1'],
  ['price', '2000000'],
  ['quantity', '6000000'],
  ['isBid', true],
  ['payWithDeep', true],
  ['expiration', '1844674407370955160'],
] as const) {
  test(`an on-chain ${field} that disagrees with the declared step.order is rejected`, () => {
    const { ctx, step } = buildFragment({ order: { [field]: value } as Partial<typeof defaultOrder> });
    // Mutate the step's declared order back so the PTB (built from the mutated order) disagrees with
    // what the step CLAIMS — i.e., the backend declared one order but built a PTB for a different one.
    const tamperedStep: DeepBookOrderStep = { ...step, order: defaultOrder };
    expect(() => deepbookStepValidator(ctx, tamperedStep)).toThrow('order manifest mismatch');
  });
}

test('a malformed step (wrong nodeType) is rejected', () => {
  const { ctx } = buildFragment();
  expect(() => deepbookStepValidator(ctx, { nodeType: 'cetus_swap' })).toThrow('malformed');
});
