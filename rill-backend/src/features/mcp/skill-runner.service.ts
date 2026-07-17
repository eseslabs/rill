import { mainnetPools, testnetPools } from '@mysten/deepbook-v3';
import { digestUnsignedPtb } from '../../../../packages/rill-sdk/src/execution-envelope';
import type { ExecutionEnvelope } from '../../../../packages/rill-sdk/src/types';
import type { AgentWalletBinding } from '../../core/agent-wallet';
import { config } from '../../core/config';
import { ValidationError } from '../../core/errors';
import { resolveDeepbookOrderConfig, suiToMist } from '../../core/node-config';
import { compilerService, type FlowGraph } from '../compiler/compiler.service';
import { previewService } from '../compiler/preview.service';
import { inspectTransaction, serializeUnsignedPtb } from '../compiler/ptb.util';
import { simulatorService } from '../compiler/simulator.service';

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
    const orderCount = flow.nodes.filter((node) => node.type === 'deepbook_limit_order').length;
    if (orderCount !== 1) {
      throw new ValidationError(
        `Demo Day build requires exactly one DeepBook limit-order node; found ${orderCount}.`,
      );
    }

    const compiled = await compilerService.compileFlow(flow, {
      sender: options.sender,
      agentWallet: options.agentWallet,
    }, params);
    const orderNode = compiled.resolvedFlow.nodes.find((node) => node.type === 'deepbook_limit_order')!;
    const order = resolveDeepbookOrderConfig(orderNode).config;
    if (!order.poolKey || !order.balanceManagerId || !order.tradeCapId || order.price == null || order.quantity == null) {
      throw new ValidationError(
        'DeepBook runtime params require poolKey, balanceManagerId, tradeCapId, price, and quantity.',
      );
    }

    const preview = previewService.buildPreview(compiled.resolvedFlow, compiled.warnings);
    const unsignedPtb = await serializeUnsignedPtb(compiled.transaction);
    const simulation = await simulatorService.simulateTransaction(compiled.transaction, options.sender);
    const inspection = inspectTransaction(compiled.transaction);
    const pools = (config.network === 'testnet' ? testnetPools : mainnetPools) as Record<
      string,
      { address: string }
    >;
    const pool = pools[order.poolKey];
    if (!pool) {
      throw new ValidationError(`Unknown DeepBook poolKey ${order.poolKey} on ${config.network}.`);
    }

    return {
      version: '1',
      actionId: options.actionId,
      actionDigest: await digestUnsignedPtb(unsignedPtb),
      network: config.network,
      sender: options.sender,
      walletPackageId: options.agentWallet.packageId,
      walletId: options.agentWallet.walletId,
      agentCapId: options.agentWallet.capId,
      balanceManagerId: order.balanceManagerId,
      tradeCapId: order.tradeCapId,
      resolvedParams: {
        poolKey: order.poolKey,
        poolId: pool.address,
        price: order.price,
        quantity: order.quantity,
        isBid: order.isBid,
        payWithDeep: order.payWithDeep,
        clientOrderId: order.clientOrderId,
        depositSui: order.depositSui,
        spendAmountMist: suiToMist(order.depositSui, 'config.depositSui').toString(),
      },
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
