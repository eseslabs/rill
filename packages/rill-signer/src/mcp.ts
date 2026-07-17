#!/usr/bin/env bun
import { createInterface } from 'node:readline';
import { Transaction } from '@mysten/sui/transactions';
import { assertExecutionEnvelope } from '../../rill-sdk/src/execution-envelope';
import {
  createSigner,
  executeEnvelope,
  extractCreatedObjectId,
  loadConfigFromEnv,
  signAndExecutePtb,
  type Signer,
  type SignerConfig,
} from './core';
import { loadOnboardingConfig, saveOnboardingConfig } from './config';
import { listRunSets, saveRunSet, type RunSet } from './runsets';
import { loadPolicy, readMoveU64, type LocalSignerPolicy } from './policy';

const FAUCET_URL = 'https://faucet.testnet.sui.io/v1/gas';
const MIN_GAS_BALANCE_MIST = 50_000_000n;
const PLACEHOLDER_BALANCE_MANAGER_ID = '0x0000000000000000000000000000000000000000000000000000000000000000';

export const walletTools = [
  {
    name: 'wallet_status',
    description: 'Read local signer readiness and current public AgentWallet budget/revoke state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_capabilities',
    description: 'Return run-specific public IDs, limits, targets, and small-order params.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'execute_rill_action',
    description: 'Validate, re-simulate, sign, and submit one Rill ExecutionEnvelope inside local policy.',
    inputSchema: {
      type: 'object',
      properties: { envelope: { type: 'object' } },
      required: ['envelope'],
      additionalProperties: false,
    },
  },
  {
    name: 'explain_rejection',
    description: 'Return the last local policy rejection without changing policy.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'signer_status',
    description: 'Return the local signer address, network, and SUI balance.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_onboarding_config',
    description: 'Return the local onboarding configuration from .rill/config.json.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'set_onboarding_config',
    description: 'Update the local onboarding configuration. Partial updates are merged.',
    inputSchema: {
      type: 'object',
      properties: {
        autoCreateRunSets: { type: 'boolean' },
        maxAutoSetupBudgetMist: { type: 'string' },
        allowTestnetFaucet: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'request_faucet',
    description: 'Request testnet SUI from the official faucet for the signer address.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_run_sets',
    description: 'Return the saved run-sets from .rill/runsets/.',
    inputSchema: {
      type: 'object',
      properties: { network: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'create_run_set',
    description: 'Create a run-set from a prepared setup plan. Requires confirmed=true and autoCreateRunSets=true.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: {
          type: 'object',
          properties: {
            setupPtb: { type: 'string' },
            tradeCapPtb: { type: 'string' },
            runSetTemplate: { type: 'object' },
            walletPackageId: { type: 'string' },
            deepbookPackageId: { type: 'string' },
            confirmed: { type: 'boolean' },
          },
          required: ['setupPtb', 'tradeCapPtb', 'runSetTemplate', 'walletPackageId', 'deepbookPackageId', 'confirmed'],
          additionalProperties: false,
        },
      },
      required: ['plan'],
      additionalProperties: false,
    },
  },
] as const;

const EMPTY_ARGUMENTS: readonly string[] = [];
const WALLET_TOOL_NAMES: ReadonlySet<string> = new Set(walletTools.map((tool) => tool.name));

export interface WalletMcpRuntime {
  cfg: SignerConfig;
  signer: Signer;
  policy?: LocalSignerPolicy;
}

function requirePolicy(runtime: WalletMcpRuntime): LocalSignerPolicy {
  if (!runtime.policy) throw new Error('No signer policy loaded. Set RILL_SIGNER_POLICY_PATH or run create_run_set first.');
  return runtime.policy;
}

function listCapabilities(policy: LocalSignerPolicy) {
  return {
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
  };
}

async function readWalletStatus(signer: Signer, policy: LocalSignerPolicy) {
  const wallet = await signer.client.getObject({
    objectId: policy.walletId,
    include: { json: true },
  });
  if (!wallet.object?.json) {
    throw new Error('AgentWallet is unavailable.');
  }
  const fields = wallet.object.json;
  const remainingMist = readMoveU64(fields, 'budget');
  const spentMist = readMoveU64(fields, 'spent');
  const perTxMaxMist = readMoveU64(fields, 'per_tx_max');
  const expiresAtMs = readMoveU64(fields, 'expires_at_ms');
  const revoked = fields.revoked === true;
  const active = !revoked && Date.now() < Number(expiresAtMs);
  return {
    address: signer.address,
    network: signer.network,
    walletId: policy.walletId,
    active,
    revoked,
    remainingMist,
    spentMist,
    perTxMaxMist,
    expiresAtMs,
    minimumRemainingMist: policy.minimumRemainingMist,
    strategyEligible: active && BigInt(remainingMist) >= BigInt(policy.minimumRemainingMist),
  };
}

async function readSignerStatus(signer: Signer) {
  if (!signer.address) throw new Error('No local signer key configured.');
  const balance = await signer.client.getBalance({ owner: signer.address });
  const totalBalance = String(balance.balance.balance);
  return {
    address: signer.address,
    network: signer.network,
    balanceMist: totalBalance,
    balanceSui: (BigInt(totalBalance) / 1_000_000_000n).toString(),
  };
}

async function requestFaucet(signer: Signer, allowTestnetFaucet: boolean) {
  if (!signer.address) throw new Error('No local signer key configured.');
  if (signer.network !== 'testnet') throw new Error('Faucet is only available on testnet.');
  if (!allowTestnetFaucet) throw new Error('Testnet faucet is disabled in onboarding config.');
  const response = await fetch(FAUCET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ FixedAmountRequest: { recipient: signer.address } }),
  });
  const body = (await response.json().catch(() => ({}))) as unknown;
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    address: signer.address,
    body,
  };
}

