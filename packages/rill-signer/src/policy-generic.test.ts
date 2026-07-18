import { expect, test } from 'bun:test';
import { Transaction } from '@mysten/sui/transactions';
import { digestUnsignedPtb } from '../../rill-sdk/src/execution-envelope';
import type { EnvelopeStep, ExecutionEnvelope } from '../../rill-sdk/src/types';
import { assertCapabilitiesActive, inspectGeneric, validateExecutionEnvelope, type LocalSignerPolicy } from './policy';
import { normalized } from './steps/types';

const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const walletPackageId = id(1);
const cetusPackageId = id(2);
const guardPackageId = id(3);
const haedalPackageId = id(4);
const sender = id(5);
// NOTE: kept well clear of 0x1-0x6 (framework packages + the Sui clock object id) so no object id
// here accidentally normalizes to the same address as the clock, which would collapse in the
// deduped object-id Set inspectGeneric returns.
const walletId = id(16);
const agentCapId = id(17);
const coinTypeSui = '0x2::sui::SUI';
const coinTypeUsdc = `${id(21)}::usdc::USDC`;
const poolId = id(18);
const validatorAddr = id(30);

const swapAmount = 100_000_000n;
const stakeAmount = 1_000_000_000n;
const totalAmount = swapAmount + stakeAmount;
const minOut = 68_210n;

/**
 * Hand-built two-step Cetus -> Haedal PTB: one agent_wallet::spend, then a Cetus swap fragment
 * (its own SplitCoins off the spend + router::swap + guard::assert_min_value), then a Haedal stake
 * fragment (its own, separate SplitCoins off the same spend + request_stake), then a terminal
 * merge-to-gas of the spend remainder. Each protocol leg funds itself independently from the single
 * wallet spend — deepbook.ts's docstring documents this as the expected multi-step shape.
 */
function buildTwoStepPtb(options: { omitMerge?: boolean } = {}): Transaction {
  const tx = new Transaction();
  tx.setSender(sender);

  const spendResult = tx.moveCall({
    target: `${walletPackageId}::agent_wallet::spend`,
    typeArguments: [coinTypeSui],
    arguments: [tx.object(walletId), tx.object(agentCapId), tx.pure.u64(totalAmount), tx.object('0x6')],
  }); // index 0

  const [cetusCoin] = tx.splitCoins(spendResult, [swapAmount]); // index 1
  const zeroCoin = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [coinTypeUsdc], arguments: [] }); // index 2

  const [, outB] = tx.moveCall({
    target: `${cetusPackageId}::router::swap`,
    typeArguments: [coinTypeSui, coinTypeUsdc],
    arguments: [
      tx.object(id(9)), // globalConfig
      tx.object(poolId),
      cetusCoin,
      zeroCoin,
      tx.pure.bool(true),
      tx.pure.bool(true),
      tx.pure.u64(swapAmount),
      tx.pure.u128(0n),
      tx.pure.bool(false),
      tx.object('0x6'),
    ],
  }); // index 3

  tx.moveCall({
    target: `${guardPackageId}::guard::assert_min_value`,
    typeArguments: [coinTypeUsdc],
    arguments: [outB, tx.pure.u64(minOut)],
  }); // index 4

  const [haedalCoin] = tx.splitCoins(spendResult, [stakeAmount]); // index 5

  tx.moveCall({
    target: `${haedalPackageId}::interface::request_stake`,
    typeArguments: [],
    arguments: [tx.object(id(10)), tx.object(id(11)), haedalCoin, tx.pure.address(validatorAddr)],
  }); // index 6

  if (!options.omitMerge) {
    tx.mergeCoins(tx.gas, [spendResult]); // index 7
  }

  return tx;
}

const steps: EnvelopeStep[] = [
  { nodeType: 'cetus_swap', poolId, minOutMist: minOut.toString(), spendAmountMist: swapAmount.toString() },
  { nodeType: 'haedal_stake', validator: validatorAddr, spendAmountMist: stakeAmount.toString() },
];

test('inspectGeneric validates a hand-built two-step Cetus->Haedal PTB', () => {
  const tx = buildTwoStepPtb();
  const result = inspectGeneric(tx, { walletPackageId, walletId, agentCapId, steps });

  expect(result.spendAmountMist).toBe(totalAmount);
  expect(result.targets.sort()).toEqual(
    [
      `${normalized(cetusPackageId)}::router::swap`,
      `${normalized(guardPackageId)}::guard::assert_min_value`,
      `${normalized(haedalPackageId)}::interface::request_stake`,
    ].sort(),
  );
  expect(result.objectIds.sort()).toEqual(
    [normalized(walletId), normalized(agentCapId), normalized('0x6'), normalized(poolId)].sort(),
  );
  expect(result.guards).toEqual([`${normalized(guardPackageId)}::guard::assert_min_value`]);
  expect(result.callTargets).toEqual([
    `${normalized(walletPackageId)}::agent_wallet::spend`,
    `${normalized('0x2')}::coin::zero`,
    `${normalized(cetusPackageId)}::router::swap`,
    `${normalized(guardPackageId)}::guard::assert_min_value`,
    `${normalized(haedalPackageId)}::interface::request_stake`,
  ]);
});

