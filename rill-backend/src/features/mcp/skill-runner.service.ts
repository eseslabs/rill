import type { ExecutionEnvelope } from '../../../../packages/rill-sdk/src/types';
import { RUNTIME_KEYS } from '../../core/node-config';
import type { AgentWalletBinding } from '../../core/agent-wallet';
import { config } from '../../core/config';
import { ValidationError } from '../../core/errors';
import { mainnetPools, testnetPools } from '@mysten/deepbook-v3';
import { compilerService, type FlowGraph } from '../compiler/compiler.service';
import { previewService } from '../compiler/preview.service';
import { inspectTransaction, serializeUnsignedPtb } from '../compiler/ptb.util';
import { simulatorService } from '../compiler/simulator.service';
import { digestUnsignedPtb } from '../../../../packages/rill-sdk/src/execution-envelope';

export interface RunFlowOptions {
  actionId: string;
  sender: string;
  agentWallet: AgentWalletBinding;
}

export class SkillRunnerService {
  async runFlow(
    flow: FlowGraph,
    params: Record<string, unknown>,
    options: RunFlowOptions,
  ): Promise<ExecutionEnvelope> {
    if (flow.nodes.length === 0) {
      throw new ValidationError('Cannot build an empty flow.');
    }

    const compileResult = await compilerService.compileFlow(flow, {
      sender: options.sender,
      agentWallet: options.agentWallet,
    }, params);

    const preview = previewService.buildPreview(compileResult.resolvedFlow, compileResult.warnings);
    const unsignedPtb = await serializeUnsignedPtb(compileResult.transaction);
    const simulation = await simulatorService.simulateTransaction(compileResult.transaction, options.sender);
    const inspection = inspectTransaction(compileResult.transaction);

    const resolvedParams: Record<string, unknown> = {};
    for (const node of compileResult.resolvedFlow.nodes) {
      const keys = RUNTIME_KEYS[node.type] ?? [];
      for (const key of keys) {
        if (node.config && node.config[key] !== undefined) {
          resolvedParams[key] = node.config[key];
        }
      }
    }

    // For DeepBook flows, enrich resolvedParams with the canonical poolId so the signer can verify it.
    if (resolvedParams.poolKey && typeof resolvedParams.poolKey === 'string') {
      const pools = (config.network === 'testnet' ? testnetPools : mainnetPools) as Record<
        string,
        { address: string }
      >;
      const pool = pools[resolvedParams.poolKey];
      if (!pool) {
        throw new ValidationError(`Unknown DeepBook poolKey ${resolvedParams.poolKey} on ${config.network}.`);
      }
      resolvedParams.poolId = pool.address;
    }

    // Also expose any runtime params the caller passed that are not already set (e.g., overridable defaults).
    for (const [key, value] of Object.entries(params)) {
      if (resolvedParams[key] === undefined) {
        resolvedParams[key] = value;
      }
    }

    resolvedParams.spendAmountMist = compileResult.budgetSpendMist.toString();

    const deepbookNode = compileResult.resolvedFlow.nodes.find((n) => n.type === 'deepbook_limit_order');

    return {
      version: '1',
      actionId: options.actionId,
      actionDigest: await digestUnsignedPtb(unsignedPtb),
      network: config.network,
      sender: options.sender,
      walletPackageId: options.agentWallet.packageId,
      walletId: options.agentWallet.walletId,
      agentCapId: options.agentWallet.capId,
      balanceManagerId: deepbookNode?.config?.balanceManagerId as string | undefined,
      tradeCapId: deepbookNode?.config?.tradeCapId as string | undefined,
      resolvedParams,
      allowedTargets: inspection.allowedTargets,
      requiredObjectIds: inspection.objectIds,
      requiredGuards: inspection.allowedTargets.filter((target) =>
        target.endsWith('::guard::assert_min_value')
      ),
      unsignedPtb,
      preview,
      simulation,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
  }
}

export const skillRunnerService = new SkillRunnerService();
