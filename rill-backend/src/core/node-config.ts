import { decimalToBaseUnits, parseU64String } from '../../../packages/rill-sdk/src/amounts';
import { ValidationError } from './errors';
import { CETUS, HAEDAL, SUI_CLOCK_ID } from './protocols';
import type { FlowGraph, FlowNode } from '../features/protocols/types';

/**
 * U64-bounded config field (mist amounts, quantities). Wraps the SDK's `parseU64String` so
 * malformed request-supplied config (`"abc"`, `"1.5"`, `"-1"`, empty) throws the backend's
 * `ValidationError` (-> 422) instead of a raw `BigInt()`/`Number()` crashing the process with an
 * uncaught `SyntaxError`/`RangeError` (R6). Exported for the protocol adapters (`cetus.adapter.ts`,
 * `haedal.adapter.ts`) to call at the exact point they used to do a raw `BigInt(...)`.
 */
export function parseConfigU64(value: string, fieldName: string): bigint {
  try {
    return parseU64String(value, fieldName);
  } catch (err) {
    throw new ValidationError(err instanceof Error ? err.message : String(err));
  }
}

/** Sui's u128 maximum — the ceiling for `sqrt_price_limit` (a Q64.64 fixed-point value that can
 *  legitimately exceed u64::MAX; Cetus's own `maxSqrtPrice` default is ~7.9e28). */
const U128_MAX = (1n << 128n) - 1n;

/**
 * U128-bounded config field. Cetus's `sqrt_price_limit` is the one numeric config field in this
 * codebase that is NOT u64-range (see `U128_MAX` above), so the SDK's u64-bounded `parseU64String`
 * would wrongly reject a legitimate value — this applies the same non-negative-integer-string
 * contract without the u64 ceiling, still throwing `ValidationError` instead of a raw `BigInt()`
 * crash (R6).
 */
export function parseConfigU128(value: string, fieldName: string): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new ValidationError(
      `${fieldName} must be a decimal integer string with no sign, decimal point, or scientific `
        + `notation; got ${JSON.stringify(value)}.`,
    );
  }
  const result = BigInt(value);
  if (result > U128_MAX) {
    throw new ValidationError(`${fieldName} exceeds the u128 maximum (${U128_MAX}); got "${value}".`);
  }
  return result;
}

/**
 * Validated decimal-number config field (human units, e.g. a DeepBook order `price`/`quantity`)
 * that this code passes straight through to a downstream SDK as a JS `number` rather than
 * converting to base units itself. Same non-negative/no-scientific-notation/well-formed contract as
 * the SDK's `decimalToBaseUnits`, but returns a validated `number` instead of scaling into a bigint
 * — malformed input (`"abc"`, `""`, `"-1"`, `"1e5"`) throws `ValidationError` instead of silently
 * producing `NaN` (R6) the way a raw `Number(v)` (optionally `|| 0`-defaulted, which maps NaN AND
 * every other falsy edge case to 0 alike) used to.
 */
export function parseConfigDecimalNumber(value: string, fieldName: string): number {
  if (typeof value !== 'string' || value.length === 0 || !/^\d+(\.\d+)?$/.test(value)) {
    throw new ValidationError(`${fieldName} must be a non-negative decimal number; got ${JSON.stringify(value)}.`);
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new ValidationError(`${fieldName} must be a finite decimal number; got "${value}".`);
  }
  return num;
}

/**
 * Convert a validated SUI amount (human units, e.g. `0.006`) to mist — the single float→mist path
 * (KTD-2) that `deepbook.adapter.ts` (funding the on-chain deposit), `skill-runner.service.ts`
 * (mirroring the same amount into the envelope's `spendAmountMist`), and `setup.service.ts`
 * (computing the onboarding order's own deposit) all call, so the three can never diverge again —
 * previously each had its own `Math.round(sui * 1e9)`/`Math.ceil(sui * 1e9)`, meaning the identical
 * `depositSui` input could produce a different mist amount depending on which file computed it.
 * `.toFixed(9)` mirrors the exact pattern `packages/rill-signer/src/policy.ts` (`nineDecimalUnits`)
 * already uses to hand a JS number to the SDK's string-based `decimalToBaseUnits` without
 * reintroducing float parsing on the far side.
 */
