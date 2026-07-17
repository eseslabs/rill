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
const options = {
  sender: id(1),
  agentWallet: {
    packageId: id(2),
    walletId: id(3),
    capId: id(7),
    coinType: '0x2::sui::SUI',
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

test('PTB spends wallet SUI before the exact DeepBook deposit and limit order', async () => {
  const result = await compilerService.compileFlow(flow(), options);
  const commands = result.transaction.getData().commands;
  const targets = commands.map((command) => command.$kind === 'MoveCall'
    ? `${command.MoveCall.package}::${command.MoveCall.module}::${command.MoveCall.function}`
    : '');
  const spendTarget = `${options.agentWallet.packageId}::agent_wallet::spend`;
  const deepbookPackageId = packageIds.DEEPBOOK_PACKAGE_ID;
  const depositTarget = `${deepbookPackageId}::balance_manager::deposit`;
  const proofTarget = `${deepbookPackageId}::balance_manager::generate_proof_as_trader`;
  const orderTarget = `${deepbookPackageId}::pool::place_limit_order`;
  const spend = targets.indexOf(spendTarget);
  const deposit = targets.indexOf(depositTarget);
  const proof = targets.indexOf(proofTarget);
  const order = targets.indexOf(orderTarget);

  expect(targets.filter((target) => target === spendTarget)).toHaveLength(1);
  expect(targets.filter(Boolean)).toEqual([spendTarget, depositTarget, proofTarget, orderTarget]);
  expect([spend, deposit, proof, order]).toEqual([0, 2, 3, 4]);
  expect(targets.some((target) => target.endsWith('::balance_manager::new'))).toBe(false);

  const spendCommand = commands[spend];
  const depositCommand = commands[deposit];
  const orderCommand = commands[order];
  if (spendCommand?.$kind !== 'MoveCall') throw new Error('expected spend MoveCall');
  if (depositCommand?.$kind !== 'MoveCall') throw new Error('expected deposit MoveCall');
  if (orderCommand?.$kind !== 'MoveCall') throw new Error('expected order MoveCall');

  expect(inputObjectId(result.transaction, spendCommand.MoveCall.arguments[0])).toBe(options.agentWallet.walletId);
  expect(inputObjectId(result.transaction, spendCommand.MoveCall.arguments[1])).toBe(options.agentWallet.capId);
  expect(inputU64(result.transaction, spendCommand.MoveCall.arguments[2])).toBe(6_000_000n);
  expect(inputObjectId(result.transaction, depositCommand.MoveCall.arguments[0])).toBe(id(4));
  const depositedCoin = depositCommand.MoveCall.arguments[1];
  if (depositedCoin.$kind !== 'NestedResult') throw new Error('expected deposited split coin');
  const split = commands[depositedCoin.NestedResult[0]];
  if (split?.$kind !== 'SplitCoins') throw new Error('expected wallet coin split');
  expect(split.SplitCoins.coin).toEqual({ Result: spend, $kind: 'Result' });
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
    const envelope = await new SkillRunnerService().runFlow(flow(), {}, { actionId, ...options });
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
      allowedTargets: [
        `${options.agentWallet.packageId}::agent_wallet::spend`,
        `${packageIds.DEEPBOOK_PACKAGE_ID}::balance_manager::deposit`,
        `${packageIds.DEEPBOOK_PACKAGE_ID}::balance_manager::generate_proof_as_trader`,
        `${packageIds.DEEPBOOK_PACKAGE_ID}::pool::place_limit_order`,
      ],
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