test('inspectGeneric rejects a PTB missing the wallet spend', () => {
  const tx = new Transaction();
  tx.setSender(sender);
  tx.moveCall({ target: '0x2::coin::zero', typeArguments: [coinTypeSui], arguments: [] });
  expect(() => inspectGeneric(tx, { walletPackageId, walletId, agentCapId, steps: [] })).toThrow(
    'missing the wallet spend',
  );
});

test('inspectGeneric rejects an unknown step nodeType (fail-closed registry lookup)', () => {
  const tx = buildTwoStepPtb();
  const unknownSteps = [{ nodeType: 'navi_supply' } as unknown as EnvelopeStep];
  expect(() => inspectGeneric(tx, { walletPackageId, walletId, agentCapId, steps: unknownSteps })).toThrow(
    'No validator for step',
  );
});

test('inspectGeneric rejects a PTB whose terminal command is not the merge-to-gas', () => {
  const tx = buildTwoStepPtb({ omitMerge: true });
  expect(() => inspectGeneric(tx, { walletPackageId, walletId, agentCapId, steps })).toThrow(
    'merging only the wallet spend remainder into gas',
  );
});

// ── validateExecutionEnvelope generic branch: adversarial suite ──────────────────────────────────
//
// Task 8: proves the generalization did not weaken any fail-closed guarantee. Builds ONE valid
// two-step Cetus->Haedal envelope + matching steps-based policy, then mutates ONE thing per test and
// asserts validateExecutionEnvelope THROWS. If any of these were to resolve instead of reject, the
// generic branch would have a hole — see the plan's "Read before starting" safety model.

const evilTarget = `${id(77)}::evil::drain`;

// inspectGeneric's `targets` field (used for the "target set == envelope.allowedTargets" check) is
// built ONLY from what each step validator explicitly reports back — NOT from a raw scan of every
// PTB command — so it deliberately excludes the wallet spend call and intermediate helper calls like
// `0x2::coin::zero` (see inspectGeneric's step 2). `callTargets` (used for the exact-sequence check
// against policy.allowedTargets) IS the raw full scan. A valid fixture therefore needs two different
// lists: envelope.allowedTargets == exactly the step-attributed targets (this constant), and
// policy.allowedTargets == the full ordered call sequence including spend/coin::zero (below).
const genericStepTargets = [
  `${cetusPackageId}::router::swap`,
  `${guardPackageId}::guard::assert_min_value`,
  `${haedalPackageId}::interface::request_stake`,
];

const genericPolicy: LocalSignerPolicy = {
  version: '1',
  actionId: 'skill_cetus_haedal',
  network: 'testnet',
  sender,
  walletPackageId,
  walletId,
  agentCapId,
  // Legacy-shaped fields LocalSignerPolicy still requires (the interface keeps every existing field
  // to back the legacy path) — unused by the generic branch, so benign placeholders are fine here.
  balanceManagerId: id(50),
  tradeCapId: id(51),
  poolId,
  allowedTargets: [
    `${walletPackageId}::agent_wallet::spend`,
    '0x2::coin::zero',
    `${cetusPackageId}::router::swap`,
    `${guardPackageId}::guard::assert_min_value`,
    `${haedalPackageId}::interface::request_stake`,
  ],
  requiredGuards: [`${guardPackageId}::guard::assert_min_value`],
  maxAmountMist: '10000000000',
  minimumRemainingMist: '0',
  demoParams: {
    poolKey: 'unused',
    price: 1,
    quantity: 1,
    isBid: false,
    payWithDeep: false,
    clientOrderId: '1',
    depositSui: 1,
  },
  onChainOrder: {
    clientOrderId: '1',
    orderType: '0',
    selfMatchingOption: '0',
    price: '1',
    quantity: '1',
    isBid: false,
    payWithDeep: false,
    expiration: '1',
  },
  steps,
};

/**
 * The same two-step Cetus->Haedal shape as buildTwoStepPtb, with extra knobs for each adversarial
 * scenario below. Kept separate from buildTwoStepPtb (used by the inspectGeneric-direct tests above)
 * so those tests' fixture stays untouched.
 */
