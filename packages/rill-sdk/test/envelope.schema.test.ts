import { expect, test } from 'bun:test';
import { ExecutionEnvelopeSchema } from '../src/envelope.schema';
import { assertExecutionEnvelope, digestUnsignedPtb } from '../src/execution-envelope';

const hex = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

/**
 * Realistic backend-shaped envelope fixture — mirrors the exact object literal built by
 * rill-backend/src/features/mcp/skill-runner.service.ts's `runFlow` return value.
 */
async function backendShapedEnvelope() {
  const unsignedPtb = Buffer.from('{"version":2}').toString('base64');
  return {
    version: '1' as const,
    actionId: 'skill_deepbook',
    actionDigest: await digestUnsignedPtb(unsignedPtb),
    network: 'testnet' as const,
    sender: hex(1),
    walletPackageId: hex(2),
    walletId: hex(3),
    agentCapId: hex(4),
    balanceManagerId: hex(5),
    tradeCapId: hex(6),
    resolvedParams: {
      poolKey: 'SUI_DBUSDC',
      poolId: hex(7),
      price: 1,
      quantity: 0.01,
      isBid: false,
      payWithDeep: false,
      clientOrderId: '71601',
      depositSui: 0.01,
      spendAmountMist: '10000000',
    },
    allowedTargets: [`${hex(2)}::agent_wallet::spend`, `${hex(8)}::pool::place_limit_order`],
    requiredObjectIds: [hex(3), hex(5), hex(6)],
    requiredGuards: [] as string[],
    unsignedPtb,
    preview: 'DeepBook limit order: sell 0.01 SUI @ 1',
    simulation: {
      ok: true,
      verification: 'verified' as const,
      gasEstimate: 7,
      balanceChanges: [] as { owner: string; coinType: string; amount: string }[],
      objectChanges: [] as { type: 'mutated' | 'created' | 'deleted'; objectId: string; objectType: string }[],
    },
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
}

// --- Realistic backend-shaped fixture validates -------------------------------------------------

test('a realistic backend-shaped envelope fixture validates against the schema', async () => {
  const envelope = await backendShapedEnvelope();
  const result = ExecutionEnvelopeSchema.safeParse(envelope);
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data).toEqual(envelope);
  }
});

test('a realistic backend-shaped envelope fixture validates via assertExecutionEnvelope', async () => {
  const envelope = await backendShapedEnvelope();
  expect(assertExecutionEnvelope(envelope)).toEqual(envelope);
});

test('a fixture with populated arrays, an optional simulation.error, and object/balance changes validates', async () => {
  const base = await backendShapedEnvelope();
  const envelope = {
    ...base,
    allowedTargets: [...base.allowedTargets, `${hex(9)}::balance_manager::deposit`],
    requiredObjectIds: [...base.requiredObjectIds, '0x6'],
    requiredGuards: [`${hex(10)}::guard::assert_min_value`],
    simulation: {
      ...base.simulation,
      error: 'non-fatal warning from devInspect',
      balanceChanges: [{ owner: hex(1), coinType: '0x2::sui::SUI', amount: '-10000000' }],
      objectChanges: [{ type: 'mutated' as const, objectId: hex(5), objectType: `${hex(8)}::balance_manager::BalanceManager` }],
    },
  };
  const result = ExecutionEnvelopeSchema.safeParse(envelope);
  expect(result.success).toBe(true);
});

// --- Strict: unknown fields fail -----------------------------------------------------------------

test('an envelope with one extra unknown top-level field fails (strict)', async () => {
  const envelope = { ...(await backendShapedEnvelope()), simulationGate: true };
  const result = ExecutionEnvelopeSchema.safeParse(envelope);
  expect(result.success).toBe(false);
});

test('an envelope with one extra unknown top-level field fails via assertExecutionEnvelope', async () => {
  const envelope = { ...(await backendShapedEnvelope()), simulationGate: true };
  expect(() => assertExecutionEnvelope(envelope)).toThrow();
});

test('an extra unknown field nested in resolvedParams fails (strict)', async () => {
  const base = await backendShapedEnvelope();
  const envelope = { ...base, resolvedParams: { ...base.resolvedParams, extraField: 'nope' } };
  expect(ExecutionEnvelopeSchema.safeParse(envelope).success).toBe(false);
});

