import { Transaction } from '@mysten/sui/transactions';
import { SUI_COIN_TYPE } from '../../core/agent-wallet';
import { SUI_CLOCK_ID } from '../../core/protocols';
import { getAdapter } from '../protocols/registry';
import type {
  CompileOptions,
  CompileResult,
  FlowEdge,
  FlowGraph,
  FlowNode,
} from '../protocols/types';

// Re-exported so existing importers (`from '../compiler/compiler.service'`) keep working.
export type { FlowEdge, FlowGraph, FlowNode, CompileOptions, CompileResult };

/**
 * Compiles a visual flow graph into one unsigned PTB.
 *
 * Orchestration only — each node's Move calls live in its `ProtocolAdapter` (`features/protocols/*`).
 * Funding flows through one chokepoint: `agent_wallet::spend()` (when an agent wallet is bound) or
 * `tx.gas`, then `fundSuiCoin` hands SUI to whichever node needs it.
 */
export class CompilerService {
  async compileFlow(flow: FlowGraph, options: CompileOptions = {}): Promise<CompileResult> {
    const tx = new Transaction();
    const warnings: string[] = [];
    const orderedNodes = this.topologicalSort(flow.nodes, flow.edges);
    const nodeOutputs: Record<string, unknown> = {};

    const rootTotal = this.computeRootSuiFunding(orderedNodes, flow);
    let budgetCoin: unknown | undefined;

    if (options.agentWallet && rootTotal > 0n) {
      if (options.agentWallet.coinType !== SUI_COIN_TYPE) {
        throw new Error(
          `Agent wallet coin type ${options.agentWallet.coinType} is not supported for MVP (expected ${SUI_COIN_TYPE}).`,
        );
      }

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

    for (const node of orderedNodes) {
      const adapter = getAdapter(node.type);
      if (!adapter) {
        warnings.push(
          `Node type "${node.type}" is not supported by the current compiler version and was skipped.`,
        );
        continue;
      }
      await adapter.build({ tx, flow, node, nodeOutputs, budgetCoin, options, warnings, fundSuiCoin });
    }

    // The agent_wallet::spend() output is a Coin; after nodes split what they need, the remainder
    // (≈0) must be consumed or the PTB aborts on execute (UnusedValueWithoutDrop). Merge it to gas.
    if (budgetCoin !== undefined) {
      tx.mergeCoins(tx.gas, [budgetCoin as never]);
    }

    if (options.sender) {
      tx.setSender(options.sender);
    }

    return {
      transaction: tx,
      warnings,
      agentWalletBound: Boolean(options.agentWallet && rootTotal > 0n),
      budgetSpendMist: rootTotal,
    };
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
        throw new Error('Cyclic dependency detected in flow wiring!');
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
