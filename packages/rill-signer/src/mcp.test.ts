import { expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { ExecutionEnvelope } from '../../rill-sdk/src/types';
import { createWalletMcpHandler, handleWalletMcpJsonRpc, walletTools } from './mcp';
import type { LocalSignerPolicy } from './policy';
import { createSigner, loadConfigFromEnv } from './core';
import { loadOnboardingConfig, saveOnboardingConfig } from './config';
import { listRunSets, saveRunSet } from './runsets';

const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const policy: LocalSignerPolicy = {
  version: '1',
  actionId: 'skill_deepbook',
  network: 'testnet',
  sender: id(1),
  walletPackageId: id(2),
  walletId: id(3),
  agentCapId: id(4),
  balanceManagerId: id(5),
  tradeCapId: id(6),
  poolId: id(7),
  allowedTargets: [],
  requiredObjectIds: [],
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

const envelope: ExecutionEnvelope = {
  version: '1',
  actionId: policy.actionId,
  actionDigest: 'digest',
  network: 'testnet',
  sender: policy.sender,
  walletPackageId: policy.walletPackageId,
  walletId: policy.walletId,
  agentCapId: policy.agentCapId,
  balanceManagerId: policy.balanceManagerId,
  tradeCapId: policy.tradeCapId,
  resolvedParams: {
    ...policy.demoParams,
    poolId: policy.poolId,
    spendAmountMist: '6000000',
  },
  allowedTargets: [],
  requiredObjectIds: [],
  requiredGuards: [],
  unsignedPtb: 'cHRi',
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

test('local MCP exposes bounded wallet tools plus onboarding tools', () => {
  expect(walletTools.map((tool) => tool.name)).toEqual([
    'wallet_status',
    'list_capabilities',
    'execute_rill_action',
    'explain_rejection',
    'signer_status',
    'get_onboarding_config',
    'set_onboarding_config',
    'request_faucet',
    'list_run_sets',
    'create_run_set',
  ]);
  expect(walletTools.some((tool) => tool.name.includes('arbitrary') || tool.name.includes('ptb'))).toBe(false);
});

test('handler imports and lists tools without runtime env or key initialization', async () => {
  const response = await handleWalletMcpJsonRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  });

  expect((response?.result as { tools: unknown[] }).tools).toEqual([...walletTools]);
});

test('execute_rill_action records policy rejection for explain_rejection', async () => {
  const handler = createWalletMcpHandler({
    cfg: { network: 'testnet', allowMainnet: false, requireSimSuccess: true },
    signer: {
      address: policy.sender,
      network: 'testnet',
      client: {} as never,
      hasKey: () => true,
    },
    policy,
  });
  const rejected = await handler({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'execute_rill_action', arguments: { envelope } },
  });
  const explained = await handler({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'explain_rejection', arguments: {} },
  });
  const rejection = {
    code: 'policy_rejection',
    message: 'No local signer key configured.',
  };

  expect((rejected?.result as { isError: boolean }).isError).toBe(true);
  expect(JSON.parse((rejected?.result as { content: [{ text: string }] }).content[0].text)).toEqual(rejection);
  expect(JSON.parse((explained?.result as { content: [{ text: string }] }).content[0].text)).toEqual(rejection);
});

test('execute_rill_action rejects raw PTB arguments', async () => {
  const handler = createWalletMcpHandler({
    cfg: { network: 'testnet', allowMainnet: false, requireSimSuccess: true },
    signer: {
      address: policy.sender,
      network: 'testnet',
      client: {} as never,
      hasKey: () => true,
    },
    policy,
  });
  const response = await handler({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'execute_rill_action',
      arguments: { envelope, unsignedPtb: envelope.unsignedPtb },
    },
  });
  const result = response?.result as { content: [{ text: string }]; isError: boolean };

  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0].text)).toEqual({
    code: 'policy_rejection',
    message: 'Unexpected argument: unsignedPtb.',
  });
});

test('list_capabilities returns only public run-specific policy data', async () => {
  const handler = createWalletMcpHandler({
    cfg: { network: 'testnet', allowMainnet: false, requireSimSuccess: true },
    signer: {
      address: policy.sender,
      network: 'testnet',
      client: {} as never,
      hasKey: () => true,
    },
    policy,
  });
  const response = await handler({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'list_capabilities', arguments: {} },
  });
  const data = JSON.parse((response?.result as { content: [{ text: string }] }).content[0].text);

  expect(data).toEqual({
    actionId: policy.actionId,
    network: policy.network,
    walletPackageId: policy.walletPackageId,
    walletId: policy.walletId,
    agentCapId: policy.agentCapId,
    balanceManagerId: policy.balanceManagerId,
    tradeCapId: policy.tradeCapId,
    poolId: policy.poolId,
    maxAmountMist: policy.maxAmountMist,
    minimumRemainingMist: policy.minimumRemainingMist,
    allowedTargets: policy.allowedTargets,
    requiredGuards: policy.requiredGuards,
    demoParams: policy.demoParams,
  });
  expect(JSON.stringify(data)).not.toContain('privateKey');
});

