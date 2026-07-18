import { expect, test } from 'bun:test';
import {
  MAX_TIMESTAMP,
  mainnetPackageIds,
  mainnetPools,
  testnetPackageIds,
  testnetPools,
} from '@mysten/deepbook-v3';
import {
  validateExecutionEnvelope,
  type LocalSignerPolicy,
} from '../../../../packages/rill-signer/src/policy';
import { config } from '../../core/config';
import { compilerService } from '../compiler/compiler.service';
import { simulatorService } from '../compiler/simulator.service';
import { SkillRunnerService } from '../mcp/skill-runner.service';
import type { CapabilityManifest } from '../../../../packages/rill-sdk/src/capability-manifest';

const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const poolKey = config.network === 'testnet' ? 'SUI_DBUSDC' : 'SUI_USDC';
const pools = config.network === 'testnet' ? testnetPools : mainnetPools;
const packageIds = config.network === 'testnet' ? testnetPackageIds : mainnetPackageIds;
const flow = (overrides: Record<string, unknown> = {}) => ({
  nodes: [{
    id: 'order',
    type: 'deepbook_limit_order',
    config: {
      poolKey,
      balanceManagerId: id(4),
      tradeCapId: id(5),
      price: 1,
      quantity: 0.005,
      isBid: false,
      payWithDeep: false,
      clientOrderId: '71601',
      depositSui: 0.006,
      ...overrides,
    },
  }],
  edges: [],
});

// There is ONE agent_wallet package now — every bound wallet requires a capabilityManifest +
// versionId (no legacy manifest-less spend() fallback). A single permissive budget rule is enough
// for these tests; the manifest's exact rule set is not what they're pinning.
const AGENT_WALLET_VERSION_ID = id(9);
const DEFAULT_MANIFEST: CapabilityManifest = {
  walletCoinType: '0x2::sui::SUI',
  rules: [{ kind: 'budget', totalMist: '5000000000' }],
};
const options = {
  sender: id(1),
  agentWallet: {
    packageId: id(2),
    walletId: id(3),
    capId: id(7),
    coinType: '0x2::sui::SUI',
    versionId: AGENT_WALLET_VERSION_ID,
    capabilityManifest: DEFAULT_MANIFEST,
  },
};

function inputBytes(
  transaction: Awaited<ReturnType<typeof compilerService.compileFlow>>['transaction'],
  argument: unknown,
) {
  const value = argument as { $kind?: string; Input?: number };
  if (value.$kind !== 'Input' || value.Input == null) throw new Error('expected input argument');
  const input = transaction.getData().inputs[value.Input];
  if (input?.$kind !== 'Pure') throw new Error('expected pure input');
  return Buffer.from(input.Pure.bytes, 'base64');
}

const inputU64 = (
  transaction: Awaited<ReturnType<typeof compilerService.compileFlow>>['transaction'],
  argument: unknown,
) => inputBytes(transaction, argument).readBigUInt64LE();

function inputObjectId(
  transaction: Awaited<ReturnType<typeof compilerService.compileFlow>>['transaction'],
  argument: unknown,
) {
  const value = argument as { $kind?: string; Input?: number };
  if (value.$kind !== 'Input' || value.Input == null) throw new Error('expected object input argument');
  const input = transaction.getData().inputs[value.Input];
  if (input?.$kind !== 'UnresolvedObject') throw new Error('expected unresolved object input');
  return input.UnresolvedObject.objectId;
}

