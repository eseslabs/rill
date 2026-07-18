/**
 * The single money path (KTD-2): every decimal-string → base-unit conversion in Rill — backend,
 * frontend, and signer — goes through `decimalToBaseUnits`/`parseU64String` instead of ad hoc
 * `parseFloat`/`Number` arithmetic. Pure string/bigint math only; no floating point ever touches
 * a token amount, so there is no round/ceil divergence between call sites and no precision loss
 * hiding in an IEEE-754 double.
 */

/** Sui's u64 maximum — the ceiling for any on-chain amount, budget, or timestamp field. */
export const U64_MAX = 18446744073709551615n;

/**
 * Convert a human-entered decimal string into base units (bigint) for a token with the given
 * number of decimals. E.g. `decimalToBaseUnits('1.5', 6) === 1500000n`.
 *
 * Pure string math — never routes through `parseFloat`/`Number`, so it cannot inherit IEEE-754
 * rounding error. Rejects (throws with a clear, value-echoing message):
 *   - empty input
 *   - non-numeric input
 *   - negative input (and a leading `+` sign)
 *   - scientific notation (`1e-10`)
 *   - more than one decimal point
 *   - more fractional digits than `decimals` allows (precision loss — silently truncating would
 *     misrepresent the amount the caller asked for)
 *   - a result exceeding the u64 maximum
 */
export function decimalToBaseUnits(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`decimalToBaseUnits: decimals must be a non-negative integer, got ${String(decimals)}.`);
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('decimalToBaseUnits: value must be a non-empty string.');
  }
  if (value.includes('e') || value.includes('E')) {
    throw new Error(`decimalToBaseUnits: "${value}" uses scientific notation, which is not allowed.`);
  }
  if (value.startsWith('-')) {
    throw new Error(`decimalToBaseUnits: "${value}" must not be negative.`);
  }
  if (value.startsWith('+')) {
    throw new Error(`decimalToBaseUnits: "${value}" must not have a leading sign.`);
  }
  const dotCount = (value.match(/\./g) ?? []).length;
  if (dotCount > 1) {
    throw new Error(`decimalToBaseUnits: "${value}" has more than one decimal point.`);
  }
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`decimalToBaseUnits: "${value}" is not a valid decimal number.`);
  }

  const [wholePart, fractionalPart = ''] = value.split('.');
  if (fractionalPart.length > decimals) {
    throw new Error(
      `decimalToBaseUnits: "${value}" has ${fractionalPart.length} fractional digits, `
        + `more than the ${decimals} this token supports (precision loss).`,
    );
  }

  const digits = `${wholePart}${fractionalPart.padEnd(decimals, '0')}`;
  const normalizedDigits = digits.replace(/^0+(?=\d)/, '');
  const result = BigInt(normalizedDigits);
  if (result > U64_MAX) {
    throw new Error(`decimalToBaseUnits: "${value}" exceeds the u64 maximum (${U64_MAX}).`);
  }
  return result;
}

/**
 * Parse a decimal u64 integer string (no sign, no decimal point, no scientific notation) — for
 * fields that are already denominated in base units (e.g. `spendAmountMist`, `budgetMist`,
 * `expiresAtMs`). Rejects decimals and garbage; returns a bigint no greater than `U64_MAX`.
 *
 * `fieldName` is echoed into the error message so validation failures are actionable at the call
 * site (an API handler, a CLI flag, a policy file) without the caller re-wrapping the error.
 */
export function parseU64String(value: string, fieldName: string): bigint {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty decimal integer string.`);
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `${fieldName} must be a decimal integer string with no sign, decimal point, or scientific `
        + `notation; got "${value}".`,
    );
  }
  const result = BigInt(value);
  if (result > U64_MAX) {
    throw new Error(`${fieldName} exceeds the u64 maximum (${U64_MAX}); got "${value}".`);
  }
  return result;
}
