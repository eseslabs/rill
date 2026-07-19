import { expect, test } from 'bun:test';
import { mainnetPools, testnetPools } from '@mysten/deepbook-v3';
import { digestUnsignedPtb } from '../../../../packages/rill-sdk/src/execution-envelope';
import type { ExecutionEnvelope } from '../../../../packages/rill-sdk/src/types';
import type { CapabilityManifest } from '../../../../packages/rill-sdk/src/capability-manifest';
import { config, suiClient } from '../../core/config';
import { simulatorService } from '../compiler/simulator.service';
import { SkillRunnerService } from './skill-runner.service';

const objectId = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

// There is ONE agent_wallet package now — every bound wallet requires a capabilityManifest +
// versionId (no legacy manifest-less spend() fallback).
const DEFAULT_MANIFEST: CapabilityManifest = {
  walletCoinType: '0x2::sui::SUI',
  rules: [{ kind: 'budget', totalMist: '5000000000' }],
};

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
    const built = await new SkillRunnerService().runFlow(
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
          versionId: objectId(9),
          capabilityManifest: DEFAULT_MANIFEST,
        },
      },
    );

    if ('refused' in built) throw new Error('expected an ExecutionEnvelope, got a refusal');
    const envelope: ExecutionEnvelope = built;

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

test('refuses to return an ExecutionEnvelope when strict simulation fails — no carve-out (R3/KTD-4)', async () => {
  const poolKey = config.network === 'testnet' ? 'SUI_DBUSDC' : 'SUI_USDC';
  const simulate = simulatorService.simulateTransaction;
  const getBalance = suiClient.core.getBalance;
  simulatorService.simulateTransaction = async () => ({
    ok: false,
    verification: 'verified',
    error: 'MoveAbort: insufficient balance',
    gasEstimate: 0,
    balanceChanges: [],
    objectChanges: [],
  });
  suiClient.core.getBalance = async () => ({
    balance: { coinType: '0x2::sui::SUI', balance: '0', coinBalance: '0', addressBalance: '0' },
  });

  try {
    const result = await new SkillRunnerService().runFlow(
      {
        nodes: [{
          id: 'order',
          type: 'deepbook_limit_order',
          config: {
            poolKey,
            balanceManagerId: objectId(4),
            tradeCapId: objectId(5),
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
        sender: objectId(6),
        agentWallet: {
          packageId: objectId(1),
          walletId: objectId(2),
          capId: objectId(3),
          coinType: '0x2::sui::SUI',
          versionId: objectId(9),
          capabilityManifest: DEFAULT_MANIFEST,
        },
      },
    );

    if (!('refused' in result)) throw new Error('expected a refusal object, got something else');
    expect(result.refused).toBe(true);
    expect(result.actionId).toBe('skill_deepbook');
    expect(result.reason).toContain('strict simulation');
    expect(result.simulation.ok).toBe(false);
    // Deliberately NOT envelope-shaped — no field lets a careless caller mistake this for something
    // signable.
    expect(result).not.toHaveProperty('unsignedPtb');
    expect(result).not.toHaveProperty('actionDigest');
    expect(result).not.toHaveProperty('version');
    expect(Object.keys(result).sort()).toEqual(['actionId', 'reason', 'refused', 'simulation']);
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
  )).rejects.toThrow('requires exactly one DeepBook limit-order node');
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
  )).rejects.toThrow('requires exactly one DeepBook limit-order node; found 2');
});
