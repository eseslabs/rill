import { Transaction } from '@mysten/sui/transactions';
import type { AgentWalletBinding } from '../../core/agent-wallet';
import { SUI_COIN_TYPE } from '../../core/agent-wallet';
import { DEFAULT_SIMULATE_SENDER, SUI_CLOCK_ID } from '../../core/protocols';
import { resolveCetusSwapConfig, resolveHaedalStakeConfig } from '../../core/node-config';
import { pickSwapFunction, resolvePoolTypeArgs } from './pool-resolver';

export interface FlowNode {
  id: string;
  type: string;
  config?: Record<string, any>;
  inputs?: Record<string, any>;
}

export interface FlowEdge {
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface CompileOptions {
  sender?: string;
  /** When set, root SUI funding uses agent_wallet::spend() instead of tx.gas. */
  agentWallet?: AgentWalletBinding;
}

export interface CompileResult {
  transaction: Transaction;
  warnings: string[];
  agentWalletBound: boolean;
  budgetSpendMist: bigint;
}

export class CompilerService {
  async compileFlow(flow: FlowGraph, options: CompileOptions = {}): Promise<CompileResult> {
    const tx = new Transaction();
    const warnings: string[] = [];
    const orderedNodes = this.topologicalSort(flow.nodes, flow.edges);
    const nodeOutputs: Record<string, unknown> = {};

    const rootFunding = this.computeRootSuiFunding(orderedNodes, flow.edges);
    let budgetCoin: unknown | undefined;

    if (options.agentWallet && rootFunding.total > 0n) {
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
          tx.pure.u64(rootFunding.total),
          tx.object(SUI_CLOCK_ID),
        ],
      });
    } else if (options.agentWallet && rootFunding.total === 0n) {
      warnings.push('Agent wallet configured but no root SUI funding required — spend() not inserted.');
    }

    for (const node of orderedNodes) {
      if (node.type === 'cetus_swap') {
        const { config: swapCfg, warnings: cfgWarnings } = resolveCetusSwapConfig(node);
        warnings.push(...cfgWarnings);

        const amountIn = BigInt(swapCfg.amount_in);
        const poolId = swapCfg.pool;
        const inputCoinType = swapCfg.inputCoinType;

        const poolTypes = await resolvePoolTypeArgs(poolId);
        const swap = pickSwapFunction(inputCoinType, poolTypes, swapCfg.minSqrtPrice, swapCfg.maxSqrtPrice);
        const hasDownstream = flow.edges.some((e) => e.source === node.id);

        const coinInputEdge = flow.edges.find(
          (e) => e.target === node.id && e.targetHandle === 'coin_inputs',
        );
        let coinInputArg;

        if (coinInputEdge) {
          coinInputArg = nodeOutputs[coinInputEdge.source];
          if (coinInputArg === undefined) {
            throw new Error(
              `Node ${node.id}: upstream coin from ${coinInputEdge.source} is missing — ensure swap uses router::swap (wire coin_out → sui_coin).`,
            );
          }
        } else if (inputCoinType !== SUI_COIN_TYPE) {
          throw new Error(
            `Node ${node.id}: non-SUI input (${inputCoinType}) requires an upstream coin edge. Use Token in = SUI for standalone swap.`,
          );
        } else {
          coinInputArg = this.fundSuiCoin(tx, amountIn, budgetCoin, options.agentWallet);
        }

        const feedsHaedal = flow.edges.some(
          (e) =>
            e.source === node.id &&
            flow.nodes.some((n) => n.id === e.target && n.type === 'haedal_stake'),
        );
        if (feedsHaedal && swap.outputCoinType !== SUI_COIN_TYPE) {
          throw new Error(
            `Node ${node.id}: swap wired to Haedal stake must output SUI (set Token out = SUI / Token in = USDC).`,
          );
        }

        const zeroA = tx.moveCall({
          target: '0x2::coin::zero',
          typeArguments: [poolTypes.coinTypeA],
          arguments: [],
        });
        const zeroB = tx.moveCall({
          target: '0x2::coin::zero',
          typeArguments: [poolTypes.coinTypeB],
          arguments: [],
        });

        const [coinAIn, coinBIn] = swap.a2b ? [coinInputArg, zeroB] : [zeroA, coinInputArg];

        const [outA, outB] = tx.moveCall({
          target: `${swapCfg.integratePackageId}::router::swap`,
          typeArguments: swap.typeArguments,
          arguments: [
            tx.object(swapCfg.globalConfigId),
            tx.object(poolId),
            coinAIn,
            coinBIn,
            tx.pure.bool(swap.a2b),
            tx.pure.bool(swapCfg.by_amount_in ?? true),
            tx.pure.u64(amountIn),
            tx.pure.u128(BigInt(swapCfg.sqrt_price_limit ?? swap.sqrtPriceLimit)),
            tx.pure.bool(false),
            tx.object(SUI_CLOCK_ID),
          ],
        });

        const outputCoin = swap.a2b ? outB : outA;
        nodeOutputs[node.id] = outputCoin;

        if (!hasDownstream) {
          if (swap.outputCoinType === SUI_COIN_TYPE) {
            tx.mergeCoins(tx.gas, [outputCoin]);
          } else {
            const recipient = options.sender ?? DEFAULT_SIMULATE_SENDER;
            tx.transferObjects([outputCoin], recipient);
          }
        }
      } else if (node.type === 'haedal_stake') {
        const { config: stakeCfg, warnings: cfgWarnings } = resolveHaedalStakeConfig(node);
        warnings.push(...cfgWarnings);

        const amount = BigInt(stakeCfg.amount);
        const minStake = BigInt(stakeCfg.minStakeMist);

        if (amount < minStake) {
          throw new Error(
            `Haedal minimum stake is ${minStake} mist. Got ${amount}.`,
          );
        }

        const coinInputEdge = flow.edges.find(
          (e) => e.target === node.id && e.targetHandle === 'sui_coin',
        );
        let coinInputArg;

        if (coinInputEdge) {
          coinInputArg = nodeOutputs[coinInputEdge.source];
          if (coinInputArg === undefined) {
            throw new Error(
              `Node ${node.id}: missing SUI coin from ${coinInputEdge.source} — wire swap coin_out → sui_coin.`,
            );
          }
        } else {
          coinInputArg = this.fundSuiCoin(tx, amount, budgetCoin, options.agentWallet);
        }

        tx.moveCall({
          target: stakeCfg.stakeTarget,
          typeArguments: [],
          arguments: [
            tx.object(stakeCfg.suiSystemStateId),
            tx.object(stakeCfg.stakingObjectId),
            coinInputArg,
            tx.pure.address(stakeCfg.validator ?? '0x0'),
          ],
        });
      } else {
        warnings.push(
          `Node type "${node.type}" is not supported by the current compiler version and was skipped.`,
        );
      }
    }

    if (options.sender) {
      tx.setSender(options.sender);
    }

    return {
      transaction: tx,
      warnings,
      agentWalletBound: Boolean(options.agentWallet && rootFunding.total > 0n),
      budgetSpendMist: rootFunding.total,
    };
  }

  /** Sum SUI needed by nodes without an upstream coin edge. */
  private computeRootSuiFunding(
    nodes: FlowNode[],
    edges: FlowEdge[],
  ): { total: bigint; byNode: Map<string, bigint> } {
    const byNode = new Map<string, bigint>();
    let total = 0n;

    for (const node of nodes) {
      const hasCoinEdge =
        node.type === 'cetus_swap'
          ? edges.some((e) => e.target === node.id && e.targetHandle === 'coin_inputs')
          : node.type === 'haedal_stake'
            ? edges.some((e) => e.target === node.id && e.targetHandle === 'sui_coin')
            : false;

      if (hasCoinEdge) continue;

      let amount = 0n;
      if (node.type === 'cetus_swap') {
        const { config: swapCfg } = resolveCetusSwapConfig(node);
        if (swapCfg.inputCoinType !== SUI_COIN_TYPE) continue;
        amount = BigInt(swapCfg.amount_in);
      } else if (node.type === 'haedal_stake') {
        const { config: stakeCfg } = resolveHaedalStakeConfig(node);
        amount = BigInt(stakeCfg.amount);
      }

      if (amount > 0n) {
        byNode.set(node.id, amount);
        total += amount;
      }
    }

    return { total, byNode };
  }

  private fundSuiCoin(
    tx: Transaction,
    amount: bigint,
    budgetCoin: unknown | undefined,
    agentWallet?: AgentWalletBinding,
  ): unknown {
    if (agentWallet && budgetCoin !== undefined) {
      const [split] = tx.splitCoins(budgetCoin, [amount]);
      return split;
    }

    const [splitCoin] = tx.splitCoins(tx.gas, [amount]);
    return splitCoin;
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