function isRunSetTemplate(value: unknown): value is RunSet {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.version === 'string' &&
    typeof record.label === 'string' &&
    typeof record.actionId === 'string' &&
    typeof record.network === 'string' &&
    typeof record.sender === 'string' &&
    typeof record.walletPackageId === 'string' &&
    typeof record.walletId === 'string' &&
    typeof record.agentCapId === 'string' &&
    typeof record.balanceManagerId === 'string' &&
    typeof record.tradeCapId === 'string' &&
    typeof record.poolId === 'string' &&
    typeof record.maxAmountMist === 'string' &&
    typeof record.minimumRemainingMist === 'string'
  );
}

function patchTradeCapPtb(base64Ptb: string, balanceManagerId: string): string {
  const tx = Transaction.from(Buffer.from(base64Ptb, 'base64').toString('utf8'));
  const data = tx.getData() as unknown as {
    inputs: Array<
      | {
          $kind: 'UnresolvedObject';
          UnresolvedObject: { objectId: string };
        }
      | {
          $kind: 'Object';
          Object: {
            $kind: string;
            SharedObject?: { objectId: string };
            ImmOrOwnedObject?: { objectId: string };
            Receiving?: { objectId: string };
          };
        }
    >;
  };
  let patched = false;
  for (const input of data.inputs) {
    if (input.$kind === 'UnresolvedObject') {
      if (
        input.UnresolvedObject.objectId === PLACEHOLDER_BALANCE_MANAGER_ID ||
        input.UnresolvedObject.objectId === '0x0'
      ) {
        input.UnresolvedObject.objectId = balanceManagerId;
        patched = true;
      }
      continue;
    }
    if (input.$kind !== 'Object') continue;
    const objectId =
      input.Object.$kind === 'SharedObject' && input.Object.SharedObject
        ? input.Object.SharedObject.objectId
        : input.Object.$kind === 'ImmOrOwnedObject' && input.Object.ImmOrOwnedObject
        ? input.Object.ImmOrOwnedObject.objectId
        : input.Object.Receiving?.objectId;
    if (objectId !== PLACEHOLDER_BALANCE_MANAGER_ID && objectId !== '0x0') continue;
    if (input.Object.$kind === 'SharedObject' && input.Object.SharedObject) {
      input.Object.SharedObject.objectId = balanceManagerId;
    } else if (input.Object.$kind === 'ImmOrOwnedObject' && input.Object.ImmOrOwnedObject) {
      input.Object.ImmOrOwnedObject.objectId = balanceManagerId;
    } else if (input.Object.Receiving) {
      input.Object.Receiving.objectId = balanceManagerId;
    }
    patched = true;
  }
  if (!patched) throw new Error('tradeCapPtb placeholder BalanceManager ID not found.');
  return Buffer.from(tx.serialize()).toString('base64');
}