test('an extra unknown field nested in simulation fails (strict)', async () => {
  const base = await backendShapedEnvelope();
  const envelope = { ...base, simulation: { ...base.simulation, simulatedViaFallback: true } };
  expect(ExecutionEnvelopeSchema.safeParse(envelope).success).toBe(false);
});

// --- Tampered resolvedParams types fail -----------------------------------------------------------

test('tampering resolvedParams.price to a string fails', async () => {
  const base = await backendShapedEnvelope();
  const envelope = { ...base, resolvedParams: { ...base.resolvedParams, price: '1' } };
  expect(ExecutionEnvelopeSchema.safeParse(envelope).success).toBe(false);
});

test('tampering resolvedParams.isBid to a string fails', async () => {
  const base = await backendShapedEnvelope();
  const envelope = { ...base, resolvedParams: { ...base.resolvedParams, isBid: 'false' } };
  expect(ExecutionEnvelopeSchema.safeParse(envelope).success).toBe(false);
});

test('tampering resolvedParams.spendAmountMist to a number fails', async () => {
  const base = await backendShapedEnvelope();
  const envelope = { ...base, resolvedParams: { ...base.resolvedParams, spendAmountMist: 10000000 } };
  expect(ExecutionEnvelopeSchema.safeParse(envelope).success).toBe(false);
});

test('tampering resolvedParams.quantity to null fails', async () => {
  const base = await backendShapedEnvelope();
  const envelope = { ...base, resolvedParams: { ...base.resolvedParams, quantity: null } };
  expect(ExecutionEnvelopeSchema.safeParse(envelope).success).toBe(false);
});

// --- Required-field and enum coverage (mirrors current assertExecutionEnvelope semantics) --------

test('version must be the literal "1"', async () => {
  const envelope = { ...(await backendShapedEnvelope()), version: '2' };
  expect(ExecutionEnvelopeSchema.safeParse(envelope).success).toBe(false);
});

test('network must be one of the known networks', async () => {
  const envelope = { ...(await backendShapedEnvelope()), network: 'devnet' };
  expect(ExecutionEnvelopeSchema.safeParse(envelope).success).toBe(false);
});

test('network accepts mainnet', async () => {
  const envelope = { ...(await backendShapedEnvelope()), network: 'mainnet' };
  expect(ExecutionEnvelopeSchema.safeParse(envelope).success).toBe(true);
});

test('simulation.verification must be one of the known verifications', async () => {
  const base = await backendShapedEnvelope();
  const envelope = { ...base, simulation: { ...base.simulation, verification: 'trusted-me-bro' } };
  expect(ExecutionEnvelopeSchema.safeParse(envelope).success).toBe(false);
});

test('a required string field cannot be empty', async () => {
  const envelope = { ...(await backendShapedEnvelope()), walletPackageId: '' };
  expect(ExecutionEnvelopeSchema.safeParse(envelope).success).toBe(false);
});

test('requiredGuards may be an empty array', async () => {
  const envelope = { ...(await backendShapedEnvelope()), requiredGuards: [] };
  expect(ExecutionEnvelopeSchema.safeParse(envelope).success).toBe(true);
});

test('allowedTargets must be an array of strings', async () => {
  const envelope = { ...(await backendShapedEnvelope()), allowedTargets: [1, 2, 3] };
  expect(ExecutionEnvelopeSchema.safeParse(envelope).success).toBe(false);
});

test('missing wallet identity is rejected with an actionable message', async () => {
  expect(() => assertExecutionEnvelope({ version: '1' })).toThrow('walletPackageId');
});

test('a non-object value is rejected', () => {
  expect(() => assertExecutionEnvelope('not an object')).toThrow();
  expect(() => assertExecutionEnvelope(null)).toThrow();
  expect(() => assertExecutionEnvelope([])).toThrow();
});

test('simulation.gasEstimate must be a finite number', async () => {
  const base = await backendShapedEnvelope();
  const envelope = { ...base, simulation: { ...base.simulation, gasEstimate: Number.POSITIVE_INFINITY } };
  expect(ExecutionEnvelopeSchema.safeParse(envelope).success).toBe(false);
});
