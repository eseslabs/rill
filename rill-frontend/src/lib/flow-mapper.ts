import type { Edge, Node } from "reactflow";
import type { ActionNodeData } from "@/components/flow/nodes";
import type { FlowEdge, FlowGraph, FlowNode } from "@/lib/rill-api";
import { buildCetusSwapFlowConfig, buildHaedalStakeFlowConfig } from "@/lib/action-config";

/** Protocol actions the live Rill backend can compile today. */
export function isBackendSupported(data: ActionNodeData): boolean {
  if (data.protocolId === "cetus" && data.action.toLowerCase().includes("swap")) return true;
  if (data.protocolId === "haedal" && data.action.toLowerCase().includes("stake")) return true;
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
      sourceHandle: edge.sourceHandle ?? "coin_out",
      target: edge.target,
      targetHandle: "sui_coin",
    };
  }

  if (targetData.protocolId === "cetus") {
    return {
      source: edge.source,
      sourceHandle: edge.sourceHandle ?? "coin_out",
      target: edge.target,
      targetHandle: "coin_inputs",
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

  return { nodes: flowNodes, edges: flowEdges, skipped };
}
