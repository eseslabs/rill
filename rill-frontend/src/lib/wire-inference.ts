import type { Connection, Edge, Node } from "reactflow";
import type { ActionNodeData } from "@/components/flow/nodes";

export const WIRE_IN = "in";
export const WIRE_OUT = "out";

export type WireKind = "coin" | "flow";

/** Draw-time connection verdict. `reason` is always set on rejection so the
 *  caller can surface *why*, not just refuse silently. */
export type WireValidation = { valid: boolean; reason: string | null };

const VALID: WireValidation = { valid: true, reason: null };
function invalid(reason: string): WireValidation {
  return { valid: false, reason };
}

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

/**
 * True if `edges` already contains a directed path from `to` back to `from` —
 * i.e. adding a `from -> to` connection would close a loop. Whole-graph, not
 * coin-only: the backend topologically sorts the full node graph, so any
 * cycle (coin or sequence-only) makes a flow uncompilable.
 */
export function wouldCreateCycle(from: string, to: string, edges: Edge[]): boolean {
  if (from === to) return true;
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    if (!e.source || !e.target) continue;
    const list = adjacency.get(e.source);
    if (list) list.push(e.target);
    else adjacency.set(e.source, [e.target]);
  }
  const stack = [to];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === from) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) stack.push(next);
  }
  return false;
}

/** Whole-graph cycle check (no proposed edge) — defensive re-check for gates
 *  that run against canvas state that wasn't necessarily built edge-by-edge
 *  through {@link isValidWireConnection} (e.g. a future restored draft). */
export function hasCycle(edges: Edge[]): boolean {
  const adjacency = new Map<string, string[]>();
  const allNodes = new Set<string>();
  for (const e of edges) {
    if (!e.source || !e.target) continue;
    allNodes.add(e.source);
    allNodes.add(e.target);
    const list = adjacency.get(e.source);
    if (list) list.push(e.target);
    else adjacency.set(e.source, [e.target]);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const n of allNodes) color.set(n, WHITE);

  const visit = (node: string): boolean => {
    color.set(node, GRAY);
    for (const next of adjacency.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) return true;
      if (c === WHITE && visit(next)) return true;
    }
    color.set(node, BLACK);
    return false;
  };

  for (const n of allNodes) {
    if (color.get(n) === WHITE && visit(n)) return true;
  }
  return false;
}

/**
 * Draw-time gate for a proposed connection. Always returns a reason on
 * rejection — ReactFlow's own `isValidConnection` prop only wants the
 * boolean, but the caller can re-run this (e.g. from `onConnectEnd`) to
 * surface *why* a dropped connection didn't attach.
 */
export function isValidWireConnection(
  connection: Connection,
  nodes: Node[],
  edges: Edge[],
): WireValidation {
  const { source, target, sourceHandle, targetHandle } = connection;
  if (!source || !target) return invalid("Connection is missing an endpoint.");
  if (source === target) return invalid("A node can't wire into itself.");

  const srcNode = nodes.find((n) => n.id === source);
  const tgtNode = nodes.find((n) => n.id === target);
  if (!srcNode || !tgtNode) return invalid("Unknown node in connection.");

  if (tgtNode.type === "trigger") return invalid("The trigger node has no input port.");
  if (srcNode.type === "output") return invalid("The output node has no output port.");

  const out = sourceHandle ?? WIRE_OUT;
  const inn = targetHandle ?? WIRE_IN;

  if (srcNode.type === "trigger" && out !== WIRE_OUT) {
    return invalid("Trigger only exposes a flow-out port.");
  }
  if (tgtNode.type === "output" && inn !== WIRE_IN) {
    return invalid("Output only exposes a flow-in port.");
  }

  // Guardrail is a coin sink, not a source into actions — Action → Guardrail is the
  // only direction the compiler understands (the guardrail asserts the incoming coin
  // and passes it through). Wired backward it used to drop silently and, per the
  // fixed compiler semantics, an action fed by a "guardrail source" has no coin to
  // spend at all.
  if (srcNode.type === "guardrail" && tgtNode.type === "action") {
    return invalid(
      "A guardrail can't feed an action — wire the action into the guardrail (Action → Guardrail), not the other way around.",
    );
  }

  if (wouldCreateCycle(source, target, edges)) {
    return invalid("That connection would create a cycle — flows must run in one direction.");
  }

  // Max one incoming coin edge per target handle. Only action targets are limited to
  // a single coin producer (they have exactly one coin input); a guardrail's target
  // handle is deliberately exempt — the compiler supports a multi-input guardrail
  // that asserts each incoming coin and merges them into one output.
  if (inferWireKindFromConnection(connection, nodes) === "coin" && tgtNode.type === "action") {
    const targetAlreadyFed = edges.some((e) => {
      if (e.target !== target) return false;
      if ((e.targetHandle ?? WIRE_IN) !== inn) return false;
      return wireKindFromEdge(e, nodes) === "coin";
    });
    if (targetAlreadyFed) {
      return invalid("This input already has an incoming coin — remove that wire before adding another.");
    }
  }

  return VALID;
}