test('wallet_status reports public budget and strategy eligibility', async () => {
  const handler = createWalletMcpHandler({
    cfg: { network: 'testnet', allowMainnet: false, requireSimSuccess: true },
    signer: {
      address: policy.sender,
      network: 'testnet',
      client: {
        getObject: async () => ({
          object: {
            json: {
              budget: '30000000',
              spent: '6000000',
              per_tx_max: '10000000',
              expires_at_ms: '9999999999999',
              revoked: false,
            },
          },
        }),
      } as never,
      hasKey: () => true,
    },
    policy,
  });
  const response = await handler({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'wallet_status', arguments: {} },
  });
  const data = JSON.parse((response?.result as { content: [{ text: string }] }).content[0].text);

  expect(data).toMatchObject({
    address: policy.sender,
    network: 'testnet',
    walletId: policy.walletId,
    active: true,
    revoked: false,
    remainingMist: '30000000',
    strategyEligible: true,
  });
});

test('wallet_status and list_capabilities require a loaded policy', async () => {
  const handler = createWalletMcpHandler({
    cfg: { network: 'testnet', allowMainnet: false, requireSimSuccess: true },
    signer: {
      address: policy.sender,
      network: 'testnet',
      client: {} as never,
      hasKey: () => true,
    },
  });
  const status = await handler({
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: { name: 'wallet_status', arguments: {} },
  });
  const caps = await handler({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: { name: 'list_capabilities', arguments: {} },
  });

  expect((status?.result as { isError: boolean }).isError).toBe(true);
  expect(JSON.parse((status?.result as { content: [{ text: string }] }).content[0].text).message).toMatch(/No signer policy loaded/);
  expect((caps?.result as { isError: boolean }).isError).toBe(true);
  expect(JSON.parse((caps?.result as { content: [{ text: string }] }).content[0].text).message).toMatch(/No signer policy loaded/);
});

let originalConfigDir: string | undefined;
let tempConfigDir: string;

beforeEach(() => {
  originalConfigDir = process.env.RILL_CONFIG_DIR;
  tempConfigDir = mkdtempSync(join(tmpdir(), 'rill-signer-test-'));
  process.env.RILL_CONFIG_DIR = tempConfigDir;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.RILL_CONFIG_DIR;
  else process.env.RILL_CONFIG_DIR = originalConfigDir;
  rmSync(tempConfigDir, { recursive: true, force: true });
});

test('get_onboarding_config returns defaults and set_onboarding_config persists changes', async () => {
  const handler = createWalletMcpHandler({
    cfg: { network: 'testnet', allowMainnet: false, requireSimSuccess: true },
    signer: { address: policy.sender, network: 'testnet', client: {} as never, hasKey: () => true },
  });
  const get = await handler({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: { name: 'get_onboarding_config', arguments: {} },
  });
  expect(JSON.parse((get?.result as { content: [{ text: string }] }).content[0].text)).toEqual({
    autoCreateRunSets: false,
    maxAutoSetupBudgetMist: '2000000000',
    allowTestnetFaucet: true,
  });

  const set = await handler({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'set_onboarding_config', arguments: { autoCreateRunSets: true, maxAutoSetupBudgetMist: '500000000' } },
  });
  expect(JSON.parse((set?.result as { content: [{ text: string }] }).content[0].text)).toEqual({
    autoCreateRunSets: true,
    maxAutoSetupBudgetMist: '500000000',
    allowTestnetFaucet: true,
  });
  expect(loadOnboardingConfig().autoCreateRunSets).toBe(true);
});

test('signer_status returns address, network and balance', async () => {
  const handler = createWalletMcpHandler({
    cfg: { network: 'testnet', allowMainnet: false, requireSimSuccess: true },
    signer: {
      address: policy.sender,
      network: 'testnet',
      client: {
        getBalance: async () => ({ balance: { balance: '1234567890', coinType: '0x2::sui::SUI', coinBalance: '1234567890', addressBalance: '1234567890' } }),
      } as never,
      hasKey: () => true,
    },
  });
  const response = await handler({
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: { name: 'signer_status', arguments: {} },
  });
  const data = JSON.parse((response?.result as { content: [{ text: string }] }).content[0].text);

  expect(data).toEqual({
    address: policy.sender,
    network: 'testnet',
    balanceMist: '1234567890',
    balanceSui: '1',
  });
});

