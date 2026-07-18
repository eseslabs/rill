import { expect, test } from 'bun:test';
import { StepSchema } from '../src/envelope.schema';

test('a cetus_swap step validates', () => {
  const step = { nodeType: 'cetus_swap', poolId: `0x${'a'.repeat(64)}`, minOutMist: '68210', spendAmountMist: '100000000' };
  expect(StepSchema.safeParse(step).success).toBe(true);
});

test('a haedal_stake step validates', () => {
  const step = { nodeType: 'haedal_stake', validator: '0x0', spendAmountMist: '1000000000' };
  expect(StepSchema.safeParse(step).success).toBe(true);
});

test('a deepbook_limit_order step validates', () => {
  const step = {
    nodeType: 'deepbook_limit_order',
    poolId: `0x${'b'.repeat(64)}`, balanceManagerId: `0x${'c'.repeat(64)}`, tradeCapId: `0x${'d'.repeat(64)}`,
    spendAmountMist: '1100000000',
    order: { clientOrderId: '1', orderType: '0', selfMatchingOption: '0', price: '1496000000', quantity: '1000000000', isBid: false, payWithDeep: false, expiration: '18446744073709551615' },
  };
  expect(StepSchema.safeParse(step).success).toBe(true);
});

test('an unknown nodeType is rejected (fail-closed)', () => {
  expect(StepSchema.safeParse({ nodeType: 'navi_supply', spendAmountMist: '1' }).success).toBe(false);
});

test('an extra field on a step is rejected (strict)', () => {
  expect(StepSchema.safeParse({ nodeType: 'haedal_stake', validator: '0x0', spendAmountMist: '1', sneaky: true }).success).toBe(false);
});