async function createRunSet(
  plan: {
    setupPtb: string;
    tradeCapPtb: string;
    runSetTemplate: unknown;
    walletPackageId: string;
    deepbookPackageId: string;
    confirmed: boolean;
  },
  signer: Signer,
  cfg: SignerConfig,
): Promise<RunSet> {
  if (!plan.confirmed) throw new Error('Run-set creation must be confirmed.');
  if (!isRunSetTemplate(plan.runSetTemplate)) throw new Error('runSetTemplate is missing required fields.');

  const onboarding = loadOnboardingConfig();
  if (!onboarding.autoCreateRunSets) throw new Error('autoCreateRunSets is disabled in onboarding config.');

  const budgetMist = BigInt(plan.runSetTemplate.maxAmountMist);
  const maxBudgetMist = BigInt(onboarding.maxAutoSetupBudgetMist);
  if (budgetMist > maxBudgetMist) {
    throw new Error(`Run-set budget ${budgetMist} MIST exceeds maxAutoSetupBudgetMist ${maxBudgetMist}.`);
  }

  if (!signer.address) throw new Error('No local signer key configured.');
  const balance = await signer.client.getBalance({ owner: signer.address });
  if (BigInt(balance.balance.balance) < MIN_GAS_BALANCE_MIST) {
    throw new Error(`Signer balance too low for setup gas (need > ${MIN_GAS_BALANCE_MIST} MIST).`);
  }

  const setupResult = await signAndExecutePtb(plan.setupPtb, signer, cfg);
  const walletId = extractCreatedObjectId(setupResult.effects as never, '::agent_wallet::AgentWallet');
  const agentCapId = extractCreatedObjectId(setupResult.effects as never, '::agent_wallet::AgentCap');
  const balanceManagerId = extractCreatedObjectId(setupResult.effects as never, '::balance_manager::BalanceManager');

  const patchedTradeCapPtb = patchTradeCapPtb(plan.tradeCapPtb, balanceManagerId);
  const tradeCapResult = await signAndExecutePtb(patchedTradeCapPtb, signer, cfg);
  const tradeCapId = extractCreatedObjectId(tradeCapResult.effects as never, '::balance_manager::TradeCap');

  const runSet: RunSet = {
    ...plan.runSetTemplate,
    walletId,
    agentCapId,
    balanceManagerId,
    tradeCapId,
  };
  const label = runSet.label || `${runSet.actionId}_${Date.now()}`;
  saveRunSet(label, runSet);
  return runSet;
}

function toolResult(id: unknown, data: unknown, isError = false) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      structuredContent: data,
      isError,
    },
  };
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function assertOnlyArguments(args: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(args).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`Unexpected argument: ${unexpected}.`);
}

function requireRuntime(runtime: WalletMcpRuntime | undefined): WalletMcpRuntime {
  if (!runtime) throw new Error('rill-wallet runtime is not initialized.');
  return runtime;
}