test('request_faucet rejects on mainnet and when disabled', async () => {
  const handler = createWalletMcpHandler({
    cfg: { network: 'mainnet', allowMainnet: true, requireSimSuccess: true },
    signer: { address: policy.sender, network: 'mainnet', client: {} as never, hasKey: () => true },
  });
  const mainnet = await handler({
    jsonrpc: '2.0',
    id: 13,
    method: 'tools/call',
    params: { name: 'request_faucet', arguments: {} },
  });
  expect((mainnet?.result as { isError: boolean }).isError).toBe(true);
  expect(JSON.parse((mainnet?.result as { content: [{ text: string }] }).content[0].text).message).toMatch(/only available on testnet/);

  saveOnboardingConfig({ allowTestnetFaucet: false });
  const testnetHandler = createWalletMcpHandler({
    cfg: { network: 'testnet', allowMainnet: false, requireSimSuccess: true },
    signer: { address: policy.sender, network: 'testnet', client: {} as never, hasKey: () => true },
  });
  const disabled = await testnetHandler({
    jsonrpc: '2.0',
    id: 14,
    method: 'tools/call',
    params: { name: 'request_faucet', arguments: {} },
  });
  expect((disabled?.result as { isError: boolean }).isError).toBe(true);
  expect(JSON.parse((disabled?.result as { content: [{ text: string }] }).content[0].text).message).toMatch(/disabled/);
});

test('list_run_sets returns saved run-sets', async () => {
  const runSet = {
    ...policy,
    label: 'saved_set',
    network: 'testnet' as const,
    walletPackageId: id(10),
  };
  saveRunSet('saved_set', runSet);
  const handler = createWalletMcpHandler({
    cfg: { network: 'testnet', allowMainnet: false, requireSimSuccess: true },
    signer: { address: policy.sender, network: 'testnet', client: {} as never, hasKey: () => true },
  });
  const response = await handler({
    jsonrpc: '2.0',
    id: 15,
    method: 'tools/call',
    params: { name: 'list_run_sets', arguments: {} },
  });
  const data = JSON.parse((response?.result as { content: [{ text: string }] }).content[0].text);
  expect(data).toHaveLength(1);
  expect(data[0].label).toBe('saved_set');
});

test('create_run_set requires confirmation and config', async () => {
  const handler = createWalletMcpHandler({
    cfg: { network: 'testnet', allowMainnet: false, requireSimSuccess: true },
    signer: { address: policy.sender, network: 'testnet', client: {} as never, hasKey: () => true },
  });
  const unconfirmed = await handler({
    jsonrpc: '2.0',
    id: 16,
    method: 'tools/call',
    params: { name: 'create_run_set', arguments: { plan: { confirmed: false } } },
  });
  expect((unconfirmed?.result as { isError: boolean }).isError).toBe(true);

  saveOnboardingConfig({ autoCreateRunSets: false });
  const runSetTemplate = {
    version: '1',
    label: 'test_label',
    actionId: 'skill_deepbook',
    network: 'testnet',
    sender: policy.sender,
    walletPackageId: id(2),
    walletId: '',
    agentCapId: '',
    balanceManagerId: '',
    tradeCapId: '',
    poolId: id(4),
    allowedTargets: [],
    requiredObjectIds: [],
    requiredGuards: [],
    maxAmountMist: '1000000000',
    minimumRemainingMist: '100000000',
    demoParams: policy.demoParams,
    onChainOrder: policy.onChainOrder,
  };
  const disabled = await handler({
    jsonrpc: '2.0',
    id: 17,
    method: 'tools/call',
    params: {
      name: 'create_run_set',
      arguments: {
        plan: {
          setupPtb: 'cHRi',
          tradeCapPtb: 'cHRi',
          runSetTemplate,
          walletPackageId: id(2),
          deepbookPackageId: id(3),
          confirmed: true,
        },
      },
    },
  });
  expect((disabled?.result as { isError: boolean }).isError).toBe(true);
  expect(JSON.parse((disabled?.result as { content: [{ text: string }] }).content[0].text).message).toMatch(/autoCreateRunSets/);
});

