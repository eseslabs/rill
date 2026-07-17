import { expect, test } from 'bun:test';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { digestUnsignedPtb } from '../../rill-sdk/src/execution-envelope';
import type { ExecutionEnvelope } from '../../rill-sdk/src/types';
import {
  assertCapabilitiesActive,
  inspectOnboarding,
  validateExecutionEnvelope,
  type LocalSignerPolicy,
  type OnboardingAllowlist,
} from './policy';

const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const walletPackageId = id(1);
const deepbookPackageId = id(2);
const sender = id(3);

const policy: LocalSignerPolicy = {
  version: '1',
  actionId: 'skill_deepbook',
  network: 'testnet',
  sender,
  walletPackageId,
  walletId: id(4),
  agentCapId: id(5),
  balanceManagerId: id(16),
  tradeCapId: id(7),
  poolId: id(8),
  allowedTargets: [
    `${walletPackageId}::agent_wallet::spend`,
    `${deepbookPackageId}::balance_manager::deposit`,
    `${deepbookPackageId}::balance_manager::generate_proof_as_trader`,
    `${deepbookPackageId}::pool::place_limit_order`,
  ],
  requiredGuards: [],
  maxAmountMist: '10000000',
  minimumRemainingMist: '20000000',
  demoParams: {
    poolKey: 'SUI_DBUSDC',
    price: 1,
    quantity: 0.005,
    isBid: false,
    payWithDeep: false,
    clientOrderId: '71601',
    depositSui: 0.006,
  },
  onChainOrder: {
    clientOrderId: '71601',
    orderType: '0',
    selfMatchingOption: '0',
    price: '1000000',
    quantity: '5000000',
    isBid: false,
    payWithDeep: false,
    expiration: '1844674407370955161',
  },
};