function buildAdversarialPtb(options: {
  reorder?: boolean;
  extraCommand?: boolean;
  offScopeCall?: boolean;
  minOutOverride?: bigint;
  omitGuard?: boolean;
  omitMerge?: boolean;
  trailingCommand?: boolean;
} = {}): Transaction {
  const tx = new Transaction();
  tx.setSender(sender);

  const spendResult = tx.moveCall({
    target: `${walletPackageId}::agent_wallet::spend`,
    typeArguments: [coinTypeSui],
    arguments: [tx.object(walletId), tx.object(agentCapId), tx.pure.u64(totalAmount), tx.object('0x6')],
  });

  const buildSwapFragment = () => {
    const [cetusCoin] = tx.splitCoins(spendResult, [swapAmount]);
    const zeroCoin = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [coinTypeUsdc], arguments: [] });
    if (options.extraCommand) {
      tx.moveCall({ target: '0x2::coin::zero', typeArguments: [coinTypeUsdc], arguments: [] });
    }
    if (options.offScopeCall) {
      tx.moveCall({ target: evilTarget, arguments: [] });
    }
    const [, outB] = tx.moveCall({
      target: `${cetusPackageId}::router::swap`,
      typeArguments: [coinTypeSui, coinTypeUsdc],
      arguments: [
        tx.object(id(9)),
        tx.object(poolId),
        cetusCoin,
        zeroCoin,
        tx.pure.bool(true),
        tx.pure.bool(true),
        tx.pure.u64(swapAmount),
        tx.pure.u128(0n),
        tx.pure.bool(false),
        tx.object('0x6'),
      ],
    });
    if (!options.omitGuard) {
      tx.moveCall({
        target: `${guardPackageId}::guard::assert_min_value`,
        typeArguments: [coinTypeUsdc],
        arguments: [outB, tx.pure.u64(options.minOutOverride ?? minOut)],
      });
    }
  };

  const buildStakeFragment = () => {
    const [haedalCoin] = tx.splitCoins(spendResult, [stakeAmount]);
    tx.moveCall({
      target: `${haedalPackageId}::interface::request_stake`,
      typeArguments: [],
      arguments: [tx.object(id(10)), tx.object(id(11)), haedalCoin, tx.pure.address(validatorAddr)],
    });
  };

  if (options.reorder) {
    buildStakeFragment();
    buildSwapFragment();
  } else {
    buildSwapFragment();
    buildStakeFragment();
  }

  if (!options.omitMerge) {
    tx.mergeCoins(tx.gas, [spendResult]);
  }
  if (options.trailingCommand) {
    tx.moveCall({ target: '0x2::coin::zero', typeArguments: [coinTypeUsdc], arguments: [] });
  }

  return tx;
}

async function buildGenericEnvelope(
  options: Parameters<typeof buildAdversarialPtb>[0] & {
    requiredObjectIdsOverride?: string[];
    allowedTargetsOverride?: string[];
    stepsOverride?: EnvelopeStep[];
    simulationVerification?: 'verified' | 'unverified';
  } = {},
): Promise<ExecutionEnvelope> {
  const tx = buildAdversarialPtb(options);
  const unsignedPtb = Buffer.from(tx.serialize()).toString('base64');
  return {
    version: '1',
    actionId: genericPolicy.actionId,
    actionDigest: await digestUnsignedPtb(unsignedPtb),
    network: 'testnet',
    sender,
    walletPackageId,
    walletId,
    agentCapId,
    balanceManagerId: genericPolicy.balanceManagerId,
    tradeCapId: genericPolicy.tradeCapId,
    resolvedParams: {
      poolKey: 'unused',
      poolId,
      price: 1,
      quantity: 1,
      isBid: false,
      payWithDeep: false,
      clientOrderId: '1',
      depositSui: 1,
      spendAmountMist: totalAmount.toString(),
    },
    allowedTargets: options.allowedTargetsOverride ?? [...genericStepTargets],
    requiredObjectIds: options.requiredObjectIdsOverride ?? [walletId, agentCapId, '0x6', poolId],
    requiredGuards: [...genericPolicy.requiredGuards],
    unsignedPtb,
    preview: 'Cetus swap -> Haedal stake',
    simulation: {
      ok: true,
      verification: options.simulationVerification ?? 'verified',
      gasEstimate: 1,
      balanceChanges: [],
      objectChanges: [],
    },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    steps: options.stepsOverride ?? steps,
  };
}