test('PTB requests/proves/confirms the wallet spend before the exact DeepBook deposit and limit order', async () => {
  const result = await compilerService.compileFlow(flow(), options);
  const commands = result.transaction.getData().commands;
  const targets = commands.map((command) => command.$kind === 'MoveCall'
    ? `${command.MoveCall.package}::${command.MoveCall.module}::${command.MoveCall.function}`
    : '');
  const requestSpendTarget = `${options.agentWallet.packageId}::agent_wallet::request_spend`;
  const proveTarget = `${options.agentWallet.packageId}::budget::prove`;
  const confirmSpendTarget = `${options.agentWallet.packageId}::agent_wallet::confirm_spend`;
  const deepbookPackageId = packageIds.DEEPBOOK_PACKAGE_ID;
  const depositTarget = `${deepbookPackageId}::balance_manager::deposit`;
  const proofTarget = `${deepbookPackageId}::balance_manager::generate_proof_as_trader`;
  const orderTarget = `${deepbookPackageId}::pool::place_limit_order`;
  const requestSpend = targets.indexOf(requestSpendTarget);
  const prove = targets.indexOf(proveTarget);
  const confirmSpend = targets.indexOf(confirmSpendTarget);
  const deposit = targets.indexOf(depositTarget);
  const proof = targets.indexOf(proofTarget);
  const order = targets.indexOf(orderTarget);

  expect(targets.filter((target) => target === requestSpendTarget)).toHaveLength(1);
  expect(targets.filter((target) => target === confirmSpendTarget)).toHaveLength(1);
  // Regression pin: the retired legacy call never reappears in a compiled PTB.
  expect(targets.some((target) => target.endsWith('::agent_wallet::spend'))).toBe(false);
  expect(targets.filter(Boolean)).toEqual([
    requestSpendTarget, proveTarget, confirmSpendTarget, depositTarget, proofTarget, orderTarget,
  ]);
  expect([requestSpend, prove, confirmSpend, deposit, proof, order]).toEqual([0, 1, 2, 4, 5, 6]);
  expect(targets.some((target) => target.endsWith('::balance_manager::new'))).toBe(false);

  const requestSpendCommand = commands[requestSpend];
  const confirmSpendCommand = commands[confirmSpend];
  const depositCommand = commands[deposit];
  const orderCommand = commands[order];
  if (requestSpendCommand?.$kind !== 'MoveCall') throw new Error('expected request_spend MoveCall');
  if (confirmSpendCommand?.$kind !== 'MoveCall') throw new Error('expected confirm_spend MoveCall');
  if (depositCommand?.$kind !== 'MoveCall') throw new Error('expected deposit MoveCall');
  if (orderCommand?.$kind !== 'MoveCall') throw new Error('expected order MoveCall');

  // request_spend<T>(wallet, cap, version, amount, clock) — wallet/cap/version pinned, amount sized
  // to the exact DeepBook deposit.
  expect(inputObjectId(result.transaction, requestSpendCommand.MoveCall.arguments[0])).toBe(options.agentWallet.walletId);
  expect(inputObjectId(result.transaction, requestSpendCommand.MoveCall.arguments[1])).toBe(options.agentWallet.capId);
  expect(inputObjectId(result.transaction, requestSpendCommand.MoveCall.arguments[2])).toBe(options.agentWallet.versionId);
  expect(inputU64(result.transaction, requestSpendCommand.MoveCall.arguments[3])).toBe(6_000_000n);

  expect(inputObjectId(result.transaction, depositCommand.MoveCall.arguments[0])).toBe(id(4));
  const depositedCoin = depositCommand.MoveCall.arguments[1];
  if (depositedCoin.$kind !== 'NestedResult') throw new Error('expected deposited split coin');
  const split = commands[depositedCoin.NestedResult[0]];
  if (split?.$kind !== 'SplitCoins') throw new Error('expected wallet coin split');
  // The deposited coin is split from confirm_spend's released Coin<T>, not request_spend's hot potato.
  expect(split.SplitCoins.coin).toEqual({ Result: confirmSpend, $kind: 'Result' });
  expect(inputU64(result.transaction, split.SplitCoins.amounts[0])).toBe(6_000_000n);

  expect(inputObjectId(result.transaction, orderCommand.MoveCall.arguments[0])).toBe(pools[poolKey].address);
  expect(inputObjectId(result.transaction, orderCommand.MoveCall.arguments[1])).toBe(id(4));
  expect(orderCommand.MoveCall.arguments[2]).toEqual({ Result: proof, $kind: 'Result' });
  expect(inputU64(result.transaction, orderCommand.MoveCall.arguments[3])).toBe(71_601n);
  expect(inputBytes(result.transaction, orderCommand.MoveCall.arguments[4])[0]).toBe(0);
  expect(inputBytes(result.transaction, orderCommand.MoveCall.arguments[5])[0]).toBe(0);
  expect(inputU64(result.transaction, orderCommand.MoveCall.arguments[6])).toBe(1_000_000n);
  expect(inputU64(result.transaction, orderCommand.MoveCall.arguments[7])).toBe(5_000_000n);
  expect(inputBytes(result.transaction, orderCommand.MoveCall.arguments[8])[0]).toBe(0);
  expect(inputBytes(result.transaction, orderCommand.MoveCall.arguments[9])[0]).toBe(0);
  expect(inputU64(result.transaction, orderCommand.MoveCall.arguments[10])).toBe(MAX_TIMESTAMP);
  expect(result.transaction.getData().inputs.some((input) =>
    input.$kind === 'UnresolvedObject' && input.UnresolvedObject.objectId === pools[poolKey].address
  )).toBe(true);
  expect(result.agentWalletBound).toBe(true);
  expect(result.budgetSpendMist).toBe(6_000_000n);
});

