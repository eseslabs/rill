import type { Edge, Node } from "reactflow";
import type { ActionNodeData, GuardrailNodeData, PtbNodeData, WalletNodeData } from "@/components/flow/nodes";
import type { FlowEdge, FlowGraph, FlowNode } from "@/lib/rill-api";
import {
  buildCetusSwapFlowConfig,
  buildHaedalStakeFlowConfig,
  buildDeepbookOrderFlowConfig,
  TOKEN_COIN_TYPE,
  toMist,
} from "@/lib/action-config";
import { resolveBackendCoinHandles, wireKindFromEdge } from "@/lib/wire-inference";

const SUI = TOKEN_COIN_TYPE.SUI;

/** Swap wired into Haedal must output SUI; stake amount cannot exceed swap output. */
function applyWireConstraints(nodes: FlowNode[], edges: FlowEdge[]) {
  for (const edge of edges) {
    const src = nodes.find((n) => n.id === edge.source && n.type === "cetus_swap");
    const tgt = nodes.find((n) => n.id === edge.target && n.type === "haedal_stake");
    if (!src?.config || !tgt?.config) continue;

    if (src.config.outputCoinType !== SUI) {
      src.config.inputCoinType = TOKEN_COIN_TYPE.USDC;
      src.config.outputCoinType = SUI;
    }

    const swapOut = BigInt(String(src.config.amount_in ?? "0"));
    const stakeAmt = BigInt(String(tgt.config.amount ?? "0"));
    if (stakeAmt > swapOut) {
      tgt.config.amount = String(swapOut);
    }
  }
}

/** Protocol actions the live Rill backend can compile today. */
export function isBackendSupported(data: ActionNodeData): boolean {
  if (data.protocolId === "cetus" && data.action.toLowerCase().includes("swap")) return true;
  if (data.protocolId === "haedal" && data.action.toLowerCase().includes("stake")) return true;
  if (data.protocolId === "deepbook" && data.action.toLowerCase().includes("limit")) return true;
  return false;
}

function mapActionNode(id: string, data: ActionNodeData): FlowNode | null {
  const cfg = data.config ?? {};

  if (data.protocolId === "cetus" && data.action.toLowerCase().includes("swap")) {
    return { id, type: "cetus_swap", config: buildCetusSwapFlowConfig(cfg) };
  }
  if (data.protocolId === "haedal" && data.action.toLowerCase().includes("stake")) {
    return { id, type: "haedal_stake", config: buildHaedalStakeFlowConfig(cfg) };
  }
  if (data.protocolId === "deepbook" && data.action.toLowerCase().includes("limit")) {
    return { id, type: "deepbook_limit_order", config: buildDeepbookOrderFlowConfig(cfg) };
  }
  return null;
}

function mapPtbNode(id: string, _data: PtbNodeData): FlowNode {
  return { id, type: "ptb", config: {} };
}

function mapGuardrailNode(id: string, data: GuardrailNodeData): FlowNode {
  return {
    id,
    type: "guardrail",
    config: {
      minValue: toMist(String(data.minValue ?? "0"), "0"),
      coinType: data.coinType || SUI,
    },
  };
}

function mapWalletNode(_id: string, _data: WalletNodeData): FlowNode | null {
  // Wallet nodes are frontend-only configuration; their IDs are injected into wired actions.
  return null;
}

/** Merge BalanceManager + TradeCap from a wired Wallet node into an action config. */
function applyWalletIds(nodes: FlowNode[], edges: FlowEdge[], wallets: Record<string, WalletNodeData>) {
  for (const edge of edges) {
    if (!edge.source.startsWith("wallet_")) continue;
    const wallet = wallets[edge.source];
    if (!wallet) continue;
    const target = nodes.find((n) => n.id === edge.target);
    if (!target?.config) continue;
    if (wallet.balanceManagerId) target.config.balanceManagerId = wallet.balanceManagerId;
    if (wallet.tradeCapId) target.config.tradeCapId = wallet.tradeCapId;
  }
}

function mapEdge(edge: Edge, nodes: Node[]): FlowEdge | null {
  const target = nodes.find((n) => n.id === edge.target);
  const source = nodes.find((n) => n.id === edge.source);
  if (!target || !source) return null;

  // Guardrail wired to an action's coin output (e.g., Cetus swap → guardrail).
  if (target.type === "guardrail" && source.type === "action") {
    const sourceData = source.data as ActionNodeData;
    if (!isBackendSupported(sourceData)) return null;
    return {
      source: edge.source,
      sourceHandle: "coin_out",
      target: edge.target,
      targetHandle: "in",
    };
  }

  if (source.type === "wallet" || target.type === "wallet") return null;
  if (target.type !== "action" || source.type !== "action") return null;

  const targetData = target.data as ActionNodeData;
  if (!isBackendSupported(targetData)) return null;
  if (wireKindFromEdge(edge, nodes) !== "coin") return null;

  const handles = resolveBackendCoinHandles(source, target);
  if (!handles) return null;

  return {
    source: edge.source,
    sourceHandle: handles.sourceHandle,
    target: edge.target,
    targetHandle: handles.targetHandle,
  };
}

export function buildFlowGraph(nodes: Node[], edges: Edge[]): FlowGraph & { skipped: string[] } {
  const skipped: string[] = [];
  const flowNodes: FlowNode[] = [];
  const wallets: Record<string, WalletNodeData> = {};

  for (const node of nodes) {
    if (node.type === "ptb") {
      flowNodes.push(mapPtbNode(node.id, node.data as PtbNodeData));
      continue;
    }
    if (node.type === "guardrail") {
      flowNodes.push(mapGuardrailNode(node.id, node.data as GuardrailNodeData));
      continue;
    }
    if (node.type === "wallet") {
      wallets[node.id] = node.data as WalletNodeData;
      continue;
    }
    if (node.type !== "action") continue;
    const data = node.data as ActionNodeData;
    const mapped = mapActionNode(node.id, data);
    if (mapped) {
      flowNodes.push(mapped);
    } else {
      skipped.push(`${data.protocol} · ${data.action}`);
    }
  }

  const flowEdges = edges
    .map((e) => mapEdge(e, nodes))
    .filter((e): e is FlowEdge => e !== null);

  applyWireConstraints(flowNodes, flowEdges);
  applyWalletIds(flowNodes, edges, wallets);

  return { nodes: flowNodes, edges: flowEdges, skipped };
}
