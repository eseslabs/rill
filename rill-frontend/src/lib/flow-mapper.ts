import type { Edge, Node } from "reactflow";
import type { ActionNodeData } from "@/components/flow/nodes";
import type { FlowEdge, FlowGraph, FlowNode } from "@/lib/rill-api";
import { buildCetusSwapFlowConfig, buildHaedalStakeFlowConfig, buildDeepbookOrderFlowConfig, TOKEN_COIN_TYPE } from "@/lib/action-config";

const SUI = TOKEN_COIN_TYPE.SUI;

function normalizeHandle(handle: string | null | undefined, fallback: string): string {
  if (!handle) return fallback;
  if (handle.startsWith("out:")) return handle.slice(4);
  if (handle.startsWith("in:")) return handle.slice(3);
  return handle;
}

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

function mapEdge(edge: Edge, nodes: Node[]): FlowEdge | null {
  const target = nodes.find((n) => n.id === edge.target);
  const source = nodes.find((n) => n.id === edge.source);
  if (!target || !source || target.type !== "action" || source.type !== "action") return null;

  const targetData = target.data as ActionNodeData;
  if (!isBackendSupported(targetData)) return null;

  if (targetData.protocolId === "haedal") {
    return {
      source: edge.source,
      sourceHandle: normalizeHandle(edge.sourceHandle, "coin_out"),
      target: edge.target,
      targetHandle: normalizeHandle(edge.targetHandle, "sui_coin"),
    };
  }

  if (targetData.protocolId === "cetus") {
    return {
      source: edge.source,
      sourceHandle: normalizeHandle(edge.sourceHandle, "coin_out"),
      target: edge.target,
      targetHandle: normalizeHandle(edge.targetHandle, "coin_inputs"),
    };
  }

  return null;
}

export function buildFlowGraph(nodes: Node[], edges: Edge[]): FlowGraph & { skipped: string[] } {
  const skipped: string[] = [];
  const flowNodes: FlowNode[] = [];

  for (const node of nodes) {
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

  return { nodes: flowNodes, edges: flowEdges, skipped };
}
