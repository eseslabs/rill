import type { Connection, Edge, Node } from "reactflow";
import type { ActionNodeData } from "@/components/flow/nodes";

export const WIRE_IN = "in";
export const WIRE_OUT = "out";

export type WireKind = "coin" | "flow";

function actionMeta(node: Node | undefined) {
  if (!node || node.type !== "action") return null;
  const d = node.data as ActionNodeData;
  const action = d.action.toLowerCase();
  return {
    isSwap: d.protocolId === "cetus" && action.includes("swap"),
    isStake: d.protocolId === "haedal" && action.includes("stake"),
  };
}

/** Coin PTB chain vs canvas sequence — from node pair, not handle id. */
export function inferWireKind(source: Node | undefined, target: Node | undefined): WireKind {
  const src = actionMeta(source);
  const tgt = actionMeta(target);
  if (src?.isSwap && tgt?.isStake) return "coin";
  return "flow";
}

export function inferWireKindFromConnection(connection: Connection, nodes: Node[]): WireKind {
  return inferWireKind(
    nodes.find((n) => n.id === connection.source),
    nodes.find((n) => n.id === connection.target),
  );
}

export function wireKindFromEdge(edge: Edge, nodes: Node[]): WireKind {
  if (edge.data?.wireKind === "coin" || edge.data?.wireKind === "flow") {
    return edge.data.wireKind;
  }
  return inferWireKind(
    nodes.find((n) => n.id === edge.source),
    nodes.find((n) => n.id === edge.target),
  );
}

export function resolveBackendCoinHandles(
  source: Node,
  target: Node,
): { sourceHandle: string; targetHandle: string } | null {
  if (source.type !== "action" || target.type !== "action") return null;
  if (inferWireKind(source, target) !== "coin") return null;
  return { sourceHandle: "coin_out", targetHandle: "sui_coin" };
}

export function isValidWireConnection(connection: Connection, nodes: Node[]): boolean {
  const { source, target, sourceHandle, targetHandle } = connection;
  if (!source || !target || source === target) return false;

  const srcNode = nodes.find((n) => n.id === source);
  const tgtNode = nodes.find((n) => n.id === target);
  if (!srcNode || !tgtNode) return false;

  if (tgtNode.type === "trigger" || srcNode.type === "output") return false;

  const out = sourceHandle ?? WIRE_OUT;
  const inn = targetHandle ?? WIRE_IN;

  if (srcNode.type === "trigger" && out !== WIRE_OUT) return false;
  if (tgtNode.type === "output" && inn !== WIRE_IN) return false;

  return true;
}
