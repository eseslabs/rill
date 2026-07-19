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
   * narrowed `runFlow` to DeepBook-only. Supports two shapes, both compiled and simulated through
   * the SAME `compilerService.compileFlow` entry point the DeepBook path uses (the compiler already
   * fully supports both node types, and their chaining, via `cetus.adapter.ts`'s `feedsHaedal`
   * wiring — the same coin-chain `/simulate` already exercises; only `runFlow` had narrowed):
   *  - a single supported action node (one `cetus_swap` XOR one `haedal_stake`) — a one-entry
   *    `steps` manifest, unchanged from before this combo extension;
   *  - a Cetus-swap-into-Haedal-stake CHAIN (one `cetus_swap` node whose `coin_out` is wired into
   *    one `haedal_stake` node's `sui_coin`) — a two-entry `steps` manifest, swap step first.
   * Either way the envelope carries no DeepBook fields (see `envelope.schema.ts`'s `.superRefine`,
   * which accepts the DeepBook trio OR a non-empty `steps` manifest). Any other shape — 0 action
   * nodes, >1 of the same type, an unconnected swap+stake pair, or >2 action nodes — is rejected
   * before any compile/simulate work happens.
   */
  private async runGenericAction(
    flow: FlowGraph,
    params: Record<string, unknown>,
    options: RunFlowOptions,
  ): Promise<ExecutionEnvelope | ActionBuildRefusal> {
    const actionNodes = flow.nodes.filter((node) => isGenericActionNodeType(node.type));
    const swapNodes = actionNodes.filter((node) => node.type === 'cetus_swap');
    const stakeNodes = actionNodes.filter((node) => node.type === 'haedal_stake');

    const isSingleAction = actionNodes.length === 1;
    // A recognized swap→stake CHAIN, not merely "one of each": `haedal_stake` has no source handle
    // at all (`protocols/handles.ts`'s NODE_HANDLES — a stake can never feed anything downstream),
    // so the only wiring direction that can ever exist between them is swap -> stake. This edge
    // check only confirms the NODES are connected; `compileFlow`'s own structural validation
    // (`findFlowStructureIssues`, called inside `compileFlow`) independently re-checks the edge uses
    // the exact `coin_out`/`sui_coin` handle names once we call it below.
    const isSwapToStakeChain =
      actionNodes.length === 2 &&
      swapNodes.length === 1 &&
      stakeNodes.length === 1 &&
      flow.edges.some((edge) => edge.source === swapNodes[0].id && edge.target === stakeNodes[0].id);

    if (!isSingleAction && !isSwapToStakeChain) {
      throw new ValidationError(
        `build_action supports either exactly one supported action node (a single `
          + `deepbook_limit_order, cetus_swap, or haedal_stake) or a Cetus-swap-into-Haedal-stake `
          + `chain (one cetus_swap node wired into one haedal_stake node); found 0 `
          + `deepbook_limit_order node(s), ${swapNodes.length} cetus_swap node(s), and `
          + `${stakeNodes.length} haedal_stake node(s) among ${flow.nodes.length} total.`,
      );
    }

    const compiled = await compilerService.compileFlow(flow, {
      sender: options.sender,
      agentWallet: options.agentWallet,
    }, params);
    const resolvedActionNodes = compiled.resolvedFlow.nodes.filter((node) => isGenericActionNodeType(node.type));
    // Execution order (topological): for the single-action shape this is trivially the one node;
    // for the chain shape it is ALWAYS swap-then-stake — never re-derived from array/declaration
    // order — because (per the doc comment above) a `haedal_stake` node structurally cannot precede
    // a `cetus_swap` node in any valid wiring this codebase accepts.
    const orderedActionNodes = isSwapToStakeChain
      ? [
          resolvedActionNodes.find((node) => node.type === 'cetus_swap')!,
          resolvedActionNodes.find((node) => node.type === 'haedal_stake')!,
        ]
      : resolvedActionNodes;

    const preview = previewService.buildPreview(compiled.resolvedFlow, compiled.warnings);
    const unsignedPtb = await serializeUnsignedPtb(compiled.transaction);
    const simulation = await simulatorService.simulateTransaction(compiled.transaction, options.sender);

    // Same unconditional envelope gate as the DeepBook path (R3/KTD-4) — see that method's comment.
    // An honest note for the swap→stake chain specifically: a non-SUI-input swap (e.g. the
    // USDC->SUI leg that feeds a stake) needs the simulation SENDER to actually hold that coin type
    // — a dry run cannot mint balances (see `cetus.adapter.ts`'s `sourceCoinFromSender`). If it
    // doesn't, simulation fails and this refusal is what the caller gets — never faked as success.
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
    const steps = this.buildSteps(orderedActionNodes, compiled.budgetSpendMist);

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
      steps,
    };
  }

  /**
   * Builds one `EnvelopeStep` per node in `nodes` (already in execution order — see
   * `runGenericAction`). Only the FIRST node draws root funding straight from the agent_wallet
   * spend: `compiler.service.ts`'s `computeRootSuiFunding` sums `rootSuiFunding` per node, and both
   * adapters return `0n` whenever the node has an incoming coin edge (`cetus.adapter.ts`/
   * `haedal.adapter.ts`) — which is exactly the case for a chain's downstream node (its coin comes
   * from the upstream step's OWN output, not a fresh wallet split). So for the single-action shape
   * (one node) this is unchanged: that node gets the whole `budgetSpendMist`. For the swap→stake
   * chain, the swap (root-funded) gets `budgetSpendMist`; the stake (fed by the swap's output, zero
   * additional wallet draw) honestly declares `spendAmountMist: '0'` — see `buildStep`'s doc comment
   * for the caveat this leaves for signer-side validation.
   */
  private buildSteps(nodes: FlowNode[], budgetSpendMist: bigint): EnvelopeStep[] {
    return nodes.map((node, index) => this.buildStep(node, index === 0 ? budgetSpendMist : 0n));
  }

  /**
   * Derives one `EnvelopeStep` from the resolved node's own config (the same config the matching
   * adapter — `cetus.adapter.ts`/`haedal.adapter.ts` — just built the PTB from) plus
   * `spendAmountMistValue` (see `buildSteps`'s doc comment for how that's chosen per node).
   *
   * `min_amount_out` (Cetus) has no fallback here, matching `cetus.adapter.ts`'s own R7 stance: a
   * swap that defers its slippage floor to a downstream guardrail node (rather than setting
   * `min_amount_out` directly) has no single value to declare in this manifest, so that combination
   * is rejected with a clear message instead of silently guessing.
   *
   * KNOWN GAP (combo chain only, not this task's scope to fix): `packages/rill-signer/src/steps/
   * haedal.ts`'s `haedalStakeStepValidator` currently requires ITS OWN step's funding coin to be a
   * fresh `SplitCoins` off the shared wallet-spend result (`ctx.spendIndex`) — the model the WS2
   * generic signer design was built for is several INDEPENDENTLY wallet-funded steps composed into
   * one PTB (see `steps/deepbook.ts`'s doc comment: "each fund their own leg"), not a downstream
   * step consuming an UPSTREAM step's PTB output via `NestedResult`, which is what a real
   * swap→stake coin chain compiles to. So today, a two-step envelope built by this method for a
   * chain will fail local `execute_rill_action` at the Haedal step ("Haedal stake coin is not
   * wallet-funded") even though the backend's build/simulate is honest and correct on-chain. Fixing
   * that is signer-side work, out of scope here — `spendAmountMist: '0'` on the downstream step is
   * chosen so the SUM of `steps[].spendAmountMist` still equals the PTB's one real wallet draw,
   * ready for whichever future signer-side fix teaches `inspectGeneric` to follow a coin chain.
   */
  private buildStep(node: FlowNode, spendAmountMistValue: bigint): EnvelopeStep {
    const spendAmountMist = spendAmountMistValue.toString();

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
