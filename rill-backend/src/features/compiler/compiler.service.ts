import { Transaction } from '@mysten/sui/transactions';
import type { AgentWalletBinding } from '../../core/agent-wallet';
import { SUI_COIN_TYPE } from '../../core/agent-wallet';
import { ValidationError } from '../../core/errors';
import { resolveEffectiveFlow } from '../../core/node-config';
import { SUI_CLOCK_ID } from '../../core/protocols';
import { getAdapter } from '../protocols/registry';
import { findFlowStructureIssues } from '../protocols/handles';
import { injectMinOutAssert, resolveGuardrailCoinType, resolveGuardrailMinValue } from '../protocols/guard';
import { CapabilityManifestSchema, toOnChainRuleParams } from '../../../../packages/rill-sdk/src/capability-manifest';
import type {
  CompileOptions,
  CompileResult,
  FlowEdge,
  FlowGraph,
  FlowNode,
  NodeOutput,
} from '../protocols/types';

// Re-exported so existing importers (`from '../compiler/compiler.service'`) keep working.
export type { FlowEdge, FlowGraph, FlowNode, CompileOptions, CompileResult };

/**
 * Compiles a visual flow graph into one unsigned PTB.
 *
 * Orchestration only — each node's Move calls live in its `ProtocolAdapter` (`features/protocols/*`).
 * Funding flows through one chokepoint: `agent_wallet::spend()` (when an agent wallet is bound) or
 * `tx.gas`, then `fundSuiCoin` hands SUI to whichever node needs it.
 *
 * PTB-default (R7): there is no node-type branch for `ptb` here, or anywhere in this file — PTB is
 * implicit, not a node the flow opts into. Every flow compiles to exactly one `Transaction`
 * whether or not it contains a (now-legacy) `ptb` node; a leftover `ptb` node from an
 * as-yet-unupdated frontend is accepted and contributes nothing (see `protocols/ptb.adapter.ts`).
 */
