import { expect, test } from 'bun:test';
import { assertExecutionEnvelope, digestUnsignedPtb } from '../src/execution-envelope';

async function baseEnvelope() {
  const unsignedPtb = Buffer.from('{"version":2}').toString('base64');
  return {
    version: '1',
    actionId: 'skill_deepbook',
    actionDigest: await digestUnsignedPtb(unsignedPtb),
    network: 'testnet',
    sender: `0x${'1'.repeat(64)}`,
    walletPackageId: `0x${'2'.repeat(64)}`,
    walletId: `0x${'3'.repeat(64)}`,
    agentCapId: `0x${'4'.repeat(64)}`,
    balanceManagerId: `0x${'5'.repeat(64)}`,
    tradeCapId: `0x${'6'.repeat(64)}`,
    resolvedParams: {
      poolKey: 'SUI_DBUSDC',
      poolId: `0x${'7'.repeat(64)}`,
      price: 1,
      quantity: 0.01,
      isBid: false,
      payWithDeep: false,
      clientOrderId: '71601',
      depositSui: 0.01,
      spendAmountMist: '10000000',
    },
    allowedTargets: ['0x2::module::call'],
    requiredObjectIds: [`0x${'3'.repeat(64)}`],
    requiredGuards: [],
    unsignedPtb,
    preview: 'DeepBook limit order',
    simulation: {
      ok: true,
      verification: 'verified',
      gasEstimate: 1,
      balanceChanges: [],
      objectChanges: [],
    },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

test('accepts the minimal hero envelope', async () => {
  const envelope = await baseEnvelope();
  expect(assertExecutionEnvelope(envelope)).toEqual(envelope);
});

test('rejects an envelope without wallet identity', () => {
  expect(() => assertExecutionEnvelope({ version: '1' })).toThrow('walletPackageId');
});

test("'failed' is a structurally valid verification, so it reaches the signer's fail-closed check", async () => {
  const base = await baseEnvelope();
  const envelope = { ...base, simulation: { ...base.simulation, ok: false, verification: 'failed' } };
  // Must not be rejected as *malformed* — a failed simulation is a well-formed fact about the
  // world. It is the signer's policy check (verification !== 'verified') that must refuse it,
  // so the refusal reason is accurate rather than "envelope is invalid".
  expect(assertExecutionEnvelope(envelope).simulation.verification).toBe('failed');
});

test('rejects a verification value outside the union', async () => {
  const base = await baseEnvelope();
  const envelope = { ...base, simulation: { ...base.simulation, verification: 'probably-fine' } };
  expect(() => assertExecutionEnvelope(envelope)).toThrow('verification is invalid');
});