test('DeepBook order rejects a missing wallet binding', async () => {
  await expect(compilerService.compileFlow(flow(), { sender: id(1) }))
    .rejects.toThrow('AgentWallet binding');
});

test('DeepBook order rejects missing pre-provisioned capabilities', async () => {
  await expect(compilerService.compileFlow(flow({ balanceManagerId: '' }), options))
    .rejects.toThrow('BalanceManager');
  await expect(compilerService.compileFlow(flow({ tradeCapId: '' }), options))
    .rejects.toThrow('TradeCap');
});

test('wallet-bound DeepBook envelope passes the local signer policy', async () => {
  const simulate = simulatorService.simulateTransaction;
  simulatorService.simulateTransaction = async () => ({
    ok: true,
    verification: 'verified',
    gasEstimate: 1,
    balanceChanges: [],
    objectChanges: [],
  });

  try {
    const actionId = 'skill_deepbook';
    const built = await new SkillRunnerService().runFlow(flow(), {}, { actionId, ...options });
    if ('refused' in built) throw new Error('expected an ExecutionEnvelope, got a refusal');
    const envelope = built;
    const policy: LocalSignerPolicy = {
      version: '1',
      actionId,
      network: config.network,
      sender: options.sender,
      walletPackageId: options.agentWallet.packageId,
      walletId: options.agentWallet.walletId,
      agentCapId: options.agentWallet.capId,
      balanceManagerId: id(4),
      tradeCapId: id(5),
      poolId: pools[poolKey].address,
      // Unused by the manifest-gated branch (validateManifestEnvelope reads capabilityManifest/
      // versionId below, not allowedTargets — see inspectManifestGated) — kept as an empty array
      // only because LocalSignerPolicy's legacy-shaped fields are still required by the type.
      allowedTargets: [],
      requiredGuards: [],
      maxAmountMist: '6000000',
      minimumRemainingMist: '0',
      demoParams: {
        poolKey,
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
        expiration: MAX_TIMESTAMP.toString(),
      },
      // Manifest-gated signer policy (the ONE agent_wallet package now) — selects
      // validateManifestEnvelope instead of the retired legacy DeepBook-spend() path.
      capabilityManifest: DEFAULT_MANIFEST,
      versionId: options.agentWallet.versionId,
    };

    expect(envelope.requiredGuards).toEqual([]);
    expect((await validateExecutionEnvelope(
      envelope,
      options.sender,
      config.network,
      policy,
    )).spendAmountMist).toBe(6_000_000n);
  } finally {
    simulatorService.simulateTransaction = simulate;
  }
});