export class CompilerService {
  async compileFlow(
    flow: FlowGraph,
    options: CompileOptions = {},
    runtimeParams: Record<string, unknown> = {},
  ): Promise<CompileResult> {
    // Structural validation (unique node ids, edges reference real nodes, edges use a handle name
    // registered for their endpoint's node type) — the SAME check `api.schema.ts`'s `FlowSchema`
    // Zod-refines on, run here too so a direct caller that bypasses the HTTP layer entirely (the
    // MCP skill-runner calls `compileFlow` straight, never through `zValidator`) still gets a clean
    // 422 `ValidationError` instead of a confusing downstream failure or a mis-routed coin (R13).
    const structureIssues = findFlowStructureIssues(flow);
    if (structureIssues.length > 0) {
      throw new ValidationError(
        `Invalid flow: ${structureIssues.map((issue) => issue.message).join('; ')}`,
      );
    }

    const resolvedFlow = resolveEffectiveFlow(flow, runtimeParams);
    const tx = new Transaction();
    const warnings: string[] = [];
    const orderedNodes = this.topologicalSort(resolvedFlow.nodes, resolvedFlow.edges);
    const nodeOutputs: Record<string, NodeOutput> = {};
    // Coins that are produced but never chainable to another node by id (e.g. the agent_wallet
    // budget's own ≈0 remainder, a swap's opposite-side zero-coin leftover) — always swept below.
    const extraCoins: NodeOutput[] = [];

    const rootTotal = this.computeRootSuiFunding(orderedNodes, resolvedFlow);
    let budgetCoin: unknown | undefined;

    if (options.agentWallet && rootTotal > 0n) {
      if (options.agentWallet.coinType !== SUI_COIN_TYPE) {
        throw new ValidationError(
          `Agent wallet coin type ${options.agentWallet.coinType} is not supported for MVP (expected ${SUI_COIN_TYPE}).`,
        );
      }

      // U5/R8 backward-compat gate: a manifest present on the binding drives the redesigned Rule +
      // Hot Potato sequence; its absence keeps today's single `agent_wallet::spend()` call BYTE-
      // IDENTICAL (this `else` branch is untouched by U5) — the redesigned package (U1) isn't
      // deployed yet, so already-working flows against the live v2 package must keep compiling
      // exactly as they do today.
      if (options.agentWallet.capabilityManifest) {
        budgetCoin = this.buildManifestGatedSpend(tx, options.agentWallet, rootTotal, options.sender, extraCoins);
      } else {
        budgetCoin = tx.moveCall({
          target: `${options.agentWallet.packageId}::agent_wallet::spend`,
          typeArguments: [options.agentWallet.coinType],
          arguments: [
            tx.object(options.agentWallet.walletId),
            tx.object(options.agentWallet.capId),
            tx.pure.u64(rootTotal),
            tx.object(SUI_CLOCK_ID),
          ],
        });
      }
      // The released coin must be fully consumed (UnusedValueWithoutDrop) — after nodes split what
      // they need from it via `fundSuiCoin`, the ≈0 remainder is settled by the same sweep as every
      // other produced coin (KTD-3 single owner), not a bespoke merge here.
      extraCoins.push({ value: budgetCoin, coinType: SUI_COIN_TYPE });
    } else if (options.agentWallet && rootTotal === 0n) {
      warnings.push('Agent wallet configured but no root SUI funding required — spend() not inserted.');
    }

    const fundSuiCoin = (amount: bigint): unknown => {
      if (options.agentWallet && budgetCoin !== undefined) {
        const [split] = tx.splitCoins(budgetCoin as never, [amount]);
        return split;
      }
      const [split] = tx.splitCoins(tx.gas, [amount]);
      return split;
    };

    // Guardrails with ZERO incoming edges guard the root wallet-spend coin directly — there is no
    // upstream node output to iterate. Every OTHER guardrail (>=1 incoming edge, from an action, a
    // chained guardrail, or anything else) is handled exactly once, in topological order, by
    // `guardrailAdapter.build()` in the main loop below. This is the same edge-count check the
    // adapter itself makes first, so the two paths partition every guardrail node with no overlap
    // — a guardrail is never processed by both (KTD-3 dedupe).
    for (const node of resolvedFlow.nodes) {
      if (node.type !== 'guardrail') continue;
      const hasIncomingEdge = resolvedFlow.edges.some((e) => e.target === node.id);
      if (hasIncomingEdge) continue;

      const minValue = resolveGuardrailMinValue(node, warnings); // warns when <= 0 (R1)
      if (budgetCoin === undefined) {
        warnings.push(
          `Guardrail ${node.id} has no agent wallet bound and no incoming coin edge — nothing to guard.`,
        );
        continue;
      }
      if (minValue <= 0n) continue;
      const coinType = resolveGuardrailCoinType(node);
      injectMinOutAssert(tx, budgetCoin, coinType, minValue, warnings);
    }

    for (const node of orderedNodes) {
      const adapter = getAdapter(node.type);
      if (!adapter) {
        warnings.push(
          `Node type "${node.type}" is not supported by the current compiler version and was skipped.`,
        );
        continue;
      }
      await adapter.build({
        tx,
        flow: resolvedFlow,
        node,
        nodeOutputs,
        extraCoins,
        budgetCoin,
        options,
        warnings,
        fundSuiCoin,
      });
    }

    if (options.sender) {
      tx.setSender(options.sender);
    }

    // Settle sweep — the single owner of "produced but never consumed" coin cleanup (KTD-3). Every
    // adapter above only ever RECORDS a coin it produces (in `nodeOutputs` or `extraCoins`); nothing
    // upstream of this point calls mergeCoins/transferObjects on a produced coin. Whatever remains
    // in `nodeOutputs` was never claimed by a downstream node's edge lookup (a consumer always
    // `delete`s the entry it reads) — SUI merges back into gas, everything else transfers to sender.
    const pending: NodeOutput[] = [...Object.values(nodeOutputs), ...extraCoins];
    for (const output of pending) {
      this.settleCoin(tx, output, options);
    }

    return {
      transaction: tx,
      resolvedFlow,
      warnings,
      agentWalletBound: Boolean(options.agentWallet && rootTotal > 0n),
      budgetSpendMist: rootTotal,
    };
  }

