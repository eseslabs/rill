import { expect, test } from 'bun:test';
import { mainnetPools, testnetPools } from '@mysten/deepbook-v3';
import { digestUnsignedPtb } from '../../../../packages/rill-sdk/src/execution-envelope';
import type { ExecutionEnvelope } from '../../../../packages/rill-sdk/src/types';
import { config, suiClient } from '../../core/config';
import { simulatorService } from '../compiler/simulator.service';
import { SkillRunnerService } from './skill-runner.service';

const objectId = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

test('builds the minimal DeepBook ExecutionEnvelope without signing', async () => {
  const poolKey = config.network === 'testnet' ? 'SUI_DBUSDC' : 'SUI_USDC';
  const pools = config.network === 'testnet' ? testnetPools : mainnetPools;
  const walletPackageId = objectId(1);
  const walletId = objectId(2);
  const agentCapId = objectId(3);
  const balanceManagerId = objectId(4);
  const tradeCapId = objectId(5);
  const sender = objectId(6);
  const simulate = simulatorService.simulateTransaction;
  const getBalance = suiClient.core.getBalance;
  simulatorService.simulateTransaction = async () => ({
    ok: true,
    verification: 'verified',
    gasEstimate: 7,
    balanceChanges: [],
    objectChanges: [],
  });
  suiClient.core.getBalance = async () => ({
    balance: {
      coinType: '0x2::sui::SUI',
      balance: '0',
      coinBalance: '0',
      addressBalance: '0',
    },
  });

  try {
    const envelope: ExecutionEnvelope = await new SkillRunnerService().runFlow(
      {
        nodes: [{
          id: 'order',
          type: 'deepbook_limit_order',
          config: {
            poolKey,
            balanceManagerId,
            tradeCapId,
            price: 1,
            quantity: 0.01,
            isBid: false,
            payWithDeep: false,
            clientOrderId: '71601',
            depositSui: 0.01,
          },
        }],
        edges: [],
      },
      {},
      {
        actionId: 'skill_deepbook',
        sender,
        agentWallet: {
          packageId: walletPackageId,
          walletId,
          capId: agentCapId,
          coinType: '0x2::sui::SUI',
        },
      },
    );

    expect(Object.keys(envelope).sort()).toEqual([
      'actionDigest',
      'actionId',
      'agentCapId',
      'allowedTargets',
      'balanceManagerId',
      'expiresAt',
      'network',
      'preview',
      'requiredGuards',
      'requiredObjectIds',
      'resolvedParams',
      'sender',
      'simulation',
      'tradeCapId',
      'unsignedPtb',
      'version',
      'walletId',
      'walletPackageId',
    ]);
    expect(envelope.actionId).toBe('skill_deepbook');
    expect(envelope.actionDigest).toBe(await digestUnsignedPtb(envelope.unsignedPtb));
    expect(envelope.walletPackageId).toBe(walletPackageId);
    expect(envelope.walletId).toBe(walletId);
    expect(envelope.agentCapId).toBe(agentCapId);
    expect(envelope.balanceManagerId).toBe(balanceManagerId);
    expect(envelope.tradeCapId).toBe(tradeCapId);
    expect(envelope.resolvedParams).toEqual({
      poolKey,
      poolId: pools[poolKey].address,
      balanceManagerId,
      tradeCapId,
      price: 1,
      quantity: 0.01,
      isBid: false,
      payWithDeep: false,
      clientOrderId: '71601',
      depositSui: 0.01,
      spendAmountMist: '10000000',
    });
    expect(envelope.allowedTargets.some((target) => target.endsWith('::pool::place_limit_order'))).toBe(true);
    expect(envelope.allowedTargets).toEqual([...new Set(envelope.allowedTargets)]);
    expect(envelope.requiredObjectIds).toContain(balanceManagerId);
    expect(envelope.requiredObjectIds).toContain(tradeCapId);
    expect(envelope.requiredObjectIds).toContain(pools[poolKey].address);
    expect(envelope.requiredObjectIds).toEqual([...new Set(envelope.requiredObjectIds)]);
    expect(envelope.simulation).toEqual({
      ok: true,
      verification: 'verified',
      gasEstimate: 7,
      balanceChanges: [],
      objectChanges: [],
    });
  } finally {
    simulatorService.simulateTransaction = simulate;
    suiClient.core.getBalance = getBalance;
  }
});

test('rejects action builds without a DeepBook limit order', async () => {
  await expect(new SkillRunnerService().runFlow(
    { nodes: [], edges: [] },
    {},
    {
      actionId: 'skill_empty',
      sender: objectId(1),
      agentWallet: {
        packageId: objectId(2),
        walletId: objectId(3),
        capId: objectId(4),
        coinType: '0x2::sui::SUI',
      },
    },
  )).rejects.toThrow('Cannot build an empty flow.');
});

test('rejects action builds with multiple DeepBook limit orders', async () => {
  await expect(new SkillRunnerService().runFlow(
    {
      nodes: [
        { id: 'order-1', type: 'deepbook_limit_order' },
        { id: 'order-2', type: 'deepbook_limit_order' },
      ],
      edges: [],
    },
    {},
    {
      actionId: 'skill_ambiguous',
      sender: objectId(1),
      agentWallet: {
        packageId: objectId(2),
        walletId: objectId(3),
        capId: objectId(4),
        coinType: '0x2::sui::SUI',
      },
    },
  )).rejects.toThrow('pre-provisioned BalanceManager');
});
