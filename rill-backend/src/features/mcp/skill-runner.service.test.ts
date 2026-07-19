import { expect, test } from 'bun:test';
import { mainnetPools, testnetPools } from '@mysten/deepbook-v3';
import { assertExecutionEnvelope, digestUnsignedPtb } from '../../../../packages/rill-sdk/src/execution-envelope';
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

test('rejects an empty flow — neither a DeepBook order nor a supported generic action node', async () => {
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
  )).rejects.toThrow('build_action requires exactly one supported action node');
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

// --- Generic (non-DeepBook) build_action restore: Cetus swap / Haedal stake ------------------
// Regression coverage for the keyless refactor that narrowed `runFlow` to DeepBook-only — the
// compiler already fully supported these two node types (`/simulate` proves it); only `runFlow`
// had fallen behind.

test('builds a steps-based ExecutionEnvelope for a single Cetus swap (generic build_action restore)', async () => {
  const walletPackageId = objectId(1);
  const walletId = objectId(2);
  const agentCapId = objectId(3);
  const sender = objectId(6);
  const poolId = objectId(10);
  const cetusIntegratePkg = objectId(11);
  const cetusGlobalConfig = objectId(12);
  const cetusClmmPkg = objectId(13);
  const fakeUsdc = `${objectId(14)}::usdc::USDC`;
  const SUI = '0x2::sui::SUI';

  const simulate = simulatorService.simulateTransaction;
  const getObject = suiClient.getObject;
  simulatorService.simulateTransaction = async () => ({
    ok: true,
    verification: 'verified',
    gasEstimate: 5,
    balanceChanges: [],
    objectChanges: [],
  });
  // Fake Cetus pool: coinTypeA = FAKE_USDC, coinTypeB = SUI — SUI-in (config.inputCoinType) means
  // a2b=false, output = FAKE_USDC (mirrors compiler.service.test.ts's own Cetus pool mock).
  suiClient.getObject = (async () => ({
    object: { type: `${cetusClmmPkg}::pool::Pool<${fakeUsdc}, ${SUI}>` },
  })) as unknown as typeof suiClient.getObject;

  try {
    const built = await new SkillRunnerService().runFlow(
      {
        nodes: [{
          id: 'swap',
          type: 'cetus_swap',
          config: {
            integratePackageId: cetusIntegratePkg,
            globalConfigId: cetusGlobalConfig,
            pool: poolId,
            inputCoinType: SUI,
            amount_in: '1000000000',
            min_amount_out: '1',
            minSqrtPrice: '4295048016',
            maxSqrtPrice: '79226673515401279992447579055',
          },
        }],
        edges: [],
      },
      {},
      {
        actionId: 'skill_swap',
        sender,
        agentWallet: {
          packageId: walletPackageId,
          walletId,
          capId: agentCapId,
          coinType: SUI,
          versionId: objectId(9),
          capabilityManifest: DEFAULT_MANIFEST,
        },
      },
    );

    if ('refused' in built) throw new Error('expected an ExecutionEnvelope, got a refusal');
    const envelope: ExecutionEnvelope = built;

    // Schema-valid per envelope.schema.ts's broadened (DeepBook-OR-steps) shape.
    expect(assertExecutionEnvelope(envelope)).toEqual(envelope);

    expect(Object.keys(envelope).sort()).toEqual([
      'actionDigest',
      'actionId',
      'agentCapId',
      'allowedTargets',
      'expiresAt',
      'network',
      'preview',
      'requiredGuards',
      'requiredObjectIds',
      'sender',
      'simulation',
      'steps',
      'unsignedPtb',
      'version',
      'walletId',
      'walletPackageId',
    ]);
    expect(envelope).not.toHaveProperty('balanceManagerId');
    expect(envelope).not.toHaveProperty('tradeCapId');
    expect(envelope).not.toHaveProperty('resolvedParams');
    expect(envelope.actionId).toBe('skill_swap');
    expect(envelope.actionDigest).toBe(await digestUnsignedPtb(envelope.unsignedPtb));
    expect(envelope.steps).toEqual([{
      nodeType: 'cetus_swap',
      poolId,
      minOutMist: '1',
      spendAmountMist: '1000000000',
    }]);
    expect(envelope.allowedTargets.some((target) => target.endsWith('::router::swap'))).toBe(true);
    expect(envelope.requiredGuards.some((target) => target.endsWith('::guard::assert_min_value'))).toBe(true);
    expect(envelope.simulation).toEqual({
      ok: true,
      verification: 'verified',
      gasEstimate: 5,
      balanceChanges: [],
      objectChanges: [],
    });
  } finally {
    simulatorService.simulateTransaction = simulate;
    suiClient.getObject = getObject;
  }
});

