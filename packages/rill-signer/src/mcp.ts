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
import {
  isAutoOnboardingAllowed,
  loadCustodyMode,
  loadOnboardingConfig,
  saveOnboardingConfig,
  type OnboardingConfig,
} from './config';
import { listRunSets, saveRunSet, type RunSet } from './runsets';
import { inspectOnboarding, loadPolicy, readMoveU64, type LocalSignerPolicy, type OnboardingAllowlist } from './policy';

const FAUCET_URL = 'https://faucet.testnet.sui.io/v1/gas';
const MIN_GAS_BALANCE_MIST = 50_000_000n;
/** Sui framework address for the stdlib `transfer` module — not backend/network-supplied, so it is
 * hardcoded into the onboarding allowlist rather than derived from `plan`. */
const SUI_FRAMEWORK_PACKAGE_ID = '0x2';

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
    description:
      'Return the local onboarding configuration from .rill/config.json, plus the live autoCreateRunSets ' +
      'gate read from the RILL_ALLOW_AUTO_ONBOARDING launch environment variable (read-only here).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'set_onboarding_config',
    description:
      'Update the local, non-privileged onboarding settings (auto-setup budget ceiling, testnet faucet toggle). ' +
      'Partial updates are merged. autoCreateRunSets is NOT settable here: it can only be enabled by setting ' +
      'RILL_ALLOW_AUTO_ONBOARDING=true in the signer process environment at launch.',
    inputSchema: {
      type: 'object',
      properties: {
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
    description:
      'Validate a prepared setup plan (the setup and trade-cap PTBs are always structurally inspected against a ' +
      'fixed onboarding allowlist before anything signs) and create a run-set. Requires confirmed=true. Only ' +
      'signs and executes when RILL_ALLOW_AUTO_ONBOARDING=true was set in the signer launch environment; ' +
      'otherwise returns the validated plan unsigned for a human to run manually.',
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

/**
 * Honest, mode-specific statements of what the signer actually enforces — `wallet_status` must never
 * imply a guarantee that doesn't apply. Bounded custody enforces all four via the on-chain AgentWallet
 * (budget cap, per-tx cap, expiry, revocability). Direct custody has none of them: the agent's local
 * keypair holds funds directly, so a compromised key is a total loss with no on-chain backstop.
 */
const BOUNDED_GUARANTEES = {
  budgetCap: true,
  perTxCap: true,
  expiry: true,
  revocable: true,
} as const;

const DIRECT_GUARANTEES = {
  budgetCap: false,
  perTxCap: false,
  expiry: false,
  revocable: false,
  note:
    'Direct-fund mode: the agent key holds the funds directly. If it is compromised, all funds are at risk. ' +
    'There is no on-chain budget cap or revoke.',
} as const;

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
    custodyMode: 'bounded' as const,
    guarantees: BOUNDED_GUARANTEES,
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

/**
 * `wallet_status` in direct custody mode: there is no run-set policy and no on-chain AgentWallet to
 * read (the agent's own keypair holds the funds), so this must not require a loaded policy and must
 * not attempt to read a wallet object that doesn't exist. It reports the same honest, all-false
 * guarantees every direct-mode caller sees, plus the signer's own address/balance (signer_status-style).
 */
async function readDirectWalletStatus(signer: Signer) {
  const status = await readSignerStatus(signer);
  return {
    custodyMode: 'direct' as const,
    guarantees: DIRECT_GUARANTEES,
    ...status,
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

function decodePtb(base64Ptb: string): Transaction {
  return Transaction.from(Buffer.from(base64Ptb, 'base64').toString('utf8'));
}

/**
 * Builds the trade-cap mint PTB locally from known-safe template parameters — mirroring
 * rill-backend's buildMintTradeCapTransaction (mint_trade_cap, then transfer the cap to the agent).
 *
 * This replaces the old patchTradeCapPtb, which took the backend-supplied tradeCapPtb bytes and
 * string/object-patched a placeholder BalanceManager ID into them before signing: that meant the
 * signer ultimately signed backend-controlled bytes. Now the signer never signs the backend's
 * tradeCapPtb at all — it is only ever structurally inspected (see createRunSet) — and instead
 * constructs the transaction itself from the one object ID it just watched get created on-chain
 * (balanceManagerId, from the setup PTB's own execution effects) plus its own address.
 */
function buildTradeCapPtb(deepbookPackageId: string, balanceManagerId: string, agent: string): string {
  const tx = new Transaction();
  const cap = tx.moveCall({
    target: `${deepbookPackageId}::balance_manager::mint_trade_cap`,
    arguments: [tx.object(balanceManagerId)],
  });
  tx.transferObjects([cap], agent);
  return Buffer.from(tx.serialize()).toString('base64');
}

/** The fixed set of MoveCall targets a setup/trade-cap onboarding PTB may contain — derived from what
 * rill-backend/src/features/setup/setup.service.ts actually emits (buildSetupTransaction,
 * buildMintTradeCapTransaction). Nothing else is reachable through create_run_set. */
function onboardingAllowlistFor(
  plan: { walletPackageId: string; deepbookPackageId: string },
  signerAddress: string,
  budgetCeilingMist: bigint,
): OnboardingAllowlist {
  return {
    allowedTargets: [
      `${plan.walletPackageId}::agent_wallet::create_wallet`,
      `${plan.deepbookPackageId}::balance_manager::new`,
      `${SUI_FRAMEWORK_PACKAGE_ID}::transfer::public_share_object`,
      `${plan.deepbookPackageId}::balance_manager::mint_trade_cap`,
    ],
    allowedRecipients: [signerAddress],
    budgetCeilingMist,
  };
}

interface PreparedOnboardingPlan {
  status: 'prepared';
  signed: false;
  reason: string;
  plan: {
    setupPtb: string;
    tradeCapPtb: string;
    runSetTemplate: RunSet;
  };
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
): Promise<RunSet | PreparedOnboardingPlan> {
  if (!plan.confirmed) throw new Error('Run-set creation must be confirmed.');
  if (!isRunSetTemplate(plan.runSetTemplate)) throw new Error('runSetTemplate is missing required fields.');
  if (!signer.address) throw new Error('No local signer key configured.');
  const signerAddress = signer.address;

  const onboarding = loadOnboardingConfig();
  const budgetCeilingMist = BigInt(onboarding.maxAutoSetupBudgetMist);
  const budgetMist = BigInt(plan.runSetTemplate.maxAmountMist);
  if (budgetMist > budgetCeilingMist) {
    throw new Error(`Run-set budget ${budgetMist} MIST exceeds maxAutoSetupBudgetMist ${budgetCeilingMist}.`);
  }

  // R8: never sign backend-supplied bytes without structural policy inspection — unconditionally,
  // regardless of whether the env gate below ends up allowing a signature at all.
  const allowlist = onboardingAllowlistFor(plan, signerAddress, budgetCeilingMist);
  inspectOnboarding(decodePtb(plan.setupPtb), allowlist);
  inspectOnboarding(decodePtb(plan.tradeCapPtb), allowlist);

  if (!isAutoOnboardingAllowed()) {
    return {
      status: 'prepared',
      signed: false,
      reason:
        'RILL_ALLOW_AUTO_ONBOARDING is not "true" in the signer launch environment. The setup and trade-cap ' +
        'PTBs passed structural inspection but were not signed or submitted. Relaunch the signer with ' +
        'RILL_ALLOW_AUTO_ONBOARDING=true to allow auto-onboarding, or sign this plan through another trusted path.',
      plan: { setupPtb: plan.setupPtb, tradeCapPtb: plan.tradeCapPtb, runSetTemplate: plan.runSetTemplate },
    };
  }

  const balance = await signer.client.getBalance({ owner: signerAddress });
  if (BigInt(balance.balance.balance) < MIN_GAS_BALANCE_MIST) {
    throw new Error(`Signer balance too low for setup gas (need > ${MIN_GAS_BALANCE_MIST} MIST).`);
  }

  const setupResult = await signAndExecutePtb(plan.setupPtb, signer, cfg);
  const walletId = extractCreatedObjectId(setupResult.effects as never, '::agent_wallet::AgentWallet');
  const agentCapId = extractCreatedObjectId(setupResult.effects as never, '::agent_wallet::AgentCap');
  const balanceManagerId = extractCreatedObjectId(setupResult.effects as never, '::balance_manager::BalanceManager');

  const tradeCapPtb = buildTradeCapPtb(plan.deepbookPackageId, balanceManagerId, signerAddress);
  const tradeCapResult = await signAndExecutePtb(tradeCapPtb, signer, cfg);
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

/** The persisted, non-privileged config plus the live (env-derived, read-only here) auto-onboarding
 * gate — merged so callers can see whether auto-onboarding is active without being able to set it. */
function effectiveOnboardingConfig(): OnboardingConfig & { autoCreateRunSets: boolean } {
  return { ...loadOnboardingConfig(), autoCreateRunSets: isAutoOnboardingAllowed() };
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
        // Direct custody has no run-set policy and no on-chain AgentWallet — never require either.
        if (loadCustodyMode() === 'direct') return readDirectWalletStatus(signer);
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
        return effectiveOnboardingConfig();
      }
      case 'set_onboarding_config': {
        assertOnlyArguments(args, ['maxAutoSetupBudgetMist', 'allowTestnetFaucet']);
        saveOnboardingConfig(args as Partial<Pick<OnboardingConfig, 'maxAutoSetupBudgetMist' | 'allowTestnetFaucet'>>);
        return effectiveOnboardingConfig();
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
