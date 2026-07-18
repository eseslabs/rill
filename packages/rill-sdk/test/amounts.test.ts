import { expect, test } from 'bun:test';
import { decimalToBaseUnits, parseU64String, U64_MAX } from '../src/amounts';

// --- decimalToBaseUnits: accepted values -----------------------------------------------------

test('"1" @9 decimals -> 1000000000n', () => {
  expect(decimalToBaseUnits('1', 9)).toBe(1000000000n);
});

test('"1.5" @6 decimals -> 1500000n', () => {
  expect(decimalToBaseUnits('1.5', 6)).toBe(1500000n);
});

test('"0.000000001" @9 decimals -> 1n (exact precision boundary)', () => {
  expect(decimalToBaseUnits('0.000000001', 9)).toBe(1n);
});

test('"0" @9 decimals -> 0n', () => {
  expect(decimalToBaseUnits('0', 9)).toBe(0n);
});

test('"0.5" @1 decimal -> 5n', () => {
  expect(decimalToBaseUnits('0.5', 1)).toBe(5n);
});

test('whole number with no fractional part @0 decimals is accepted', () => {
  expect(decimalToBaseUnits('42', 0)).toBe(42n);
});

test('leading zeros in the whole part are tolerated', () => {
  expect(decimalToBaseUnits('007.5', 6)).toBe(7500000n);
});

test('value exactly at the u64 maximum is accepted', () => {
  expect(decimalToBaseUnits('18446744073709551615', 0)).toBe(18446744073709551615n);
});

// --- decimalToBaseUnits: rejections -----------------------------------------------------------

test('"1e-10" @9 decimals is rejected (scientific notation)', () => {
  expect(() => decimalToBaseUnits('1e-10', 9)).toThrow();
});

test('"abc" is rejected (non-numeric)', () => {
  expect(() => decimalToBaseUnits('abc', 9)).toThrow();
});

test('"" is rejected (empty)', () => {
  expect(() => decimalToBaseUnits('', 9)).toThrow();
});

test('"-1" is rejected (negative)', () => {
  expect(() => decimalToBaseUnits('-1', 9)).toThrow();
});

test('"1.2.3" is rejected (multiple dots)', () => {
  expect(() => decimalToBaseUnits('1.2.3', 9)).toThrow();
});

test('a value exceeding u64 max is rejected', () => {
  expect(() => decimalToBaseUnits('18446744073709551616', 0)).toThrow();
});

test('a value that only exceeds u64 max after decimal shifting is rejected', () => {
  expect(() => decimalToBaseUnits('20000000000', 9)).toThrow();
});

test('more fractional digits than the token allows is rejected (precision loss)', () => {
  expect(() => decimalToBaseUnits('1.0000000001', 9)).toThrow();
});

test('a fractional value against a zero-decimal token is rejected', () => {
  expect(() => decimalToBaseUnits('1.5', 0)).toThrow();
});

test('a leading "+" sign is rejected', () => {
  expect(() => decimalToBaseUnits('+1', 9)).toThrow();
});

test('whitespace is rejected rather than silently trimmed', () => {
  expect(() => decimalToBaseUnits(' 1', 9)).toThrow();
  expect(() => decimalToBaseUnits('1 ', 9)).toThrow();
});

test('a bare decimal point is rejected', () => {
  expect(() => decimalToBaseUnits('.', 9)).toThrow();
});

test('NaN and Infinity string forms are rejected', () => {
  expect(() => decimalToBaseUnits('NaN', 9)).toThrow();
  expect(() => decimalToBaseUnits('Infinity', 9)).toThrow();
});

// --- decimalToBaseUnits: error messages are field-actionable -----------------------------------

test('error messages echo the offending value so callers can surface it', () => {
  expect(() => decimalToBaseUnits('abc', 9)).toThrow(/abc/);
  expect(() => decimalToBaseUnits('1.2.3', 9)).toThrow(/1\.2\.3/);
});

// --- parseU64String: accepted values ------------------------------------------------------------

test('parseU64String accepts a plain decimal integer string', () => {
  expect(parseU64String('10000000', 'spendAmountMist')).toBe(10000000n);
});

test('parseU64String accepts "0"', () => {
  expect(parseU64String('0', 'budgetMist')).toBe(0n);
});

test('parseU64String accepts the u64 maximum', () => {
  expect(parseU64String(U64_MAX.toString(), 'budgetMist')).toBe(U64_MAX);
});

// --- parseU64String: rejections -------------------------------------------------------------------

test('parseU64String rejects a decimal (fractional) string', () => {
  expect(() => parseU64String('1.5', 'depositSui')).toThrow('depositSui');
});

test('parseU64String rejects garbage', () => {
  expect(() => parseU64String('not-a-number', 'clientOrderId')).toThrow('clientOrderId');
});

test('parseU64String rejects empty string', () => {
  expect(() => parseU64String('', 'expiresAtMs')).toThrow('expiresAtMs');
});

test('parseU64String rejects a negative integer string', () => {
  expect(() => parseU64String('-5', 'perTxMist')).toThrow('perTxMist');
});

test('parseU64String rejects a value exceeding u64', () => {
  expect(() => parseU64String('18446744073709551616', 'budgetMist')).toThrow('budgetMist');
});

test('parseU64String includes the field name in the error message', () => {
  expect(() => parseU64String('abc', 'minimumRemainingMist')).toThrow(/minimumRemainingMist/);
});

// --- U64_MAX sanity ---------------------------------------------------------------------------

test('U64_MAX matches the canonical u64 maximum', () => {
  expect(U64_MAX).toBe(18446744073709551615n);
});
