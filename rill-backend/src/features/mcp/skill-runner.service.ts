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
import { simulatorService, type SimulationResult } from '../compiler/simulator.service';

export interface RunFlowOptions {
  actionId: string;
  sender: string;
  agentWallet: AgentWalletBinding;
}

/**
 * Returned by `runFlow` instead of an `ExecutionEnvelope` whenever strict simulation fails
 * (R3/KTD-4) — unconditionally, with no carve-out and no bypass field on the envelope itself.
 * Deliberately envelope-shaped-nothing-alike (no `unsignedPtb`/`actionDigest`/`version`) so it can
 * never be mistaken for something signable by a caller that skips the `refused` check.
 */
export interface ActionBuildRefusal {
  refused: true;
  actionId: string;
  reason: string;
  simulation: SimulationResult;
}

export class SkillRunnerService {
  async runFlow(
    flow: FlowGraph,
    params: Record<string, unknown>,
    options: RunFlowOptions,
  ): Promise<ExecutionEnvelope | ActionBuildRefusal> {
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

    // Unconditional envelope gate (R3/KTD-4): a flow that fails strict simulation never gets an
    // ExecutionEnvelope, full stop — no field flips this, no caller can opt out of it. `runFlow`
    // structurally only ever serves the single-`deepbook_limit_order` hero path (checked above),
    // so the Cetus devInspect-version-check fallback (`simulator.service.ts`'s `verification:
    // 'unverified'`) can never reach here — this gate is a plain `ok` check, not a verification
    // carve-out.
    if (!simulation.ok) {
      return {
        refused: true,
        actionId: options.actionId,
        reason: `Rill never hands out a signable ExecutionEnvelope for a transaction that failed `
          + `strict simulation: ${simulation.error ?? 'simulation failed with no further detail'}`,
        simulation,
      };
    }

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