export function suiToMist(depositSui: number, fieldName: string): bigint {
  try {
    return decimalToBaseUnits(depositSui.toFixed(9), 9);
  } catch (err) {
    throw new ValidationError(`${fieldName}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface CetusSwapNodeConfig {
  integratePackageId: string;
  globalConfigId: string;
  pool: string;
  inputCoinType: string;
  amount_in: string;
  /** No server default (R7) — required unless the swap's output coin is wired into a downstream
   *  guardrail node that asserts its own floor; `cetus.adapter.ts` enforces that requirement. */
  min_amount_out?: string;
  minSqrtPrice: string;
  maxSqrtPrice: string;
  by_amount_in?: boolean;
  sqrt_price_limit?: string;
}

export interface HaedalStakeNodeConfig {
  stakeTarget: string;
  suiSystemStateId: string;
  stakingObjectId: string;
  amount: string;
  validator?: string;
  minStakeMist: string;
}

const RUNTIME_KEYS: Record<string, readonly string[]> = {
  cetus_swap: ['amount_in', 'min_amount_out'],
  haedal_stake: ['amount'],
  deepbook_limit_order: [
    'poolKey',
    'balanceManagerId',
    'tradeCapId',
    'price',
    'quantity',
    'isBid',
    'payWithDeep',
    'clientOrderId',
    'depositSui',
  ],
};

const FLOW_INPUT_KEYS: Record<string, readonly string[]> = {
  ...RUNTIME_KEYS,
  cetus_swap: [...RUNTIME_KEYS.cetus_swap, 'pool'],
};

function selectAllowedEntries(
  source: Record<string, unknown> | undefined,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!source || allowedKeys.length === 0) {
    return {};
  }

  return Object.fromEntries(Object.entries(source).filter(([key]) => allowedKeys.includes(key)));
}

function fallbackString(
  node: FlowNode,
  warnings: string[],
  key: string,
  fallbackValue: string,
): string {
  const value = pick(node, key);
  if (value == null || value === '') {
    warnings.push(`Node ${node.id}: config.${key} missing — using server default`);
    return fallbackValue;
  }

  return String(value);
}

/** Like `fallbackString`, but returns `undefined` (no warning) when the field is genuinely absent —
 *  for fields that have no safe server default (R7's `min_amount_out`) and must be handled as
 *  "missing" by the caller rather than silently substituted. */
function optionalString(node: FlowNode, key: string): string | undefined {
  const value = pick(node, key);
  return value == null || value === '' ? undefined : String(value);
}

function isTrueLike(value: unknown): boolean {
  return value === true || value === 'true';
}

export function resolveEffectiveFlow(
  flow: FlowGraph,
  runtimeParams: Record<string, unknown> = {},
): FlowGraph {
  const runtimeParamKeys = Object.keys(runtimeParams);

  for (const key of runtimeParamKeys) {
    const matchesFlow = flow.nodes.some((node) => RUNTIME_KEYS[node.type]?.includes(key));
    if (!matchesFlow) {
      throw new ValidationError(
        `Runtime parameter "${key}" does not match an allowed runtime key for any node in this flow.`,
      );
    }
  }

  for (const [nodeType, runtimeKeys] of Object.entries(RUNTIME_KEYS)) {
    if (!runtimeParamKeys.some((key) => runtimeKeys.includes(key))) continue;
    const matchingNodes = flow.nodes.filter((node) => node.type === nodeType).length;
    if (matchingNodes > 1) {
      throw new ValidationError(
        `Flat runtime params for "${nodeType}" require one matching node; found ${matchingNodes}.`,
      );
    }
  }

  return {
    edges: flow.edges.map((edge) => ({ ...edge })),
    nodes: flow.nodes.map((node) => {
      const runtimeKeys = RUNTIME_KEYS[node.type] ?? [];
      const flowInputKeys = FLOW_INPUT_KEYS[node.type] ?? [];

      return {
        ...node,
        config: {
          ...(node.config ?? {}),
          ...selectAllowedEntries(node.inputs, flowInputKeys),
          ...selectAllowedEntries(runtimeParams, runtimeKeys),
        },
        inputs: undefined,
      };
    }),
  };
}

function pick(node: FlowNode, key: string): unknown {
  return node.config?.[key];
}

/** Resolve Cetus swap params — FE should pass full config; server defaults are fallback only. */
export function resolveCetusSwapConfig(
  node: FlowNode,
): { config: CetusSwapNodeConfig; warnings: string[] } {
  const warnings: string[] = [];

  return {
    config: {
      integratePackageId: fallbackString(node, warnings, 'integratePackageId', CETUS.integratePackageId),
      globalConfigId: fallbackString(node, warnings, 'globalConfigId', CETUS.globalConfigId),
      pool: fallbackString(node, warnings, 'pool', CETUS.defaultPoolId),
      inputCoinType: fallbackString(node, warnings, 'inputCoinType', CETUS.defaultInputCoinType),
      amount_in: fallbackString(node, warnings, 'amount_in', '0'),
      // No fallback (R7): a 1-mist "floor" is not a real slippage protection. `cetus.adapter.ts`
      // requires this explicitly unless the swap's output is wired into a downstream guardrail.
      min_amount_out: optionalString(node, 'min_amount_out'),
      minSqrtPrice: fallbackString(node, warnings, 'minSqrtPrice', CETUS.minSqrtPrice),
      maxSqrtPrice: fallbackString(node, warnings, 'maxSqrtPrice', CETUS.maxSqrtPrice),
      by_amount_in: pick(node, 'by_amount_in') !== false,
      sqrt_price_limit: pick(node, 'sqrt_price_limit') as string | undefined,
    },
    warnings,
  };
}

export function resolveHaedalStakeConfig(
  node: FlowNode,
): { config: HaedalStakeNodeConfig; warnings: string[] } {
  const warnings: string[] = [];

  return {
    config: {
      stakeTarget: fallbackString(node, warnings, 'stakeTarget', HAEDAL.stakeTarget),
      suiSystemStateId: fallbackString(node, warnings, 'suiSystemStateId', HAEDAL.suiSystemStateId),
      stakingObjectId: fallbackString(node, warnings, 'stakingObjectId', HAEDAL.stakingObjectId),
      amount: fallbackString(node, warnings, 'amount', '0'),
      validator: (pick(node, 'validator') as string | undefined) ?? '0x0',
      minStakeMist: fallbackString(node, warnings, 'minStakeMist', HAEDAL.minStakeMist.toString()),
    },
    warnings,
  };
}

export interface DeepbookOrderNodeConfig {
  /** Optional — when absent the order params aren't needed (the flow provisions a BalanceManager instead). */
  poolKey?: string;
  /** Optional — when absent, Rill provisions a BalanceManager (DeepBook account) in the PTB. */
  balanceManagerId?: string;
  tradeCapId?: string;
  price?: number;
  quantity?: number;
  isBid: boolean;
  payWithDeep: boolean;
  clientOrderId: string;
  /** SUI (human units) to deposit into the BalanceManager before placing the order (self-funding). 0 = none. */
  depositSui: number;
}

/**
 * Resolve DeepBook limit-order params. Nothing is required at this layer — when `balanceManagerId` is
 * absent the flow provisions a BalanceManager (and order params aren't needed); the adapter validates
 * order params only on the order path. This keeps simulate/compile from erroring before onboarding.
 */
export function resolveDeepbookOrderConfig(
  node: FlowNode,
): { config: DeepbookOrderNodeConfig; warnings: string[] } {
  const str = (key: string): string | undefined => {
    const v = pick(node, key);
    return v == null || v === '' ? undefined : String(v);
  };
  // Validated decimal-number fields (R6): a raw `Number(v)` here used to map both malformed input
  // AND legitimate 0 alike to `NaN`/0 (`Number(v) || 0` swallows NaN into 0 silently) — a garbage
  // `price`/`quantity`/`depositSui` must fail loudly (422), not silently corrupt the order.
  const num = (key: string, fieldName: string): number | undefined => {
    const v = pick(node, key);
    if (v == null || v === '') return undefined;
    return parseConfigDecimalNumber(String(v), fieldName);
  };

  return {
    config: {
      poolKey: str('poolKey'),
      balanceManagerId: str('balanceManagerId'),
      tradeCapId: str('tradeCapId'),
      price: num('price', 'config.price'),
      quantity: num('quantity', 'config.quantity'),
      isBid: isTrueLike(pick(node, 'isBid')),
      payWithDeep: isTrueLike(pick(node, 'payWithDeep')),
      clientOrderId: String(pick(node, 'clientOrderId') ?? '1'),
      depositSui: num('depositSui', 'config.depositSui') ?? 0,
    },
    warnings: [],
  };
}

export { SUI_CLOCK_ID };
