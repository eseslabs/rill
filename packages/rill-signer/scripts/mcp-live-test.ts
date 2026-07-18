#!/usr/bin/env bun
import { assertExecutionEnvelope, type ExecutionEnvelope } from '../../rill-sdk/src';

const BACKEND = (process.env.RILL_BACKEND || 'http://localhost:3002').replace(/\/$/, '');
const ACTION_ID = process.env.RILL_ACTION_ID;
const NETWORK = process.env.SUI_NETWORK || 'testnet';

if (!ACTION_ID) throw new Error('RILL_ACTION_ID is required.');
if (!process.env.RILL_SIGNER_POLICY_PATH) throw new Error('RILL_SIGNER_POLICY_PATH is required.');
if (!process.env.RILL_SUI_PRIVATE_KEY && !process.env.SUI_PRIVATE_KEY) {
  throw new Error('Set the local signer key in the launching shell environment.');
}

type ToolResult = {
  content?: { type: string; text: string }[];
  isError?: boolean;
};

type RpcResponse = {
  id?: number | string | null;
  result?: ToolResult & {
    serverInfo?: { name?: string };
    tools?: { name: string }[];
  };
  error?: { code: number; message: string };
};

type WalletStatus = {
  address?: string;
  strategyEligible: boolean;
};

type Capabilities = {
  actionId: string;
  walletPackageId: string;
  walletId: string;
  agentCapId: string;
  balanceManagerId: string;
  tradeCapId: string;
  demoParams: Record<string, unknown>;
};

function pass(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`[pass] ${label}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolPayload(response: RpcResponse): { data: unknown; isError: boolean } {
  if (response.error) throw new Error(`JSON-RPC ${response.error.code}: ${response.error.message}`);
  const text = response.result?.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('MCP tool returned no text content.');
  return { data: JSON.parse(text), isError: response.result?.isError === true };
}

async function remoteCall(id: number, method: string, params?: unknown): Promise<RpcResponse> {
  const response = await fetch(`${BACKEND}/api/mcp/${ACTION_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (!response.ok) throw new Error(`rill-actions ${method} HTTP ${response.status}`);
  return response.json() as Promise<RpcResponse>;
}

class McpClient {
  private readonly process = Bun.spawn(['bun', 'run', `${import.meta.dir}/../src/mcp.ts`], {
    env: { ...process.env, SUI_NETWORK: NETWORK },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  private buffer = '';
  private readonly pending = new Map<number, (message: RpcResponse) => void>();
  private readonly reader = this.process.stdout.getReader();

  constructor() {
    void this.pump();
  }

  private async pump() {
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await this.reader.read();
      if (done) return;
      this.buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line) as RpcResponse;
        if (typeof message.id !== 'number') continue;
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      }
    }
  }

  call(id: number, method: string, params?: unknown): Promise<RpcResponse> {
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      this.process.stdin.flush();
    });
  }

  notify(method: string) {
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    this.process.stdin.flush();
  }

  kill() {
    this.process.kill();
  }
}

async function buildEnvelope(status: WalletStatus, capabilities: Capabilities): Promise<ExecutionEnvelope> {
  pass(status.address, 'wallet_status returns the local signer address');
  const response = await remoteCall(5, 'tools/call', {
    name: 'build_action',
    arguments: {
      actionId: ACTION_ID,
      sender: status.address,
      agentWallet: {
        packageId: capabilities.walletPackageId,
        walletId: capabilities.walletId,
        capId: capabilities.agentCapId,
      },
      params: {
        ...capabilities.demoParams,
        balanceManagerId: capabilities.balanceManagerId,
        tradeCapId: capabilities.tradeCapId,
      },
    },
  });
  const payload = toolPayload(response);
  if (payload.isError) throw new Error(`build_action rejected: ${JSON.stringify(payload.data)}`);
  return assertExecutionEnvelope(payload.data);
}