  /**
   * U5/R8: the redesigned agent_wallet package's Rule + Hot Potato spend sequence — `request_spend`
   * -> one `prove` per manifest rule (in manifest order) -> `confirm_spend` — replacing the legacy
   * single `agent_wallet::spend()` call when `agentWallet.capabilityManifest` is set. Returns the
   * released `Coin<T>` (the SAME chainable shape `budgetCoin` always had, so `fundSuiCoin` and every
   * downstream adapter need no changes — the manifest gate is entirely local to this method).
   *
   * An invalid manifest throws `ValidationError` (422) BEFORE any command is emitted (R1: never emit
   * an unguarded spend) — `CapabilityManifestSchema` is re-validated here rather than trusted, since
   * `AgentWalletBinding.capabilityManifest` may be handed in from an untyped caller (e.g. a direct
   * `compileFlow` call bypassing the HTTP schema layer, same defense-in-depth reasoning as
   * `findFlowStructureIssues` above).
   *
   * `slippage_floor` is enforced PRE-FLIGHT, not on-chain (see `capability-manifest.ts`'s
   * `toOnChainRuleParams` doc comment) — it never projects a rule module here, so this method emits
   * no `prove` call and no shadow coin for it. Only the on-chain rule kinds (`budget`, `per_tx`,
   * `rate_limit`, `protocol_scope`, `asset_scope`, `recipient_allowlist`, `time_window`) reach the
   * loop below.
   */
  private buildManifestGatedSpend(
    tx: Transaction,
    agentWallet: AgentWalletBinding,
    amount: bigint,
    sender: string | undefined,
    extraCoins: NodeOutput[],
  ): unknown {
    const parsed = CapabilityManifestSchema.safeParse(agentWallet.capabilityManifest);
    if (!parsed.success) {
      throw new ValidationError(
        `Invalid capability manifest: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
      );
    }
    if (!agentWallet.versionId) {
      throw new ValidationError(
        'agentWallet.capabilityManifest requires agentWallet.versionId (the shared Version object id) '
          + 'to build the redesigned request_spend/confirm_spend/prove sequence.',
      );
    }
    if (!agentWallet.targetPackage) {
      throw new ValidationError(
        'agentWallet.capabilityManifest requires agentWallet.targetPackage (the protocol package this '
          + 'spend authorizes) — there is no honest default across arbitrary flow shapes.',
      );
    }
    const recipient = agentWallet.recipient ?? sender;
    if (!recipient) {
      throw new ValidationError(
        'agentWallet.capabilityManifest requires a recipient — set agentWallet.recipient, or pass `sender` '
          + 'so it can default to the flow owner.',
      );
    }

    const manifest = parsed.data;
    const { packageId, walletId, capId, versionId, targetPackage, coinType } = agentWallet;
    const typeArgs = [coinType];

    // request_spend's coin_in/coin_out are Move `TypeName` VALUES, not type arguments — constructed
    // on-chain via `std::type_name::get<T>()` (a zero-arg generic call usable as a PTB command whose
    // result feeds the next command). Simplification (documented, not silent): coin_out defaults to
    // the wallet's own coin type — this compiler's manifest-gated spend never commits to a declared
    // swap-out type at authorization time; `asset_scope`, the only rule that reads `coin_out`, checks
    // it against the SAME allowlist as `coin_in` as a result.
    const coinInTypeName = tx.moveCall({ target: '0x1::type_name::get', typeArguments: [coinType] });
    const coinOutTypeName = tx.moveCall({ target: '0x1::type_name::get', typeArguments: [coinType] });

    const req = tx.moveCall({
      target: `${packageId}::agent_wallet::request_spend`,
      typeArguments: typeArgs,
      arguments: [
        tx.object(walletId),
        tx.object(capId),
        tx.object(versionId),
        tx.pure.u64(amount),
        tx.pure.address(targetPackage),
        coinInTypeName,
        coinOutTypeName,
        tx.pure.address(recipient),
        tx.object(SUI_CLOCK_ID),
      ],
    });

    for (const rule of toOnChainRuleParams(manifest)) {
      const args: unknown[] = [req, tx.object(walletId), tx.object(versionId)];

      if (rule.module === 'rate_limit' || rule.module === 'time_window') {
        args.push(tx.object(SUI_CLOCK_ID));
      }

      tx.moveCall({
        target: `${packageId}::${rule.module}::prove`,
        typeArguments: typeArgs,
        arguments: args as never[],
      });
    }

    return tx.moveCall({
      target: `${packageId}::agent_wallet::confirm_spend`,
      typeArguments: typeArgs,
      arguments: [tx.object(walletId), req, tx.object(versionId), tx.object(SUI_CLOCK_ID)],
    });
  }

  /** SUI settles by merging into `tx.gas`; any other coin type settles by transferring to `sender`
   *  — the one place every produced-but-unconsumed coin (KTD-3) is cleaned up. */
  private settleCoin(tx: Transaction, output: NodeOutput, options: CompileOptions): void {
    if (output.coinType === SUI_COIN_TYPE) {
      tx.mergeCoins(tx.gas, [output.value as never]);
      return;
    }
    if (!options.sender) {
      throw new ValidationError(
        `Cannot settle a produced ${output.coinType} coin: no recipient — pass \`sender\` (the owner address) so it isn't lost.`,
      );
    }
    tx.transferObjects([output.value as never], options.sender);
  }

  /** Sum SUI (mist) needed from root by nodes without an upstream coin edge (delegated per adapter). */
  private computeRootSuiFunding(nodes: FlowNode[], flow: FlowGraph): bigint {
    let total = 0n;
    for (const node of nodes) {
      const adapter = getAdapter(node.type);
      if (adapter) total += adapter.rootSuiFunding(node, flow);
    }
    return total;
  }

  private topologicalSort(nodes: FlowNode[], edges: FlowEdge[]): FlowNode[] {
    const visited = new Set<string>();
    const temp = new Set<string>();
    const order: FlowNode[] = [];
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const adj = new Map<string, string[]>();

    for (const edge of edges) {
      if (!adj.has(edge.source)) adj.set(edge.source, []);
      adj.get(edge.source)!.push(edge.target);
    }

    const visit = (nodeId: string) => {
      if (temp.has(nodeId)) {
        throw new ValidationError('Cyclic dependency detected in flow wiring!');
      }
      if (!visited.has(nodeId)) {
        temp.add(nodeId);
        for (const neighbor of adj.get(nodeId) || []) {
          if (nodeMap.has(neighbor)) visit(neighbor);
        }
        temp.delete(nodeId);
        visited.add(nodeId);
        const node = nodeMap.get(nodeId);
        if (node) order.unshift(node);
      }
    };

    for (const node of nodes) {
      if (!visited.has(node.id)) visit(node.id);
    }

    return order;
  }
}

export const compilerService = new CompilerService();
