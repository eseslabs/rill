import { afterAll, beforeAll, expect, test } from 'bun:test';
import { config, suiClient } from '../../core/config';
import { ValidationError } from '../../core/errors';
import { compilerService } from '../compiler/compiler.service';

/**
 * U4 coverage for cetus.adapter.ts's numeric validation (R6) and the min_amount_out requirement
 * (R7). Mirrors the fixture setup `compiler.service.test.ts` (U3) already uses — same fake pool,
 * same guard package override — since exercising these adapter-level changes needs a full
 * `compileFlow` to reach `rootSuiFunding`/`build()`.
 */

const objectId = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const SUI = '0x2::sui::SUI';
const FAKE_USDC = `${objectId(900)}::usdc::USDC`;
const CETUS_POOL_ID = objectId(100);
const CETUS_INTEGRATE_PKG = objectId(101);
const CETUS_GLOBAL_CONFIG = objectId(102);
const CETUS_CLMM_PKG = objectId(103);
const TEST_GUARD_PACKAGE = objectId(999);

const sender = objectId(1);

let originalGuardPackageId: string | undefined;
let originalGetObject: typeof suiClient.getObject;

beforeAll(() => {
  originalGuardPackageId = config.guardPackageId;
  config.guardPackageId = TEST_GUARD_PACKAGE;

  originalGetObject = suiClient.getObject;
  suiClient.getObject = (async () => ({
    object: { type: `${CETUS_CLMM_PKG}::pool::Pool<${FAKE_USDC}, ${SUI}>` },
  })) as unknown as typeof suiClient.getObject;
});

afterAll(() => {
  config.guardPackageId = originalGuardPackageId;
  suiClient.getObject = originalGetObject;
});

function cetusSwapNode(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'cetus_swap',
    config: {
      integratePackageId: CETUS_INTEGRATE_PKG,
      globalConfigId: CETUS_GLOBAL_CONFIG,
      pool: CETUS_POOL_ID,
      inputCoinType: SUI,
      amount_in: '1000000000',
      minSqrtPrice: '4295048016',
      maxSqrtPrice: '79226673515401279992447579055',
      ...overrides,
    },
  };
}

function guardrailNode(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'guardrail',
    config: {
      minValue: '1',
      coinType: SUI,
      ...overrides,
    },
  };
}

// --- min_amount_out is required (R7) ----------------------------------------

test('a terminal Cetus swap with no min_amount_out and no downstream guardrail is rejected (422)', async () => {
  const flow = { nodes: [cetusSwapNode('s1')], edges: [] };

  await expect(compilerService.compileFlow(flow, { sender })).rejects.toThrow(ValidationError);
  await expect(compilerService.compileFlow(flow, { sender })).rejects.toThrow(/min_amount_out is required/);
});

test('a Cetus swap with no min_amount_out compiles fine when wired into a downstream guardrail', async () => {
  const flow = {
    nodes: [cetusSwapNode('s1'), guardrailNode('g1', { minValue: '1', coinType: FAKE_USDC })],
    edges: [{ source: 's1', sourceHandle: 'coin_out', target: 'g1', targetHandle: 'in' }],
  };

  const result = await compilerService.compileFlow(flow, { sender });
  const targets = result.transaction.getData().commands
    .filter((c) => c.$kind === 'MoveCall')
    .map((c) => c.MoveCall.function);

  // Exactly one assert_min_value — the guardrail's — since the swap itself has no min_amount_out
  // to assert (it was allowed to omit it only because the guardrail covers it).
  expect(targets.filter((t) => t === 'assert_min_value')).toHaveLength(1);
});

test('an explicit min_amount_out is honored even with no guardrail downstream', async () => {
  const flow = { nodes: [cetusSwapNode('s1', { min_amount_out: '1' })], edges: [] };

  const result = await compilerService.compileFlow(flow, { sender });
  const targets = result.transaction.getData().commands
    .filter((c) => c.$kind === 'MoveCall')
    .map((c) => c.MoveCall.function);

  expect(targets).toContain('assert_min_value');
});

// --- Numeric config validation (R6): malformed input -> 422, not a raw crash ---

test('a malformed amount_in is rejected with ValidationError (422), not a raw SyntaxError', async () => {
  const flow = { nodes: [cetusSwapNode('s1', { amount_in: 'abc', min_amount_out: '1' })], edges: [] };

  let thrown: unknown;
  try {
    await compilerService.compileFlow(flow, { sender });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ValidationError);
  expect((thrown as ValidationError).status).toBe(422);
});

test('a negative amount_in is rejected with ValidationError (422)', async () => {
  const flow = { nodes: [cetusSwapNode('s1', { amount_in: '-1', min_amount_out: '1' })], edges: [] };

  await expect(compilerService.compileFlow(flow, { sender })).rejects.toThrow(ValidationError);
});

test('a decimal amount_in ("1.5") where an integer is expected is rejected with ValidationError (422)', async () => {
  const flow = { nodes: [cetusSwapNode('s1', { amount_in: '1.5', min_amount_out: '1' })], edges: [] };

  await expect(compilerService.compileFlow(flow, { sender })).rejects.toThrow(ValidationError);
});

test('a malformed sqrt_price_limit is rejected with ValidationError (422), not a raw crash', async () => {
  const flow = {
    nodes: [cetusSwapNode('s1', { min_amount_out: '1', sqrt_price_limit: 'not-a-number' })],
    edges: [],
  };

  await expect(compilerService.compileFlow(flow, { sender })).rejects.toThrow(ValidationError);
});

test('the default (unset) sqrt_price_limit — a value well past u64::MAX — still compiles fine', async () => {
  // Regression pin for parseConfigU128 vs. parseConfigU64: Cetus's own maxSqrtPrice default
  // (79226673515401279992447579055) exceeds u64::MAX and must not be rejected.
  const flow = { nodes: [cetusSwapNode('s1', { min_amount_out: '1' })], edges: [] };

  const result = await compilerService.compileFlow(flow, { sender });
  expect(result.transaction.getData().commands.some((c) => c.$kind === 'MoveCall')).toBe(true);
});