export function createWalletMcpHandler(runtime?: WalletMcpRuntime) {
  let lastRejection: { code: string; message: string } | undefined;

  async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'explain_rejection':
        assertOnlyArguments(args, EMPTY_ARGUMENTS);
        return lastRejection ?? { code: 'none', message: 'No local rejection recorded.' };
      case 'wallet_status': {
        assertOnlyArguments(args, EMPTY_ARGUMENTS);
        const { signer, policy } = requireRuntime(runtime);
        return readWalletStatus(signer, requirePolicy({ ...requireRuntime(runtime), policy }));
      }
      case 'list_capabilities': {
        assertOnlyArguments(args, EMPTY_ARGUMENTS);
        const { policy } = requireRuntime(runtime);
        return listCapabilities(requirePolicy({ ...requireRuntime(runtime), policy }));
      }
      case 'execute_rill_action': {
        assertOnlyArguments(args, ['envelope']);
        const { cfg, signer, policy } = requireRuntime(runtime);
        return executeEnvelope(assertExecutionEnvelope(args.envelope), signer, cfg, requirePolicy({ ...requireRuntime(runtime), policy }));
      }
      case 'signer_status': {
        assertOnlyArguments(args, EMPTY_ARGUMENTS);
        const { signer } = requireRuntime(runtime);
        return readSignerStatus(signer);
      }
      case 'get_onboarding_config': {
        assertOnlyArguments(args, EMPTY_ARGUMENTS);
        return loadOnboardingConfig();
      }
      case 'set_onboarding_config': {
        assertOnlyArguments(args, ['autoCreateRunSets', 'maxAutoSetupBudgetMist', 'allowTestnetFaucet']);
        return saveOnboardingConfig(args as Partial<{ autoCreateRunSets: boolean; maxAutoSetupBudgetMist: string; allowTestnetFaucet: boolean }>);
      }
      case 'request_faucet': {
        assertOnlyArguments(args, EMPTY_ARGUMENTS);
        const { signer } = requireRuntime(runtime);
        return requestFaucet(signer, loadOnboardingConfig().allowTestnetFaucet);
      }
      case 'list_run_sets': {
        assertOnlyArguments(args, ['network']);
        return listRunSets(args.network as string | undefined);
      }
      case 'create_run_set': {
        assertOnlyArguments(args, ['plan']);
        const { cfg, signer } = requireRuntime(runtime);
        const plan = args.plan as {
          setupPtb: string;
          tradeCapPtb: string;
          runSetTemplate: unknown;
          walletPackageId: string;
          deepbookPackageId: string;
          confirmed: boolean;
        };
        return createRunSet(plan, signer, cfg);
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  return async function handleWalletMcpJsonRpc(
    message: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const id = message.id ?? null;
    const method = String(message.method ?? '');
    if (method.startsWith('notifications/') || id === null) return null;
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'rill-wallet', version: '0.2.0' },
        },
      };
    }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: walletTools } };
    if (method === 'tools/call') {
      const params = message.params as { name?: unknown; arguments?: unknown } | undefined;
      if (!params || typeof params.name !== 'string') {
        return rpcError(id, -32602, 'tools/call requires a tool name.');
      }
      if (!WALLET_TOOL_NAMES.has(params.name)) {
        return rpcError(id, -32602, `Unknown tool: ${params.name}`);
      }
      if (
        params.arguments !== undefined &&
        (!params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments))
      ) {
        return rpcError(id, -32602, 'Tool arguments must be an object.');
      }
      try {
        const data = await callTool(params.name, (params.arguments ?? {}) as Record<string, unknown>);
        return toolResult(id, data);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const rejection = {
          code: params.name === 'execute_rill_action' ? 'policy_rejection' : 'tool_error',
          message,
        };
        if (params.name === 'execute_rill_action') lastRejection = rejection;
        return toolResult(id, rejection, true);
      }
    }
    return rpcError(id, -32601, `Method not found: ${method}`);
  };
}

export const handleWalletMcpJsonRpc = createWalletMcpHandler();

if (import.meta.main) {
  const cfg = loadConfigFromEnv();
  const signer = createSigner(cfg);
  let policy: LocalSignerPolicy | undefined;
  try {
    policy = loadPolicy();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`rill-wallet: no policy loaded (${message}). Onboarding tools are still available.`);
  }
  const handle = createWalletMcpHandler({ cfg, signer, policy });
  console.error(`rill-wallet MCP ready - ${signer.network}${signer.address ? ` (${signer.address})` : ' (no key)'}`);
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      process.stdout.write(`${JSON.stringify(rpcError(null, -32700, 'Parse error'))}\n`);
      continue;
    }
    const response = await handle(message).catch((error) =>
      rpcError(
        message.id ?? null,
        -32603,
        error instanceof Error ? error.message : 'Internal error',
      )
    );
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}