function makeTestSigner(network: 'mainnet' | 'testnet' = 'testnet') {
  const keypair = Ed25519Keypair.generate();
  const cfg = loadConfigFromEnv({
    RILL_SUI_PRIVATE_KEY: keypair.getSecretKey(),
    SUI_NETWORK: network,
  });
  const signer = createSigner(cfg);
  const created = {
    wallet: id(100),
    agentCap: id(101),
    balanceManager: id(102),
    tradeCap: id(103),
  };
  let callCount = 0;
  const client = signer.client as any;
  client.getBalance = async () => ({
    balance: {
      balance: '1000000000',
      coinType: '0x2::sui::SUI',
      coinBalance: '1000000000',
      addressBalance: '1000000000',
    },
  });
  client.simulateTransaction = async () => ({
    $kind: 'Transaction',
    Transaction: {
      effects: {
        status: { success: true },
        gasUsed: { computationCost: '1000', storageCost: '100' },
      },
    },
  });
  client.signAndExecuteTransaction = async () => {
    callCount += 1;
    const digest = `0x${callCount.toString(16).padStart(64, '0')}`;
    const changedObjects = [] as { objectId: string; idOperation: string }[];
    const objectTypes = {} as Record<string, string>;
    if (callCount === 1) {
      changedObjects.push(
        { objectId: created.wallet, idOperation: 'Created' },
        { objectId: created.agentCap, idOperation: 'Created' },
        { objectId: created.balanceManager, idOperation: 'Created' },
      );
      objectTypes[created.wallet] = '0x2::agent_wallet::AgentWallet';
      objectTypes[created.agentCap] = '0x2::agent_wallet::AgentCap';
      objectTypes[created.balanceManager] = '0x2::balance_manager::BalanceManager';
    } else {
      changedObjects.push({ objectId: created.tradeCap, idOperation: 'Created' });
      objectTypes[created.tradeCap] = '0x2::balance_manager::TradeCap';
    }
    return {
      $kind: 'Transaction',
      Transaction: {
        digest,
        effects: {
          status: { success: true },
          gasUsed: { computationCost: '1000', storageCost: '100' },
          changedObjects,
        },
        objectTypes,
      },
    };
  };
  client.waitForTransaction = async () => ({ $kind: 'Transaction', Transaction: {} });
  return { signer, cfg, created };
}

function makeBase64Ptb(): string {
  const tx = new Transaction();
  tx.setSender(id(1));
  return Buffer.from(tx.serialize()).toString('base64');
}

function makeTradeCapPtb(): string {
  const tx = new Transaction();
  tx.setSender(id(1));
  tx.object('0x0000000000000000000000000000000000000000000000000000000000000000');
  return Buffer.from(tx.serialize()).toString('base64');
}

test('create_run_set executes setup and trade-cap PTBs and saves the filled run-set', async () => {
  saveOnboardingConfig({ autoCreateRunSets: true, maxAutoSetupBudgetMist: '2000000000' });
  const { signer, cfg, created } = makeTestSigner('testnet');
  const runSetTemplate = {
    version: '1' as const,
    label: 'live_set',
    actionId: 'skill_deepbook',
    network: 'testnet' as const,
    sender: signer.address,
    walletPackageId: id(2),
    walletId: '',
    agentCapId: '',
    balanceManagerId: '',
    tradeCapId: '',
    poolId: id(4),
    allowedTargets: [],
    requiredObjectIds: [],
    requiredGuards: [],
    maxAmountMist: '1000000000',
    minimumRemainingMist: '100000000',
    demoParams: policy.demoParams,
    onChainOrder: policy.onChainOrder,
  };

  const handler = createWalletMcpHandler({ cfg, signer, policy: undefined });
  const response = await handler({
    jsonrpc: '2.0',
    id: 18,
    method: 'tools/call',
    params: {
      name: 'create_run_set',
      arguments: {
        plan: {
          setupPtb: makeBase64Ptb(),
          tradeCapPtb: makeTradeCapPtb(),
          runSetTemplate,
          walletPackageId: id(2),
          deepbookPackageId: id(3),
          confirmed: true,
        },
      },
    },
  });

  const result = JSON.parse((response?.result as { content: [{ text: string }] }).content[0].text);
  expect((response?.result as { isError?: boolean }).isError).toBe(false);
  expect(result.walletId).toBe(created.wallet);
  expect(result.agentCapId).toBe(created.agentCap);
  expect(result.balanceManagerId).toBe(created.balanceManager);
  expect(result.tradeCapId).toBe(created.tradeCap);

  const saved = listRunSets('testnet');
  expect(saved).toHaveLength(1);
  expect(saved[0].label).toBe('live_set');
  expect(saved[0].walletId).toBe(created.wallet);
});
