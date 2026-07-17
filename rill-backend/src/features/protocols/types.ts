import type { Transaction } from '@mysten/sui/transactions';
import type { AgentWalletBinding } from '../../core/agent-wallet';

/** A node in the visual flow graph (one protocol action). */
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
  resolvedFlow: FlowGraph;
  warnings: string[];
  agentWalletBound: boolean;
  budgetSpendMist: bigint;
}

/**
 * A node's chainable coin output: the raw PTB argument plus the Move coin type it carries, so
 * consumers (a downstream adapter, or the compiler's own settle sweep) know both what to pass into
 * a MoveCall/mergeCoins and how to classify it (SUI -> merge into gas; else -> transfer to sender).
 */
export interface NodeOutput {
  /** The coin argument (a `TransactionResult`/`NestedResult` reference) other nodes or the sweep consume. */
  value: unknown;
  /** Full Move coin type of `value`, e.g. `0x2::sui::SUI`. */
  coinType: string;
}

/**
 * Shared state passed to a protocol adapter while compiling one node into the PTB.
 * The adapter appends its Move calls to `tx`, reads/writes `nodeOutputs` for coin chaining,
 * and uses `fundSuiCoin` to source SUI (from the agent_wallet budget or tx.gas).
 */
export interface AdapterCtx {
  tx: Transaction;
  flow: FlowGraph;
  node: FlowNode;
  /**
   * Node id -> its chainable output coin. An adapter that consumes an upstream coin (by reading
   * `nodeOutputs[edge.source]`) MUST `delete` the entry once it has captured `.value` — that is how
   * the compiler's final settle sweep knows a coin was consumed vs. left dangling. Whatever remains
   * in this map after every node has built is produced-but-unconsumed and gets swept (KTD-3).
   */
  nodeOutputs: Record<string, NodeOutput>;
  /**
   * Coins a node produces that are never chainable to another node (e.g. Cetus's zero-value
   * opposite-side leftover from the A/B swap pattern). Adapters push here instead of settling
   * inline — the compiler's sweep is the single owner of all coin cleanup (KTD-3); no adapter calls
   * `mergeCoins`/`transferObjects` on a produced coin itself.
   */
  extraCoins: NodeOutput[];
  budgetCoin: unknown | undefined;
  options: CompileOptions;
  warnings: string[];
  /** Source a SUI coin of `amount` mist (from agent_wallet budget if bound, else tx.gas). */
  fundSuiCoin: (amount: bigint) => unknown;
}

/**
 * A protocol adapter. Add a new protocol = implement this + register it in `registry.ts`.
 * Adapters build PTBs directly (full control, composable, gate-able by agent_wallet) — they do
 * NOT use protocol SDKs to build/sign (SDKs may be used read-only elsewhere for discovery).
 */
export interface ProtocolAdapter {
  /** Flow node type this adapter handles, e.g. 'cetus_swap'. */
  nodeType: string;
  /** SUI (mist) this node must be funded from root when it has no upstream coin edge; 0n otherwise. */
  rootSuiFunding: (node: FlowNode, flow: FlowGraph) => bigint;
  /** Append this node's Move calls to `ctx.tx` (and record its output coin in `ctx.nodeOutputs`). */
  build: (ctx: AdapterCtx) => Promise<void>;
}