async function envelope(options: {
  amount?: bigint;
  target?: string;
  omitWallet?: boolean;
  bypassWalletFunding?: boolean;
  mergeMode?: 'before-split' | 'wrong-destination' | 'extra-source';
  extraObjectId?: string;
  spendClockId?: string;
  orderClockId?: string;
  callShape?:
    | 'spend-missing-clock'
    | 'spend-extra'
    | 'deposit-extra'
    | 'proof-extra'
    | 'order-missing-clock'
    | 'order-extra';
  order?: Partial<LocalSignerPolicy['onChainOrder']>;
} = {}): Promise<ExecutionEnvelope> {
  const amount = options.amount ?? 6_000_000n;
  const order = { ...policy.onChainOrder, ...options.order };
  const tx = new Transaction();
  tx.setSender(sender);
  if (options.extraObjectId) tx.object(options.extraObjectId);
  const budgetCoin = options.omitWallet
    ? tx.splitCoins(tx.gas, [amount])[0]
    : tx.moveCall({
        target: `${walletPackageId}::agent_wallet::spend`,
        typeArguments: ['0x2::sui::SUI'],
        arguments: [
          tx.object(policy.walletId),
          tx.object(policy.agentCapId),
          tx.pure.u64(amount),
          ...(options.callShape === 'spend-missing-clock'
            ? []
            : [tx.object(options.spendClockId ?? '0x6')]),
          ...(options.callShape === 'spend-extra' ? [tx.pure.u8(0)] : []),
        ],
      });
  if (!options.omitWallet && options.mergeMode === 'before-split') {
    tx.mergeCoins(budgetCoin, [tx.gas]);
  }
  const [coin] = tx.splitCoins(options.bypassWalletFunding ? tx.gas : budgetCoin, [amount]);
  tx.moveCall({
    target: `${deepbookPackageId}::balance_manager::deposit`,
    typeArguments: ['0x2::sui::SUI'],
    arguments: [
      tx.object(policy.balanceManagerId),
      coin,
      ...(options.callShape === 'deposit-extra' ? [tx.pure.u8(0)] : []),
    ],
  });
  const proof = tx.moveCall({
    target: `${deepbookPackageId}::balance_manager::generate_proof_as_trader`,
    arguments: [
      tx.object(policy.balanceManagerId),
      tx.object(policy.tradeCapId),
      ...(options.callShape === 'proof-extra' ? [tx.pure.u8(0)] : []),
    ],
  });
  tx.moveCall({
    target: options.target ?? `${deepbookPackageId}::pool::place_limit_order`,
    typeArguments: ['0x2::sui::SUI', id(9)],
    arguments: [
      tx.object(policy.poolId),
      tx.object(policy.balanceManagerId),
      proof,
      tx.pure.u64(BigInt(order.clientOrderId)),
      tx.pure.u8(Number(order.orderType)),
      tx.pure.u8(Number(order.selfMatchingOption)),
      tx.pure.u64(BigInt(order.price)),
      tx.pure.u64(BigInt(order.quantity)),
      tx.pure.bool(order.isBid),
      tx.pure.bool(order.payWithDeep),
      tx.pure.u64(BigInt(order.expiration)),
      ...(options.callShape === 'order-missing-clock'
        ? []
        : [tx.object(options.orderClockId ?? '0x6')]),
      ...(options.callShape === 'order-extra' ? [tx.pure.u8(0)] : []),
    ],
  });
  if (!options.omitWallet && options.mergeMode !== 'before-split') {
    if (options.mergeMode === 'wrong-destination') tx.mergeCoins(budgetCoin, [tx.gas]);
    else if (options.mergeMode === 'extra-source') tx.mergeCoins(tx.gas, [budgetCoin, tx.object(id(99))]);
    else tx.mergeCoins(tx.gas, [budgetCoin]);
  }
  const unsignedPtb = Buffer.from(tx.serialize()).toString('base64');
  const targets = options.target
    ? [...policy.allowedTargets.slice(0, 3), options.target]
    : policy.allowedTargets;
  return {
    version: '1',
    actionId: policy.actionId,
    actionDigest: await digestUnsignedPtb(unsignedPtb),
    network: 'testnet',
    sender,
    walletPackageId,
    walletId: policy.walletId,
    agentCapId: policy.agentCapId,
    balanceManagerId: policy.balanceManagerId,
    tradeCapId: policy.tradeCapId,
    resolvedParams: {
      poolKey: 'SUI_DBUSDC',
      poolId: policy.poolId,
      price: 1,
      quantity: 0.005,
      isBid: false,
      payWithDeep: false,
      clientOrderId: '71601',
      depositSui: 0.006,
      spendAmountMist: amount.toString(),
    },
    allowedTargets: [...targets],
    requiredObjectIds: [
      policy.walletId,
      policy.agentCapId,
      policy.balanceManagerId,
      policy.tradeCapId,
      policy.poolId,
      '0x6',
      ...(options.spendClockId && options.spendClockId !== '0x6' ? [options.spendClockId] : []),
      ...(options.orderClockId && options.orderClockId !== '0x6' ? [options.orderClockId] : []),
      ...(options.mergeMode === 'extra-source' ? [id(99)] : []),
      ...(options.extraObjectId ? [options.extraObjectId] : []),
    ],
    requiredGuards: [],
    unsignedPtb,
    preview: 'DeepBook ask',
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

test('valid hero envelope is accepted', async () => {
  expect((await validateExecutionEnvelope(await envelope(), sender, 'testnet', policy)).spendAmountMist)
    .toBe(6_000_000n);
});

test('invalid envelope schema is rejected', async () => {
  await expect(validateExecutionEnvelope({ version: '1' }, sender, 'testnet', policy))
    .rejects.toThrow('walletPackageId');
});

test('altered digest is rejected', async () => {
  const value = await envelope();
  value.actionDigest = '0'.repeat(64);
  await expect(validateExecutionEnvelope(value, sender, 'testnet', policy)).rejects.toThrow('actionDigest');
});

test('wrong network is rejected', async () => {
  const value = await envelope();
  value.network = 'mainnet';
  await expect(validateExecutionEnvelope(value, sender, 'testnet', policy)).rejects.toThrow('network');
});

for (const field of [
  'walletPackageId',
  'walletId',
  'agentCapId',
  'balanceManagerId',
  'tradeCapId',
] as const) {
  test(`wrong ${field} is rejected`, async () => {
    const value = await envelope();
    value[field] = id(99);
    await expect(validateExecutionEnvelope(value, sender, 'testnet', policy)).rejects.toThrow(field);
  });
}

test('wrong pool identity is rejected', async () => {
  const value = await envelope();
  value.resolvedParams.poolId = id(99);
  await expect(validateExecutionEnvelope(value, sender, 'testnet', policy)).rejects.toThrow('poolId');
});

test('altered target manifest is rejected', async () => {
  const value = await envelope();
  value.allowedTargets = value.allowedTargets.slice(0, -1);
  await expect(validateExecutionEnvelope(value, sender, 'testnet', policy)).rejects.toThrow('target manifest');
});

test('altered object manifest is rejected', async () => {
  const value = await envelope();
  value.requiredObjectIds = value.requiredObjectIds.slice(0, -1);
  await expect(validateExecutionEnvelope(value, sender, 'testnet', policy)).rejects.toThrow('requiredObjectIds');
});

test('hidden extra object is rejected even when declared in the envelope manifest', async () => {
  await expect(validateExecutionEnvelope(
    await envelope({ extraObjectId: id(99) }),
    sender,
    'testnet',
    policy,
  )).rejects.toThrow('object policy');
});

test('altered guard manifest is rejected', async () => {
  const value = await envelope();
  value.requiredGuards = [`${id(40)}::guard::assert_min_value`];
  await expect(validateExecutionEnvelope(value, sender, 'testnet', policy)).rejects.toThrow('guard policy');
});

test('missing wallet spend is rejected', async () => {
  await expect(validateExecutionEnvelope(await envelope({ omitWallet: true }), sender, 'testnet', policy))
    .rejects.toThrow('wallet spend');
});

test('wallet spend with the wrong clock is rejected at the call boundary', async () => {
  await expect(validateExecutionEnvelope(
    await envelope({ spendClockId: id(99) }),
    sender,
    'testnet',
    policy,
  )).rejects.toThrow('wallet spend clock');
});

test('DeepBook order with the wrong clock is rejected at the call boundary', async () => {
  await expect(validateExecutionEnvelope(
    await envelope({ orderClockId: id(99) }),
    sender,
    'testnet',
    policy,
  )).rejects.toThrow('order clock');
});

test('DeepBook deposit with an extra argument is rejected', async () => {
  await expect(validateExecutionEnvelope(
    await envelope({ callShape: 'deposit-extra' }),
    sender,
    'testnet',
    policy,
  )).rejects.toThrow('deposit must have exactly 2 arguments');
});

test('DeepBook trader proof with an extra argument is rejected', async () => {
  await expect(validateExecutionEnvelope(
    await envelope({ callShape: 'proof-extra' }),
    sender,
    'testnet',
    policy,
  )).rejects.toThrow('trader proof must have exactly 2 arguments');
});

for (const [callShape, expected] of [
  ['spend-missing-clock', 'wallet spend must have exactly 4 arguments'],
  ['spend-extra', 'wallet spend must have exactly 4 arguments'],
  ['order-missing-clock', 'order must have exactly 12 arguments'],
  ['order-extra', 'order must have exactly 12 arguments'],
] as const) {
  test(`${callShape} is rejected`, async () => {
    await expect(validateExecutionEnvelope(
      await envelope({ callShape }),
      sender,
      'testnet',
      policy,
    )).rejects.toThrow(expected);
  });
}

test('deposit that bypasses the wallet spend output is rejected', async () => {
  await expect(validateExecutionEnvelope(
    await envelope({ bypassWalletFunding: true }),
    sender,
    'testnet',
    policy,
  )).rejects.toThrow('wallet-funded');
});

test('gas cannot be merged into the wallet spend before its deposit split', async () => {
  await expect(validateExecutionEnvelope(
    await envelope({ mergeMode: 'before-split' }),
    sender,
    'testnet',
    policy,
  )).rejects.toThrow('cleanup');
});

test('gas cannot be merged into the wallet-funded result as final cleanup', async () => {
  await expect(validateExecutionEnvelope(
    await envelope({ mergeMode: 'wrong-destination' }),
    sender,
    'testnet',
    policy,
  )).rejects.toThrow('cleanup');
});

test('final cleanup cannot merge an extra external coin into gas', async () => {
  await expect(validateExecutionEnvelope(
    await envelope({ mergeMode: 'extra-source' }),
    sender,
    'testnet',
    policy,
  )).rejects.toThrow('cleanup');
});

test('excess amount is rejected', async () => {
  await expect(validateExecutionEnvelope(
    await envelope(),
    sender,
    'testnet',
    { ...policy, maxAmountMist: '5999999' },
  )).rejects.toThrow('maxAmountMist');
});

test('wallet spend that differs from the fixed deposit is rejected', async () => {
  await expect(validateExecutionEnvelope(await envelope({ amount: 7_000_000n }), sender, 'testnet', policy))
    .rejects.toThrow('demo depositSui');
});

test('wrong sender is rejected', async () => {
  await expect(validateExecutionEnvelope(await envelope(), id(99), 'testnet', policy))
    .rejects.toThrow('sender');
});

test('expired envelope is rejected', async () => {
  const value = await envelope();
  value.expiresAt = new Date(Date.now() - 1).toISOString();
  await expect(validateExecutionEnvelope(value, sender, 'testnet', policy)).rejects.toThrow('expired');
});

test('invalid envelope expiry is rejected', async () => {
  const value = await envelope();
  value.expiresAt = 'not-a-date';
  await expect(validateExecutionEnvelope(value, sender, 'testnet', policy)).rejects.toThrow('expiresAt');
});

test('envelope beyond the five-minute TTL is rejected', async () => {
  const value = await envelope();
  value.expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  await expect(validateExecutionEnvelope(value, sender, 'testnet', policy)).rejects.toThrow('maximum TTL');
});

test('failed simulation is rejected', async () => {
  const value = await envelope();
  value.simulation.ok = false;
  await expect(validateExecutionEnvelope(value, sender, 'testnet', policy)).rejects.toThrow('simulation');
});

test('unverified simulation is rejected', async () => {
  const value = await envelope();
  value.simulation.verification = 'unverified';
  await expect(validateExecutionEnvelope(value, sender, 'testnet', policy)).rejects.toThrow('simulation');
});

test('off-scope target is rejected even when envelope digest matches', async () => {
  await expect(validateExecutionEnvelope(
    await envelope({ target: `${id(44)}::pool::place_limit_order` }),
    sender,
    'testnet',
    policy,
  )).rejects.toThrow('off-scope');
});

for (const [field, value] of [
  ['clientOrderId', '71602'],
  ['orderType', '1'],
  ['selfMatchingOption', '1'],
  ['price', '2000000'],
  ['quantity', '6000000'],
  ['isBid', true],
  ['payWithDeep', true],
  ['expiration', '1844674407370955160'],
] as const) {
  test(`altered on-chain ${field} is rejected`, async () => {
    await expect(validateExecutionEnvelope(
      await envelope({ order: { [field]: value } }),
      sender,
      'testnet',
      policy,
    )).rejects.toThrow('order manifest');
  });
}

function liveReader(options: {
  walletBudget?: string;
  walletRevoked?: boolean;
  walletOwner?: unknown;
  missing?: string;
  ownerOverrides?: Record<string, string>;
  agentCapWalletId?: string;
  tradeCapManagerId?: string;
} = {}) {
  return {
    getObject: async ({ objectId }: { objectId: string }) => {
      if (objectId === options.missing) return { object: undefined };
      if (objectId === policy.walletId) {
        return {
          object: {
            owner: options.walletOwner ?? { $kind: 'Shared', Shared: { initialSharedVersion: '1' } },
            json: {
              budget: options.walletBudget ?? '100000000',
              revoked: options.walletRevoked ?? false,
              agent: sender,
            },
          },
        };
      }
      if (objectId === policy.agentCapId) {
        return {
          object: {
            owner: { $kind: 'AddressOwner', AddressOwner: options.ownerOverrides?.[objectId] ?? sender },
            json: { wallet: options.agentCapWalletId ?? policy.walletId },
          },
        };
      }
      return {
        object: {
          owner: { $kind: 'AddressOwner', AddressOwner: options.ownerOverrides?.[objectId] ?? sender },
          json: { balance_manager_id: options.tradeCapManagerId ?? policy.balanceManagerId },
        },
      };
    },
  };
}

test('active shared wallet and signer-owned bound capabilities are accepted', async () => {
  await expect(assertCapabilitiesActive(liveReader() as never, policy, 5_000_000n)).resolves.toBeUndefined();
});

test('revoked wallet is rejected before signing', async () => {
  await expect(assertCapabilitiesActive(
    liveReader({ walletRevoked: true }) as never,
    policy,
    5_000_000n,
  )).rejects.toThrow('revoked');
});

test('wallet that is no longer shared is rejected before signing', async () => {
  await expect(assertCapabilitiesActive(
    liveReader({ walletOwner: { AddressOwner: sender } }) as never,
    policy,
    5_000_000n,
  )).rejects.toThrow('shared');
});

test('revoked AgentCap is rejected before signing', async () => {
  await expect(assertCapabilitiesActive(
    liveReader({ missing: policy.agentCapId }) as never,
    policy,
    5_000_000n,
  )).rejects.toThrow('AgentCap is revoked');
});

test('AgentCap held by another address is rejected before signing', async () => {
  await expect(assertCapabilitiesActive(
    liveReader({ ownerOverrides: { [policy.agentCapId]: id(99) } }) as never,
    policy,
    5_000_000n,
  )).rejects.toThrow('AgentCap is not held');
});

test('AgentCap for another wallet is rejected before signing', async () => {
  await expect(assertCapabilitiesActive(
    liveReader({ agentCapWalletId: id(99) }) as never,
    policy,
    5_000_000n,
  )).rejects.toThrow('AgentCap wallet mismatch');
});

test('revoked TradeCap is rejected before signing', async () => {
  await expect(assertCapabilitiesActive(
    liveReader({ missing: policy.tradeCapId }) as never,
    policy,
    5_000_000n,
  )).rejects.toThrow('TradeCap is revoked');
});

test('TradeCap held by another address is rejected before signing', async () => {
  await expect(assertCapabilitiesActive(
    liveReader({ ownerOverrides: { [policy.tradeCapId]: id(99) } }) as never,
    policy,
    5_000_000n,
  )).rejects.toThrow('TradeCap is not held');
});

test('TradeCap for another BalanceManager is rejected before signing', async () => {
  await expect(assertCapabilitiesActive(
    liveReader({ tradeCapManagerId: id(99) }) as never,
    policy,
    5_000_000n,
  )).rejects.toThrow('TradeCap BalanceManager mismatch');
});

test('insufficient remaining strategy balance is rejected before signing', async () => {
  await expect(assertCapabilitiesActive(
    liveReader({ walletBudget: '1' }) as never,
    policy,
    1n,
  )).rejects.toThrow('minimumRemainingMist');
});

test('spend that would cross the minimum remaining floor is rejected before signing', async () => {
  await expect(assertCapabilitiesActive(
    liveReader({ walletBudget: '25000000' }) as never,
    policy,
    6_000_000n,
  )).rejects.toThrow('minimumRemainingMist');
});

test('wallet unable to cover the spend is rejected before signing', async () => {
  await expect(assertCapabilitiesActive(
    liveReader({ walletBudget: policy.minimumRemainingMist }) as never,
    policy,
    BigInt(policy.minimumRemainingMist) + 1n,
  )).rejects.toThrow('cannot cover');
});

// ── inspectOnboarding ──
//
// Independent from inspect() above (zero shared code, by design — see policy.ts). These fixtures
// mirror the exact PTB shapes rill-backend/src/features/setup/setup.service.ts emits:
// buildSetupTransaction (create_wallet + balance_manager::new + transfer::public_share_object) and
// buildMintTradeCapTransaction (balance_manager::mint_trade_cap + transferObjects to the agent).

const onboardingWalletPackageId = id(101);
const onboardingDeepbookPackageId = id(102);
const onboardingSigner = id(103);
const onboardingForeignAddress = id(104);
const onboardingBalanceManagerId = id(105);
const SUI_TYPE = '0x2::sui::SUI';

function onboardingAllow(overrides: Partial<OnboardingAllowlist> = {}): OnboardingAllowlist {
  return {
    allowedTargets: [
      `${onboardingWalletPackageId}::agent_wallet::create_wallet`,
      `${onboardingDeepbookPackageId}::balance_manager::new`,
      '0x2::transfer::public_share_object',
      `${onboardingDeepbookPackageId}::balance_manager::mint_trade_cap`,
    ],
    allowedRecipients: [onboardingSigner],
    budgetCeilingMist: 2_000_000_000n,
    ...overrides,
  };
}

function buildOnboardingSetupTx(options: {
  createWalletTarget?: string;
  budgetMist?: bigint;
  appendForeignTransfer?: boolean;
} = {}): Transaction {
  const tx = new Transaction();
  tx.setSender(onboardingSigner);
  const budgetMist = options.budgetMist ?? 1_000_000_000n;
  const [funds] = tx.splitCoins(tx.gas, [budgetMist]);
  tx.moveCall({
    target: options.createWalletTarget ?? `${onboardingWalletPackageId}::agent_wallet::create_wallet`,
    typeArguments: [SUI_TYPE],
    arguments: [
      funds,
      tx.pure.address(onboardingSigner),
      tx.pure.u64(1_000_000_000n),
      tx.pure.u64(9_999_999_999_999n),
      tx.pure.vector('address', [onboardingDeepbookPackageId]),
    ],
  });
  const manager = tx.moveCall({ target: `${onboardingDeepbookPackageId}::balance_manager::new` });
  tx.moveCall({
    target: '0x2::transfer::public_share_object',
    typeArguments: [`${onboardingDeepbookPackageId}::balance_manager::BalanceManager`],
    arguments: [manager],
  });
  if (options.appendForeignTransfer) {
    const [leftover] = tx.splitCoins(tx.gas, [1n]);
    tx.transferObjects([leftover], onboardingForeignAddress);
  }
  return tx;
}

function buildOnboardingTradeCapTx(options: { balanceManagerId?: string; transferTo?: string } = {}): Transaction {
  const tx = new Transaction();
  tx.setSender(onboardingSigner);
  const cap = tx.moveCall({
    target: `${onboardingDeepbookPackageId}::balance_manager::mint_trade_cap`,
    arguments: [tx.object(options.balanceManagerId ?? onboardingBalanceManagerId)],
  });
  tx.transferObjects([cap], options.transferTo ?? onboardingSigner);
  return tx;
}

test('inspectOnboarding accepts a legitimate setup PTB shaped like the backend setup service emits', () => {
  const inspected = inspectOnboarding(buildOnboardingSetupTx(), onboardingAllow());
  expect(inspected.targets).toEqual([
    `${onboardingWalletPackageId}::agent_wallet::create_wallet`,
    `${onboardingDeepbookPackageId}::balance_manager::new`,
    `${normalizeSuiAddress('0x2')}::transfer::public_share_object`,
  ]);
  expect(inspected.totalSplitMist).toBe(1_000_000_000n);
  expect(inspected.transferRecipients).toEqual([]);
});

test('inspectOnboarding accepts a legitimate trade-cap PTB', () => {
  const inspected = inspectOnboarding(buildOnboardingTradeCapTx(), onboardingAllow());
  expect(inspected.targets).toEqual([`${onboardingDeepbookPackageId}::balance_manager::mint_trade_cap`]);
  expect(inspected.transferRecipients).toEqual([onboardingSigner]);
  expect(inspected.totalSplitMist).toBe(0n);
});

test('inspectOnboarding rejects an unexpected MoveCall target', () => {
  const hostile = buildOnboardingSetupTx({ createWalletTarget: `${id(999)}::evil::drain` });
  expect(() => inspectOnboarding(hostile, onboardingAllow())).toThrow(/unexpected target/);
});

test('inspectOnboarding rejects a transfer to a foreign address appended to a setup PTB', () => {
  const hostile = buildOnboardingSetupTx({ appendForeignTransfer: true });
  expect(() => inspectOnboarding(hostile, onboardingAllow())).toThrow(/unexpected address/);
});

test('inspectOnboarding rejects a trade-cap PTB that transfers to a foreign address', () => {
  const hostile = buildOnboardingTradeCapTx({ transferTo: onboardingForeignAddress });
  expect(() => inspectOnboarding(hostile, onboardingAllow())).toThrow(/unexpected address/);
});

test('inspectOnboarding rejects a split total above the budget ceiling', () => {
  const hostile = buildOnboardingSetupTx({ budgetMist: 3_000_000_000n });
  expect(() => inspectOnboarding(hostile, onboardingAllow({ budgetCeilingMist: 2_000_000_000n })))
    .toThrow(/budget ceiling/);
});

test('inspectOnboarding accepts a split total exactly at the budget ceiling', () => {
  const atCeiling = buildOnboardingSetupTx({ budgetMist: 2_000_000_000n });
  expect(() => inspectOnboarding(atCeiling, onboardingAllow({ budgetCeilingMist: 2_000_000_000n })))
    .not.toThrow();
});

test('inspectOnboarding rejects an unsupported command kind (e.g. Publish)', () => {
  const tx = new Transaction();
  tx.setSender(onboardingSigner);
  tx.publish({ modules: [], dependencies: [] });
  expect(() => inspectOnboarding(tx, onboardingAllow())).toThrow(/unsupported/);
});

test('inspectOnboarding rejects a split amount that is not a static pure value', () => {
  const tx = new Transaction();
  tx.setSender(onboardingSigner);
  const manager = tx.moveCall({ target: `${onboardingDeepbookPackageId}::balance_manager::new` });
  // A hostile PTB could try to size a split from a runtime result instead of a static amount, to
  // dodge the budget-ceiling check entirely.
  tx.splitCoins(tx.gas, [manager]);
  expect(() => inspectOnboarding(tx, onboardingAllow())).toThrow();
});

test('inspectOnboarding rejects an off-allowlist target even when the package ID is otherwise valid', () => {
  const hostile = buildOnboardingSetupTx({
    createWalletTarget: `${onboardingWalletPackageId}::agent_wallet::spend`,
  });
  expect(() => inspectOnboarding(hostile, onboardingAllow())).toThrow(/unexpected target/);
});