test('a valid two-step generic envelope is accepted (control for the adversarial suite below)', async () => {
  const result = await validateExecutionEnvelope(await buildGenericEnvelope(), sender, 'testnet', genericPolicy);
  expect(result.spendAmountMist).toBe(totalAmount);
  expect(result.objectIds.sort()).toEqual(
    [normalized(walletId), normalized(agentCapId), normalized('0x6'), normalized(poolId)].sort(),
  );
});

test('an off-scope target inserted into the PTB is rejected', async () => {
  // inspectGeneric's `targets` field only ever contains what a registered step validator explicitly
  // reports (see genericStepTargets's comment above) — an attacker-injected call to a totally unknown
  // target is invisible to that set-based check, but it still inflates the raw callTargets sequence
  // beyond what policy.allowedTargets declares, so it is still caught here (as a sequence mismatch,
  // not literally the "off-scope" message — see the dedicated off-scope test below for that check).
  await expect(
    validateExecutionEnvelope(await buildGenericEnvelope({ offScopeCall: true }), sender, 'testnet', genericPolicy),
  ).rejects.toThrow('target sequence');
});

test('a target the fixed policy.allowedTargets does not cover is rejected as off-scope', async () => {
  // A DIFFERENT angle on "off-scope": here the PTB and envelope are both left completely valid and
  // unmutated — only the OWNER's policy.allowedTargets is shrunk to no longer cover a target the
  // approved haedal_stake step legitimately produces. This exercises the off-scope set-containment
  // check itself (inspected.targets subset of policy.allowedTargets), independent of the
  // sequence-length check exercised by the two tests above.
  const shrunkPolicy: LocalSignerPolicy = {
    ...genericPolicy,
    allowedTargets: genericPolicy.allowedTargets.filter(
      (target) => target !== `${haedalPackageId}::interface::request_stake`,
    ),
  };
  await expect(
    validateExecutionEnvelope(await buildGenericEnvelope(), sender, 'testnet', shrunkPolicy),
  ).rejects.toThrow('off-scope');
});

test('reordering the steps (stake before swap) is rejected', async () => {
  await expect(
    validateExecutionEnvelope(await buildGenericEnvelope({ reorder: true }), sender, 'testnet', genericPolicy),
  ).rejects.toThrow();
});

test('an extra command beyond the declared steps is rejected', async () => {
  await expect(
    validateExecutionEnvelope(await buildGenericEnvelope({ extraCommand: true }), sender, 'testnet', genericPolicy),
  ).rejects.toThrow('target sequence');
});

test('a spend amount over maxAmountMist is rejected', async () => {
  await expect(
    validateExecutionEnvelope(await buildGenericEnvelope(), sender, 'testnet', {
      ...genericPolicy,
      maxAmountMist: (totalAmount - 1n).toString(),
    }),
  ).rejects.toThrow('maxAmountMist');
});

test('a Cetus swap with min-out below the step floor is rejected (slippage disarm attempt)', async () => {
  await expect(
    validateExecutionEnvelope(
      await buildGenericEnvelope({ minOutOverride: minOut - 1n }),
      sender,
      'testnet',
      genericPolicy,
    ),
  ).rejects.toThrow('minOut');
});

test('a missing guard on the cetus_swap step is rejected', async () => {
  await expect(
    validateExecutionEnvelope(await buildGenericEnvelope({ omitGuard: true }), sender, 'testnet', genericPolicy),
  ).rejects.toThrow('guard');
});

test('an object id not in the step union / requiredObjectIds is rejected', async () => {
  await expect(
    validateExecutionEnvelope(
      await buildGenericEnvelope({ requiredObjectIdsOverride: [walletId, agentCapId, '0x6', poolId, id(88)] }),
      sender,
      'testnet',
      genericPolicy,
    ),
  ).rejects.toThrow('requiredObjectIds');
});

test('envelope.steps disagreeing with policy.steps is rejected', async () => {
  const mutatedSteps: EnvelopeStep[] = [
    { nodeType: 'cetus_swap', poolId, minOutMist: (minOut + 1n).toString(), spendAmountMist: swapAmount.toString() },
    steps[1],
  ];
  await expect(
    validateExecutionEnvelope(
      await buildGenericEnvelope({ stepsOverride: mutatedSteps }),
      sender,
      'testnet',
      genericPolicy,
    ),
  ).rejects.toThrow('steps differ from the local policy');
});

