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
  warnings: string[];
  agentWalletBound: boolean;
  budgetSpendMist: bigint;
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
  nodeOutputs: Record<string, unknown>;
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
