import { mainnetPools, testnetPools } from '@mysten/deepbook-v3';
import { digestUnsignedPtb } from '../../../../packages/rill-sdk/src/execution-envelope';
import type { EnvelopeStep, ExecutionEnvelope } from '../../../../packages/rill-sdk/src/types';
import type { AgentWalletBinding } from '../../core/agent-wallet';
import { config } from '../../core/config';
import { ValidationError } from '../../core/errors';
import {
  resolveCetusSwapConfig,
  resolveDeepbookOrderConfig,
  resolveHaedalStakeConfig,
  suiToMist,
} from '../../core/node-config';
import { compilerService, type FlowGraph, type FlowNode } from '../compiler/compiler.service';
import { previewService } from '../compiler/preview.service';
import { inspectTransaction, serializeUnsignedPtb } from '../compiler/ptb.util';
import { simulatorService, type SimulationResult } from '../compiler/simulator.service';

/** Flow node types `runFlow`'s generic (non-DeepBook) branch knows how to turn into one `steps`
 *  entry. Kept local to this file (not re-derived from `STEP_NODE_TYPES`, which also lists
 *  `deepbook_limit_order` — a type this branch never handles, that node type is the OTHER branch). */
const GENERIC_ACTION_NODE_TYPES = ['cetus_swap', 'haedal_stake'] as const;
type GenericActionNodeType = (typeof GENERIC_ACTION_NODE_TYPES)[number];