test('builds a steps-based ExecutionEnvelope for a single Haedal stake (generic build_action restore)', async () => {
  const walletPackageId = objectId(1);
  const walletId = objectId(2);
  const agentCapId = objectId(3);
  const sender = objectId(6);
  const suiSystemStateId = objectId(20);
  const stakingObjectId = objectId(21);
  const stakeTargetPkg = objectId(22);
  const validator = objectId(23);
  const SUI = '0x2::sui::SUI';

  const simulate = simulatorService.simulateTransaction;
  simulatorService.simulateTransaction = async () => ({
    ok: true,
    verification: 'verified',
    gasEstimate: 4,
    balanceChanges: [],
    objectChanges: [],
  });

  try {
    const built = await new SkillRunnerService().runFlow(
      {
        nodes: [{
          id: 'stake',
          type: 'haedal_stake',
          config: {
            stakeTarget: `${stakeTargetPkg}::interface::request_stake`,
            suiSystemStateId,
            stakingObjectId,
            amount: '2000000000',
            validator,
            minStakeMist: '1000000000',
          },
        }],
        edges: [],
      },
      {},
      {
        actionId: 'skill_stake',
        sender,
        agentWallet: {
          packageId: walletPackageId,
          walletId,
          capId: agentCapId,
          coinType: SUI,
          versionId: objectId(9),
          capabilityManifest: DEFAULT_MANIFEST,
        },
      },
    );

    if ('refused' in built) throw new Error('expected an ExecutionEnvelope, got a refusal');
    const envelope: ExecutionEnvelope = built;

    expect(assertExecutionEnvelope(envelope)).toEqual(envelope);
    expect(envelope).not.toHaveProperty('balanceManagerId');
    expect(envelope).not.toHaveProperty('tradeCapId');
    expect(envelope).not.toHaveProperty('resolvedParams');
    expect(envelope.actionId).toBe('skill_stake');
    expect(envelope.steps).toEqual([{
      nodeType: 'haedal_stake',
      validator,
      spendAmountMist: '2000000000',
    }]);
    expect(envelope.allowedTargets.some((target) => target.endsWith('::interface::request_stake'))).toBe(true);
    expect(envelope.simulation.ok).toBe(true);
  } finally {
    simulatorService.simulateTransaction = simulate;
  }
});

test('generic Cetus swap build refuses a failed simulation the same way DeepBook does (R3/KTD-4)', async () => {
  const simulate = simulatorService.simulateTransaction;
  const getObject = suiClient.getObject;
  simulatorService.simulateTransaction = async () => ({
    ok: false,
    verification: 'verified',
    error: 'MoveAbort: slippage exceeded',
    gasEstimate: 0,
    balanceChanges: [],
    objectChanges: [],
  });
  suiClient.getObject = (async () => ({
    object: { type: `${objectId(30)}::pool::Pool<${objectId(31)}::usdc::USDC, 0x2::sui::SUI>` },
  })) as unknown as typeof suiClient.getObject;

  try {
    const result = await new SkillRunnerService().runFlow(
      {
        nodes: [{
          id: 'swap',
          type: 'cetus_swap',
          config: {
            integratePackageId: objectId(32),
            globalConfigId: objectId(33),
            pool: objectId(34),
            inputCoinType: '0x2::sui::SUI',
            amount_in: '1000000000',
            min_amount_out: '1',
            minSqrtPrice: '4295048016',
            maxSqrtPrice: '79226673515401279992447579055',
          },
        }],
        edges: [],
      },
      {},
      {
        actionId: 'skill_swap',
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
    expect(result.actionId).toBe('skill_swap');
    expect(result.reason).toContain('strict simulation');
    expect(Object.keys(result).sort()).toEqual(['actionId', 'reason', 'refused', 'simulation']);
  } finally {
    simulatorService.simulateTransaction = simulate;
    suiClient.getObject = getObject;
  }
});

test('rejects a combo Cetus-swap + Haedal-stake flow (generic path handles exactly one action node)', async () => {
  await expect(new SkillRunnerService().runFlow(
    {
      nodes: [
        { id: 'swap', type: 'cetus_swap', config: { amount_in: '1000000000', min_amount_out: '1' } },
        { id: 'stake', type: 'haedal_stake', config: { amount: '1000000000' } },
      ],
      edges: [],
    },
    {},
    {
      actionId: 'skill_combo',
      sender: objectId(1),
      agentWallet: {
        packageId: objectId(2),
        walletId: objectId(3),
        capId: objectId(4),
        coinType: '0x2::sui::SUI',
      },
    },
  )).rejects.toThrow('build_action requires exactly one supported action node');
});