test('a Haedal stake below 1 SUI is rejected', async () => {
  const lowStakeAmount = 500_000_000n; // 0.5 SUI — below the 1 SUI Haedal protocol minimum.
  const tx = new Transaction();
  tx.setSender(sender);
  const spendResult = tx.moveCall({
    target: `${walletPackageId}::agent_wallet::spend`,
    typeArguments: [coinTypeSui],
    arguments: [tx.object(walletId), tx.object(agentCapId), tx.pure.u64(lowStakeAmount), tx.object('0x6')],
  });
  const [haedalCoin] = tx.splitCoins(spendResult, [lowStakeAmount]);
  tx.moveCall({
    target: `${haedalPackageId}::interface::request_stake`,
    typeArguments: [],
    arguments: [tx.object(id(10)), tx.object(id(11)), haedalCoin, tx.pure.address(validatorAddr)],
  });
  tx.mergeCoins(tx.gas, [spendResult]);
  const unsignedPtb = Buffer.from(tx.serialize()).toString('base64');

  const haedalOnlySteps: EnvelopeStep[] = [
    { nodeType: 'haedal_stake', validator: validatorAddr, spendAmountMist: lowStakeAmount.toString() },
  ];
  const haedalOnlyPolicy: LocalSignerPolicy = {
    ...genericPolicy,
    allowedTargets: [`${walletPackageId}::agent_wallet::spend`, `${haedalPackageId}::interface::request_stake`],
    requiredGuards: [],
    steps: haedalOnlySteps,
  };
  const envelope: ExecutionEnvelope = {
    version: '1',
    actionId: haedalOnlyPolicy.actionId,
    actionDigest: await digestUnsignedPtb(unsignedPtb),
    network: 'testnet',
    sender,
    walletPackageId,
    walletId,
    agentCapId,
    balanceManagerId: haedalOnlyPolicy.balanceManagerId,
    tradeCapId: haedalOnlyPolicy.tradeCapId,
    resolvedParams: {
      poolKey: 'unused',
      poolId,
      price: 1,
      quantity: 1,
      isBid: false,
      payWithDeep: false,
      clientOrderId: '1',
      depositSui: 1,
      spendAmountMist: lowStakeAmount.toString(),
    },
    allowedTargets: [...haedalOnlyPolicy.allowedTargets],
    requiredObjectIds: [walletId, agentCapId, '0x6'],
    requiredGuards: [],
    unsignedPtb,
    preview: 'Haedal stake only',
    simulation: { ok: true, verification: 'verified', gasEstimate: 1, balanceChanges: [], objectChanges: [] },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    steps: haedalOnlySteps,
  };

  await expect(validateExecutionEnvelope(envelope, sender, 'testnet', haedalOnlyPolicy)).rejects.toThrow('1 SUI');
});

test('an unverified simulation is rejected (unchanged)', async () => {
  await expect(
    validateExecutionEnvelope(
      await buildGenericEnvelope({ simulationVerification: 'unverified' }),
      sender,
      'testnet',
      genericPolicy,
    ),
  ).rejects.toThrow('simulation');
});

test('a merge-to-gas that is not the final command is rejected', async () => {
  await expect(
    validateExecutionEnvelope(
      await buildGenericEnvelope({ trailingCommand: true }),
      sender,
      'testnet',
      genericPolicy,
    ),
  ).rejects.toThrow('merging only the wallet spend remainder into gas');
});

// ── assertCapabilitiesActive generic branch ───────────────────────────────────────────────────────
//
// Task 7 Step 3 coverage: a Cetus/Haedal-only plan (no deepbook_limit_order step) must check ONLY
// AgentCap, never touching policy.tradeCapId/balanceManagerId. The stub client below throws on any
// unexpected getObject call, so a stray TradeCap lookup fails this test loudly rather than silently.

test('assertCapabilitiesActive on a Cetus/Haedal-only policy checks only AgentCap (no TradeCap lookup)', async () => {
  const calls: string[] = [];
  const client = {
    getObject: async ({ objectId }: { objectId: string }) => {
      calls.push(objectId);
      if (normalized(objectId) === normalized(walletId)) {
        return {
          object: {
            owner: { $kind: 'Shared', Shared: { initialSharedVersion: '1' } },
            json: {
              budget: '100000000000',
              revoked: false,
              agent: sender,
              expires_at_ms: '9999999999999',
              per_tx_max: '10000000000',
            },
          },
        };
      }
      if (normalized(objectId) === normalized(agentCapId)) {
        return { object: { owner: { $kind: 'AddressOwner', AddressOwner: sender }, json: { wallet: walletId } } };
      }
      throw new Error(`Unexpected getObject call for ${objectId} (TradeCap must not be checked here).`);
    },
  };
  await expect(assertCapabilitiesActive(client as never, genericPolicy, totalAmount)).resolves.toBeUndefined();
  expect(calls).toEqual([walletId, agentCapId]);
});
