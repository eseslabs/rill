import { expect, test } from 'bun:test';
import { ValidationError } from './errors';
import {
  parseConfigDecimalNumber,
  parseConfigU128,
  parseConfigU64,
  resolveCetusSwapConfig,
  resolveDeepbookOrderConfig,
  resolveHaedalStakeConfig,
  suiToMist,
} from './node-config';
import type { FlowNode } from '../features/protocols/types';

const cetusNode = (config: Record<string, unknown>): FlowNode => ({
  id: 'swap1',
  type: 'cetus_swap',
  config,
});

const haedalNode = (config: Record<string, unknown>): FlowNode => ({
  id: 'stake1',
  type: 'haedal_stake',
  config,
});

const deepbookNode = (config: Record<string, unknown>): FlowNode => ({
  id: 'order1',
  type: 'deepbook_limit_order',
  config,
});

// --- parseConfigU64 (R6) -----------------------------------------------------

test('parseConfigU64 rejects non-numeric garbage', () => {
  expect(() => parseConfigU64('abc', 'amount_in')).toThrow(ValidationError);
});

test('parseConfigU64 rejects a negative amount', () => {
  expect(() => parseConfigU64('-1', 'amount_in')).toThrow(ValidationError);
});

test('parseConfigU64 rejects a decimal where an integer is expected', () => {
  expect(() => parseConfigU64('1.5', 'amount_in')).toThrow(ValidationError);
});

test('parseConfigU64 accepts a valid decimal integer string', () => {
  expect(parseConfigU64('1000000000', 'amount_in')).toBe(1_000_000_000n);
});

// --- parseConfigU128 (sqrt_price_limit, R6) ---------------------------------

test('parseConfigU128 accepts a value that exceeds u64::MAX (a legitimate Cetus sqrt price)', () => {
  expect(parseConfigU128('79226673515401279992447579055', 'sqrt_price_limit')).toBe(
    79226673515401279992447579055n,
  );
});

test('parseConfigU128 rejects garbage without crashing with a raw SyntaxError', () => {
  expect(() => parseConfigU128('not-a-number', 'sqrt_price_limit')).toThrow(ValidationError);
});

// --- parseConfigDecimalNumber (price/quantity/depositSui, R6) --------------

test('parseConfigDecimalNumber rejects garbage instead of silently producing NaN', () => {
  expect(() => parseConfigDecimalNumber('abc', 'config.depositSui')).toThrow(ValidationError);
});

test('parseConfigDecimalNumber rejects a negative value', () => {
  expect(() => parseConfigDecimalNumber('-1', 'config.price')).toThrow(ValidationError);
});

test('parseConfigDecimalNumber accepts a valid non-negative decimal', () => {
  expect(parseConfigDecimalNumber('0.006', 'config.depositSui')).toBe(0.006);
});

// --- suiToMist — the single float→mist path (KTD-2) -------------------------

test('suiToMist converts a human SUI amount to mist exactly', () => {
  expect(suiToMist(0.006, 'depositSui')).toBe(6_000_000n);
  expect(suiToMist(0.01, 'depositSui')).toBe(10_000_000n);
});

test('suiToMist rejects a NaN-producing amount with ValidationError, not a raw RangeError', () => {
  let thrown: unknown;
  try {
    suiToMist(Number('not-a-number'), 'depositSui');
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ValidationError);
  expect((thrown as ValidationError).status).toBe(422);
});

test('suiToMist rejects a non-finite amount (Infinity) with ValidationError, not a raw RangeError', () => {
  let thrown: unknown;
  try {
    suiToMist(Infinity, 'depositSui');
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ValidationError);
});

// --- resolveCetusSwapConfig: min_amount_out has no fallback (R7) -----------

test('resolveCetusSwapConfig leaves min_amount_out undefined when absent (no 1-mist default)', () => {
  const { config, warnings } = resolveCetusSwapConfig(cetusNode({ amount_in: '1000000000' }));
  expect(config.min_amount_out).toBeUndefined();
  expect(warnings.some((w) => w.includes('min_amount_out'))).toBe(false);
});

test('resolveCetusSwapConfig passes through an explicit min_amount_out unchanged', () => {
  const { config } = resolveCetusSwapConfig(
    cetusNode({ amount_in: '1000000000', min_amount_out: '950000000' }),
  );
  expect(config.min_amount_out).toBe('950000000');
});

// --- resolveHaedalStakeConfig: numeric fields stay validate-at-use-site strings ---

test('resolveHaedalStakeConfig returns the raw amount string for the adapter to validate', () => {
  const { config } = resolveHaedalStakeConfig(haedalNode({ amount: '2000000000' }));
  expect(config.amount).toBe('2000000000');
  expect(() => parseConfigU64(config.amount, 'amount')).not.toThrow();
});

test('a malformed haedal amount is only caught once parsed (documents the validation point)', () => {
  const { config } = resolveHaedalStakeConfig(haedalNode({ amount: 'abc' }));
  expect(config.amount).toBe('abc'); // resolver itself doesn't validate — the adapter's parseConfigU64 does
  expect(() => parseConfigU64(config.amount, 'config.amount')).toThrow(ValidationError);
});

// --- resolveDeepbookOrderConfig: depositSui/price/quantity (R6) ------------

test('resolveDeepbookOrderConfig throws ValidationError (422) for a NaN-producing depositSui, not a RangeError', () => {
  let thrown: unknown;
  try {
    resolveDeepbookOrderConfig(deepbookNode({ depositSui: 'not-a-number' }));
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ValidationError);
  expect((thrown as ValidationError).status).toBe(422);
  expect(thrown).not.toBeInstanceOf(RangeError);
});

test('resolveDeepbookOrderConfig rejects a negative depositSui', () => {
  expect(() => resolveDeepbookOrderConfig(deepbookNode({ depositSui: -1 }))).toThrow(ValidationError);
});

test('resolveDeepbookOrderConfig defaults depositSui to 0 when absent', () => {
  const { config } = resolveDeepbookOrderConfig(deepbookNode({}));
  expect(config.depositSui).toBe(0);
});

test('resolveDeepbookOrderConfig rejects malformed price/quantity instead of silently producing NaN', () => {
  expect(() => resolveDeepbookOrderConfig(deepbookNode({ price: 'abc' }))).toThrow(ValidationError);
  expect(() => resolveDeepbookOrderConfig(deepbookNode({ quantity: 'abc' }))).toThrow(ValidationError);
});

test('resolveDeepbookOrderConfig accepts a numeric depositSui (as sent by MCP tool params) and mist-converts it exactly', () => {
  const { config } = resolveDeepbookOrderConfig(deepbookNode({ depositSui: 0.006 }));
  expect(config.depositSui).toBe(0.006);
  expect(suiToMist(config.depositSui, 'depositSui')).toBe(6_000_000n);
});