function isGenericActionNodeType(type: string): type is GenericActionNodeType {
  return (GENERIC_ACTION_NODE_TYPES as readonly string[]).includes(type);
}

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

    // Any count other than exactly one DeepBook node is only ever a hard rejection when there IS at
    // least one — an ambiguous "which order?" build request. Zero DeepBook nodes is NOT rejected
    // here: that is the normal shape of a Cetus-swap/Haedal-stake flow, handled by the generic
    // branch below.
    if (orderCount > 1) {
      throw new ValidationError(
        `Demo Day build requires exactly one DeepBook limit-order node; found ${orderCount}.`,
      );
    }

    if (orderCount === 1) {
      return this.runDeepbookOrder(flow, params, options);
    }

    return this.runGenericAction(flow, params, options);
  }

  /**
   * The ORIGINAL, single-DeepBook build path — reproduced verbatim (identical compile options,
   * identical envelope fields, identical order) behind the dispatch above. Every pre-existing test
   * exercising a `deepbook_limit_order` flow must keep passing unmodified; this method's body is
   * untouched from before `runFlow` learned to also serve Cetus swap / Haedal stake.
   */
  private async runDeepbookOrder(
    flow: FlowGraph,
    params: Record<string, unknown>,
    options: RunFlowOptions,
  ): Promise<ExecutionEnvelope | ActionBuildRefusal> {
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
    // ExecutionEnvelope, full stop — no field flips this, no caller can opt out of it. This method
    // structurally only ever serves the single-`deepbook_limit_order` hero path (checked by the
    // caller), so the Cetus devInspect-version-check fallback (`simulator.service.ts`'s
    // `verification: 'unverified'`) can never reach here — this gate is a plain `ok` check, not a
    // verification carve-out.
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

  /**
   * The generic (non-DeepBook) build path, restoring what regressed when the keyless refactor
   * narrowed `runFlow` to DeepBook-only: a flow with exactly one supported action node — a single
   * `cetus_swap` or a single `haedal_stake` — compiles and simulates through the SAME
   * `compilerService.compileFlow` entry point the DeepBook path uses (the compiler already fully
   * supports both node types; only `runFlow` had narrowed), then returns an ExecutionEnvelope built
   * around a one-entry `steps` manifest instead of the DeepBook-only `balanceManagerId`/`tradeCapId`/
   * `resolvedParams` trio (see `envelope.schema.ts`'s `.superRefine`, which now accepts either
   * shape). A flow with neither a `deepbook_limit_order` node nor exactly one supported generic
   * action node is rejected before any compile/simulate work happens.
   */
  private async runGenericAction(
    flow: FlowGraph,
    params: Record<string, unknown>,
    options: RunFlowOptions,
  ): Promise<ExecutionEnvelope | ActionBuildRefusal> {
    const actionNodes = flow.nodes.filter((node) => isGenericActionNodeType(node.type));
    if (actionNodes.length !== 1) {
      throw new ValidationError(
        `build_action requires exactly one supported action node — a single deepbook_limit_order, `
          + `cetus_swap, or haedal_stake node; found 0 deepbook_limit_order node(s) and `
          + `${actionNodes.length} cetus_swap/haedal_stake node(s) among ${flow.nodes.length} total.`,
      );
    }

    const compiled = await compilerService.compileFlow(flow, {
      sender: options.sender,
      agentWallet: options.agentWallet,
    }, params);
    const actionNode = compiled.resolvedFlow.nodes.find((node) => isGenericActionNodeType(node.type))!;

    const preview = previewService.buildPreview(compiled.resolvedFlow, compiled.warnings);
    const unsignedPtb = await serializeUnsignedPtb(compiled.transaction);
    const simulation = await simulatorService.simulateTransaction(compiled.transaction, options.sender);

    // Same unconditional envelope gate as the DeepBook path (R3/KTD-4) — see that method's comment.
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
    const step = this.buildStep(actionNode, compiled.budgetSpendMist);

    return {
      version: '1',
      actionId: options.actionId,
      actionDigest: await digestUnsignedPtb(unsignedPtb),
      network: config.network,
      sender: options.sender,
      walletPackageId: options.agentWallet.packageId,
      walletId: options.agentWallet.walletId,
      agentCapId: options.agentWallet.capId,
      allowedTargets: inspection.allowedTargets,
      requiredObjectIds: inspection.objectIds,
      requiredGuards: inspection.allowedTargets.filter((target) =>
        target.endsWith('::guard::assert_min_value')
      ),
      unsignedPtb,
      preview,
      simulation,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      steps: [step],
    };
  }

  /**
   * Derives the one `EnvelopeStep` entry for `runGenericAction` from the resolved node's own config
   * (the same config the matching adapter — `cetus.adapter.ts`/`haedal.adapter.ts` — just built the
   * PTB from) plus the compiler's own computed `budgetSpendMist` (the exact amount released by
   * `request_spend`/`confirm_spend` for this compile — see `compiler.service.ts`'s
   * `computeRootSuiFunding`), rather than re-deriving the funded amount independently: with exactly
   * one action node and no other coin-consuming node in scope, `budgetSpendMist` IS this step's
   * whole spend, and is guaranteed consistent with what the signer's `inspectGeneric` reads back off
   * the PTB's own `request_spend` argument.
   *
   * `min_amount_out` (Cetus) has no fallback here, matching `cetus.adapter.ts`'s own R7 stance: a
   * swap that defers its slippage floor to a downstream guardrail node (rather than setting
   * `min_amount_out` directly) has no single value to declare in a one-entry `steps` manifest, so
   * that combination is rejected with a clear message instead of silently guessing.
   */
  private buildStep(node: FlowNode, budgetSpendMist: bigint): EnvelopeStep {
    const spendAmountMist = budgetSpendMist.toString();

    if (node.type === 'cetus_swap') {
      const { config: swapCfg } = resolveCetusSwapConfig(node);
      if (!swapCfg.min_amount_out) {
        throw new ValidationError(
          `Node ${node.id}: build_action's generic (non-DeepBook) path requires config.min_amount_out `
            + `to be set directly on the swap node — deferring the slippage floor to a downstream `
            + `guardrail node is not supported by this path yet.`,
        );
      }
      return {
        nodeType: 'cetus_swap',
        poolId: swapCfg.pool,
        minOutMist: swapCfg.min_amount_out,
        spendAmountMist,
      };
    }

    const { config: stakeCfg } = resolveHaedalStakeConfig(node);
    return {
      nodeType: 'haedal_stake',
      validator: stakeCfg.validator ?? '0x0',
      spendAmountMist,
    };
  }
}

export const skillRunnerService = new SkillRunnerService();
