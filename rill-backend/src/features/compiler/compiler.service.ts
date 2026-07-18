import { Transaction } from '@mysten/sui/transactions';
import { normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';
import type { AgentWalletBinding } from '../../core/agent-wallet';
import { SUI_COIN_TYPE } from '../../core/agent-wallet';
import { config } from '../../core/config';
import { ValidationError } from '../../core/errors';
import { parseConfigU64, resolveCetusSwapConfig, resolveEffectiveFlow } from '../../core/node-config';
import { SUI_CLOCK_ID } from '../../core/protocols';
import { getAdapter } from '../protocols/registry';
import { findFlowStructureIssues } from '../protocols/handles';
import { injectMinOutAssert, resolveGuardrailCoinType, resolveGuardrailMinValue } from '../protocols/guard';
import {
  CapabilityManifestSchema,
  toOnChainRuleParams,
  toSignerPolicy,
  type CapabilityManifest,
} from '../../../../packages/rill-sdk/src/capability-manifest';
import { parseU64String } from '../../../../packages/rill-sdk/src/amounts';
import { inspectTransaction } from './ptb.util';
import { pickSwapFunction, resolvePoolTypeArgs } from './pool-resolver';
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
 * Funding flows through one chokepoint: the manifest-gated agent_wallet `request_spend` -> prove x N
 * -> `confirm_spend` sequence (when an agent wallet is bound — see `buildManifestGatedSpend`) or
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

      // There is now ONE agent_wallet package: every bound wallet funds through the redesigned Rule +
      // Hot Potato sequence (`buildManifestGatedSpend` — `request_spend` -> one `prove` per manifest
      // rule -> `confirm_spend`). A binding with no `capabilityManifest` is not a legacy fallback
      // (that call/package no longer exists) — `buildManifestGatedSpend` itself fails closed with a
      // `ValidationError` before any command is emitted (see `parseManifestOrThrow`).
      budgetCoin = this.buildManifestGatedSpend(tx, options.agentWallet, rootTotal, extraCoins);
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

    // Review C2's actual fix: `protocol_scope`/`asset_scope`/`recipient_allowlist`/`slippage_floor`
    // have no on-chain `prove` projection (see `toOnChainRuleParams`'s doc comment) — an on-chain
    // rule could only ever compare against a single self-declared PTB metadata value, which is
    // decorative, not a real guarantee. This cross-checks the manifest against the REAL compiled
    // PTB/resolved flow instead, fail-closed, once every adapter (and the settle sweep) has already
    // run so there is nothing left it could miss.
    if (options.agentWallet?.capabilityManifest) {
      const manifest = this.parseManifestOrThrow(options.agentWallet.capabilityManifest);
      await this.enforceManifestPreflight(tx, resolvedFlow, manifest, options.agentWallet, options.sender, warnings);
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
   * Re-validates a possibly-untyped `capabilityManifest` (defense-in-depth: `AgentWalletBinding
   * .capabilityManifest` may be handed in from an untyped caller, e.g. a direct `compileFlow` call
   * bypassing the HTTP schema layer, same reasoning as `findFlowStructureIssues` above) into a typed
   * `CapabilityManifest`, throwing `ValidationError` (422) rather than trusting the shape. Shared by
   * `buildManifestGatedSpend` and `enforceManifestPreflight` so both re-validate identically — the
   * latter needs its own copy because `buildManifestGatedSpend` is skipped entirely (and so never
   * validates anything) when `rootTotal === 0n` (no root SUI funding required).
   */
  private parseManifestOrThrow(raw: unknown): CapabilityManifest {
    const parsed = CapabilityManifestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError(
        `Invalid capability manifest: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
      );
    }
    return parsed.data;
  }

  /**
   * U5/R8: the redesigned agent_wallet package's Rule + Hot Potato spend sequence — `request_spend`
   * -> one `prove` per manifest rule (in manifest order) -> `confirm_spend` — replacing the legacy
   * single `agent_wallet::spend()` call when `agentWallet.capabilityManifest` is set. Returns the
   * released `Coin<T>` (the SAME chainable shape `budgetCoin` always had, so `fundSuiCoin` and every
   * downstream adapter need no changes — the manifest gate is entirely local to this method).
   *
   * An invalid manifest throws `ValidationError` (422) BEFORE any command is emitted (R1: never emit
   * an unguarded spend) — see `parseManifestOrThrow`.
   *
   * `request_spend<T>(wallet, cap, version, amount, clock, ctx)` no longer takes `target_package`/
   * `coin_in`/`coin_out`/`recipient` — those were self-declared PTB metadata an on-chain rule could
   * only ever compare against itself (review C2, decorative, not a real guarantee). `protocol_scope`,
   * `asset_scope`, `recipient_allowlist`, and `slippage_floor` are enforced PRE-FLIGHT instead (see
   * `capability-manifest.ts`'s `toOnChainRuleParams` doc comment and `enforceManifestPreflight`
   * below) — none of the four project an on-chain rule module, so this method emits no `prove` call
   * and no shadow coin for any of them. Only `budget`, `per_tx`, `rate_limit`, and `time_window`
   * reach the loop below.
   */
  private buildManifestGatedSpend(
    tx: Transaction,
    agentWallet: AgentWalletBinding,
    amount: bigint,
    extraCoins: NodeOutput[],
  ): unknown {
    const manifest = this.parseManifestOrThrow(agentWallet.capabilityManifest);
    if (!agentWallet.versionId) {
      throw new ValidationError(
        'agentWallet.capabilityManifest requires agentWallet.versionId (the shared Version object id) '
          + 'to build the redesigned request_spend/confirm_spend/prove sequence.',
      );
    }

    const { packageId, walletId, capId, versionId, coinType } = agentWallet;
    const typeArgs = [coinType];

    const req = tx.moveCall({
      target: `${packageId}::agent_wallet::request_spend`,
      typeArguments: typeArgs,
      arguments: [
        tx.object(walletId),
        tx.object(capId),
        tx.object(versionId),
        tx.pure.u64(amount),
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

  /**
   * Review C2's real fix: `protocol_scope`, `recipient_allowlist`, `asset_scope`, and
   * `slippage_floor` have no on-chain `prove` projection (`toOnChainRuleParams` skips all four) —
   * an on-chain rule could only ever compare against a single self-declared PTB metadata value,
   * which a misbehaving/compromised compiler could lie about, so it was decorative rather than a
   * real guarantee. The trusted compiler enforces them for real instead, here, by cross-checking the
   * manifest against facts it cannot lie to itself about: the REAL compiled PTB's Move-call targets
   * (`protocol_scope`), the settle sweep's actual behavior (`recipient_allowlist`), the resolved
   * flow's node configs (`asset_scope`, `slippage_floor`).
   *
   * Called once, after every adapter AND the settle sweep have already run (`compileFlow`) — so
   * nothing downstream of this point could still violate a rule this method already cleared. Each
   * rule is independent: a manifest may attach any subset of the four, checked in no particular
   * order, and every check fails closed (`ValidationError` -> 422) the moment it finds a violation.
   */
  private async enforceManifestPreflight(
    tx: Transaction,
    resolvedFlow: FlowGraph,
    manifest: CapabilityManifest,
    agentWallet: AgentWalletBinding,
    sender: string | undefined,
    warnings: string[],
  ): Promise<void> {
    const policy = toSignerPolicy(manifest);

    if (policy.allowedPackages) {
      this.checkProtocolScope(tx, policy.allowedPackages, agentWallet);
    }
    if (policy.allowedRecipients) {
      this.checkRecipientAllowlist(policy.allowedRecipients, sender);
    }
    if (policy.allowedCoinTypes) {
      await this.checkAssetScope(policy.allowedCoinTypes, resolvedFlow, agentWallet);
    }
    if (policy.minSlippageOutMist) {
      this.checkSlippageFloor(policy.minSlippageOutMist, resolvedFlow, warnings);
    }
  }

  /**
   * `protocol_scope` pre-flight: every non-system package the compiled PTB actually calls must be in
   * the manifest's `allowedPackages` — derived from `inspectTransaction(tx)`, the real compiled
   * command list (not a self-declared value a rogue node config could spoof). `agent_wallet` (this
   * spend's own chokepoint), `rill_guard` (the slippage-floor chokepoint), and the Sui framework
   * packages (`0x1`/`0x2`/`0x3`, e.g. `coin::zero`/`type_name`) are excluded — they're Rill's own
   * trusted infrastructure, not a "protocol" an owner is scoping the agent to.
   */
  private checkProtocolScope(
    tx: Transaction,
    allowedPackages: readonly string[],
    agentWallet: AgentWalletBinding,
  ): void {
    const allowed = new Set(allowedPackages.map((pkg) => normalizeSuiAddress(pkg)));
    const systemPackages = new Set(
      [agentWallet.packageId, config.guardPackageId, '0x1', '0x2', '0x3']
        .filter((pkg): pkg is string => Boolean(pkg))
        .map((pkg) => normalizeSuiAddress(pkg)),
    );

    const { allowedTargets } = inspectTransaction(tx);
    const violations = new Set<string>();
    for (const target of allowedTargets) {
      const packageId = target.split('::')[0];
      if (systemPackages.has(packageId) || allowed.has(packageId)) continue;
      violations.add(packageId);
    }

    if (violations.size > 0) {
      throw new ValidationError(
        `protocol_scope violation: this flow calls package(s) not in the manifest's allowedPackages `
          + `(${allowedPackages.join(', ')}): ${[...violations].join(', ')}.`,
      );
    }
  }

  /**
   * `recipient_allowlist` pre-flight: the settle sweep (`settleCoin`, above) always routes a
   * compiled flow's proceeds to `sender` — a non-SUI coin transfers there directly, SUI merges into
   * `tx.gas` which `sender` also owns as the transaction signer — so `sender` IS the effective
   * recipient of every compiled flow. Without a `sender` there is nothing to verify against, so this
   * fails closed rather than silently skipping the check.
   */
  private checkRecipientAllowlist(allowedRecipients: readonly string[], sender: string | undefined): void {
    if (!sender) {
      throw new ValidationError(
        'recipient_allowlist violation: cannot verify the effective recipient — `sender` is required '
          + 'when a recipient_allowlist rule is attached to the manifest.',
      );
    }
    const allowed = new Set(allowedRecipients.map((address) => normalizeSuiAddress(address)));
    const effectiveRecipient = normalizeSuiAddress(sender);
    if (!allowed.has(effectiveRecipient)) {
      throw new ValidationError(
        `recipient_allowlist violation: effective recipient ${effectiveRecipient} (sender) is not in `
          + `the manifest's allowedRecipients (${allowedRecipients.join(', ')}).`,
      );
    }
  }

  /**
   * `asset_scope` pre-flight: every coin type the flow moves — the budget coin (`agentWallet
   * .coinType`) plus each Cetus swap's declared `inputCoinType` and its REAL resolved output — must
   * be in the manifest's `allowedCoinTypes`. A Cetus pool's output side is picked at compile time
   * from the pool's own two coin types (`pool-resolver.ts`'s `pickSwapFunction`), not a config field
   * — re-derived here the exact same way `cetus.adapter.ts` derives it, so this can never diverge
   * from what the adapter actually built into the PTB.
   */
  private async checkAssetScope(
    allowedCoinTypes: readonly string[],
    resolvedFlow: FlowGraph,
    agentWallet: AgentWalletBinding,
  ): Promise<void> {
    const allowed = new Set(allowedCoinTypes.map((coinType) => normalizeStructTag(coinType)));
    const moved = new Map<string, string>(); // normalized coin type -> original, for an honest error
    const record = (coinType: string) => moved.set(normalizeStructTag(coinType), coinType);

    record(agentWallet.coinType);

    for (const node of resolvedFlow.nodes) {
      if (node.type !== 'cetus_swap') continue;
      const { config: swapCfg } = resolveCetusSwapConfig(node);
      record(swapCfg.inputCoinType);
      const poolTypes = await resolvePoolTypeArgs(swapCfg.pool);
      const swap = pickSwapFunction(swapCfg.inputCoinType, poolTypes, swapCfg.minSqrtPrice, swapCfg.maxSqrtPrice);
      record(swap.outputCoinType);
    }

    const violations = [...moved.entries()]
      .filter(([normalized]) => !allowed.has(normalized))
      .map(([, original]) => original);

    if (violations.length > 0) {
      throw new ValidationError(
        `asset_scope violation: this flow moves coin type(s) not in the manifest's allowedCoinTypes `
          + `(${allowedCoinTypes.join(', ')}): ${violations.join(', ')}.`,
      );
    }
  }

  /**
   * `slippage_floor` pre-flight: every swap node that declares its own `min_amount_out` must set it
   * at/above the manifest's floor. A swap that relies on a downstream guardrail instead (see
   * `cetus.adapter.ts`'s `feedsGuardrail`) has no declared value here to check and is skipped — same
   * as a flow with no swap node at all, which is vacuously satisfied (warned, not an error, since an
   * attached-but-inapplicable rule isn't a violation).
   */
  private checkSlippageFloor(minSlippageOutMist: string, resolvedFlow: FlowGraph, warnings: string[]): void {
    const floor = parseU64String(minSlippageOutMist, 'manifest.slippage_floor.minOutMist');
    const swapNodes = resolvedFlow.nodes.filter((node) => node.type === 'cetus_swap');
    if (swapNodes.length === 0) {
      warnings.push('slippage_floor rule attached but the flow has no swap node — vacuously satisfied.');
      return;
    }

    const violations: string[] = [];
    for (const node of swapNodes) {
      const { config: swapCfg } = resolveCetusSwapConfig(node);
      if (!swapCfg.min_amount_out) continue;
      const minOut = parseConfigU64(swapCfg.min_amount_out, `Node ${node.id}: config.min_amount_out`);
      if (minOut < floor) {
        violations.push(`${node.id} (min_amount_out=${minOut})`);
      }
    }

    if (violations.length > 0) {
      throw new ValidationError(
        `slippage_floor violation: swap node(s) below the manifest floor of ${floor}: ${violations.join(', ')}.`,
      );
    }
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