async function main() {
  console.log(`@rill/signer bounded MCP live test - ${NETWORK}`);
  const wallet = new McpClient();
  try {
    const initialized = await wallet.call(1, 'initialize', {});
    pass(initialized.result?.serverInfo?.name === 'rill-wallet', 'initialize rill-wallet');
    wallet.notify('notifications/initialized');

    const statusResult = toolPayload(await wallet.call(2, 'tools/call', {
      name: 'wallet_status',
      arguments: {},
    }));
    pass(!statusResult.isError, 'wallet_status succeeds');
    const status = statusResult.data as WalletStatus;
    pass(status.strategyEligible, 'wallet strategy is eligible');

    const capabilitiesResult = toolPayload(await wallet.call(3, 'tools/call', {
      name: 'list_capabilities',
      arguments: {},
    }));
    pass(!capabilitiesResult.isError, 'list_capabilities succeeds');
    const capabilities = capabilitiesResult.data as Capabilities;
    pass(capabilities.actionId === ACTION_ID, 'local policy action matches RILL_ACTION_ID');

    const remoteInitialized = await remoteCall(1, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'rill-live-test', version: '1.0.0' },
    });
    pass(remoteInitialized.result?.serverInfo?.name === 'rill-actions', 'initialize rill-actions');

    const listedTools = await remoteCall(2, 'tools/list');
    pass(
      JSON.stringify(listedTools.result?.tools?.map((tool) => tool.name)) ===
        JSON.stringify(['list_actions', 'describe_action', 'build_action']),
      'rill-actions exposes exactly the bounded tools',
    );

    const actions = toolPayload(await remoteCall(3, 'tools/call', {
      name: 'list_actions',
      arguments: {},
    }));
    pass(!actions.isError, 'list_actions succeeds');
    const listedAction = actions.data && Array.isArray(actions.data) && actions.data.length === 1
      ? (actions.data[0] as {
          actionId?: unknown;
          walletBound?: unknown;
          network?: unknown;
        })
      : undefined;
    pass(listedAction?.actionId === ACTION_ID, 'list_actions returns RILL_ACTION_ID');
    pass(listedAction?.walletBound === true, 'list_actions reports walletBound');
    pass(listedAction?.network === NETWORK, 'list_actions reports network');

    const description = toolPayload(await remoteCall(4, 'tools/call', {
      name: 'describe_action',
      arguments: { actionId: ACTION_ID },
    }));
    pass(!description.isError, 'describe_action succeeds');
    const described = description.data as {
      actionId?: unknown;
      runtimeParameters?: Record<string, unknown> & { properties?: Record<string, unknown>; required?: unknown[] };
      agentWallet?: Record<string, unknown> & { properties?: Record<string, unknown>; required?: unknown[] };
      requiredTargets?: unknown[];
      requiredPublicObjects?: unknown[];
      requiredGuards?: unknown[];
      simulationRule?: unknown;
      signingRule?: unknown;
    };
    pass(
      described.actionId === ACTION_ID &&
        !!described.runtimeParameters &&
        !!described.agentWallet &&
        Array.isArray(described.requiredTargets) &&
        Array.isArray(described.requiredPublicObjects),
      'describe_action returns the bounded runtime contract',
    );
    pass(
      Array.isArray(described.runtimeParameters?.required) &&
        described.runtimeParameters.required.length > 0 &&
        described.runtimeParameters.properties?.poolKey?.type === 'string' &&
        described.runtimeParameters.properties?.price?.type === 'number' &&
        described.runtimeParameters.properties?.isBid?.type === 'boolean',
      'describe_action runtime parameters have expected names/types/required list',
    );
    pass(
      Array.isArray(described.agentWallet?.required) &&
        described.agentWallet.required.includes('packageId') &&
        described.agentWallet.required.includes('walletId') &&
        described.agentWallet.required.includes('capId'),
      'describe_action wallet schema requires packageId, walletId, capId',
    );
    pass(
      described.requiredTargets.some((t) => typeof t === 'string' && t.endsWith('::agent_wallet::spend')) &&
        described.requiredTargets.some((t) => typeof t === 'string' && t.endsWith('::pool::place_limit_order')),
      'describe_action lists required agent_wallet::spend and place_limit_order targets',
    );
    pass(
      described.requiredPublicObjects.some(
        (o) => isRecord(o) && o.role === 'AgentWallet' && o.source === 'agentWallet.walletId',
      ) &&
        described.requiredPublicObjects.some(
          (o) => isRecord(o) && o.role === 'BalanceManager' && o.source === 'params.balanceManagerId',
        ) &&
        described.requiredPublicObjects.some((o) => isRecord(o) && o.role === 'Clock' && o.objectId === '0x6'),
      'describe_action lists required public object roles',
    );
    pass(
      Array.isArray(described.requiredGuards) && described.requiredGuards.length === 0,
      'describe_action exposes requiredGuards (empty for DeepBook hero)',
    );
    pass(
      typeof described.simulationRule === 'string' && typeof described.signingRule === 'string',
      'describe_action states simulation and signing rules before build',
    );

    const envelope = await buildEnvelope(status, capabilities);
    pass(envelope.actionId === ACTION_ID, 'remote build_action returns a fresh ExecutionEnvelope');

    const execution = toolPayload(await wallet.call(4, 'tools/call', {
      name: 'execute_rill_action',
      arguments: { envelope },
    }));
    const digest = (execution.data as { digest?: unknown }).digest;
    pass(!execution.isError && typeof digest === 'string' && digest.length > 0, 'execute_rill_action submits successfully');
    console.log(`  digest: ${digest}`);

    const badDigest = `${envelope.actionDigest[0] === '0' ? '1' : '0'}${envelope.actionDigest.slice(1)}`;
    const rejection = toolPayload(await wallet.call(5, 'tools/call', {
      name: 'execute_rill_action',
      arguments: { envelope: { ...envelope, actionDigest: badDigest } },
    }));
    pass(rejection.isError, 'mutated envelope digest is rejected locally');

    const explanation = toolPayload(await wallet.call(6, 'tools/call', {
      name: 'explain_rejection',
      arguments: {},
    }));
    pass(!explanation.isError, 'explain_rejection succeeds');
    pass(
      JSON.stringify(explanation.data) === JSON.stringify(rejection.data),
      'explain_rejection returns the recorded policy rejection',
    );
  } finally {
    wallet.kill();
  }
}

main().catch((error) => {
  console.error('FATAL:', error);
  process.exit(1);
});
