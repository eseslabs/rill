import { expect, test } from 'bun:test';
import { assertExecutionEnvelope, digestUnsignedPtb } from '../src/execution-envelope';

test('accepts the minimal hero envelope', async () => {
  const unsignedPtb = Buffer.from('{"version":2}').toString('base64');
  const envelope = {
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

  expect(assertExecutionEnvelope(envelope)).toEqual(envelope);
});

test('rejects an envelope without wallet identity', () => {
  expect(() => assertExecutionEnvelope({ version: '1' })).toThrow('walletPackageId');
});
