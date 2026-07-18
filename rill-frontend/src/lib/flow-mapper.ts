import type { Edge, Node } from "reactflow";
import type { ActionNodeData, GuardrailNodeData, PtbNodeData } from "@/components/flow/nodes";
import type { FlowEdge, FlowGraph, FlowNode } from "@/lib/rill-api";
import {
  buildCetusSwapFlowConfig,
  buildHaedalStakeFlowConfig,
  buildDeepbookOrderFlowConfig,
  otherSwapToken,
  TOKEN_COIN_TYPE,
  toMist,
  type SwapTokenSymbol,
} from "@/lib/action-config";
import {
  resolveBackendCoinHandles,
  wireKindFromEdge,
  WIRE_IN,
  WIRE_OUT,
} from "@/lib/wire-inference";

const SUI = TOKEN_COIN_TYPE.SUI;

/** Human-readable label for a canvas node — used in skipped-node/edge reporting so
 *  the user sees "Cetus · Swap", never a raw id like "n_3". */
function nodeLabel(node: Node): string {
  if (node.type === "action") {
    const d = node.data as ActionNodeData;
    return `${d.protocol} · ${d.action}`;
  }
  if (node.type === "guardrail") return "Guardrail";
  if (node.type === "ptb") return "PTB";
  if (node.type === "trigger") return "Trigger";
  if (node.type === "output") return "Output";
  return node.id;
}

export type WireConstraintChange = {
  nodeId: string;
  field: string;
  from: string;
  to: string;
  reason: string;
};

/**
 * Swap wired into Haedal must output SUI (Haedal only ever accepts SUI as its stake coin).
 *
 * Pure — computes what SHOULD change on canvas-shaped node data and returns the
 * change list; mutates nothing. `buildFlowGraph` applies the list to its own
 * internal (compiled) copy so compiled output still reflects the constraint, and
 * also returns the list so the component layer can apply it to real canvas state
 * and explain the change instead of silently rewriting values at compile time.
 *
 * Part B: this used to also cap the stake amount to the swap's output amount (both were
 * canvas-editable `cfg.amount` fields). Neither is user-editable anymore — action nodes no longer
 * expose an Amount input (the agent supplies the real amount at runtime via MCP, bounded by
 * capabilities), and `buildCetusSwapFlowConfig`/`buildHaedalStakeFlowConfig` both compile a fixed
 * studio-preview amount regardless of `cfg.amount` — so there is nothing left to cap here. Only
 * the token-pair correction (still driven by the canvas-editable Token in/out selects) remains.
 */
export function applyWireConstraints(nodes: Node[], edges: Edge[]): WireConstraintChange[] {
  const changes: WireConstraintChange[] = [];

  for (const edge of edges) {
    const src = nodes.find((n) => n.id === edge.source);
    const tgt = nodes.find((n) => n.id === edge.target);
    if (!src || !tgt || src.type !== "action" || tgt.type !== "action") continue;

    const srcData = src.data as ActionNodeData;
    const tgtData = tgt.data as ActionNodeData;
    const isSwap = srcData.protocolId === "cetus" && srcData.action.toLowerCase().includes("swap");
    const isStake =
      tgtData.protocolId === "haedal" && tgtData.action.toLowerCase().includes("stake");
    if (!isSwap || !isStake) continue;

    const srcCfg = srcData.config ?? {};

    const tokenIn = (srcCfg.tokenIn as SwapTokenSymbol) || "SUI";
    const derivedOutput = TOKEN_COIN_TYPE[otherSwapToken(tokenIn)];
    if (derivedOutput !== SUI) {
      const reason = `${nodeLabel(src)} feeds a Haedal stake, which only accepts SUI — token pair switched so the swap outputs SUI.`;
      changes.push({ nodeId: src.id, field: "tokenIn", from: tokenIn, to: "USDC", reason });
      changes.push({
        nodeId: src.id,
        field: "tokenOut",
        from: String(srcCfg.tokenOut ?? "USDC"),
        to: "SUI",
        reason,
      });
    }
  }

  return changes;
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

export type SkippedEdge = { source: string; target: string; reason: string };

type EdgeMapResult = { edge: FlowEdge; skip?: undefined } | { edge?: undefined; skip: SkippedEdge };

/** Maps one canvas edge to a backend FlowEdge, or explains why it was dropped.
 *  Every rejection path returns a human-readable {@link SkippedEdge} instead of
 *  a bare `null` — R17: skipped edges are reported, never silently discarded. */
function mapEdge(edge: Edge, nodes: Node[]): EdgeMapResult | null {
  const target = nodes.find((n) => n.id === edge.target);
  const source = nodes.find((n) => n.id === edge.source);
  if (!target || !source) return null; // dangling edge — endpoint no longer exists

  // Canvas-only sequencing affordances (trigger/output/ptb) aren't part of the
  // backend graph yet (the PTB node isn't a real transaction boundary — deferred);
  // wiring to/from them is expected and reports nothing, same as before.
  const backendRelevant = (n: Node) => n.type === "action" || n.type === "guardrail";
  if (!backendRelevant(source) || !backendRelevant(target)) return null;

  const skip = (reason: string): EdgeMapResult => ({
    skip: { source: nodeLabel(source), target: nodeLabel(target), reason },
  });

  const out = edge.sourceHandle ?? WIRE_OUT;
  const inn = edge.targetHandle ?? WIRE_IN;
  if (out !== WIRE_OUT || inn !== WIRE_IN) {
    return skip(
      `Unrecognized connection point (${out} → ${inn}) — only the single in/out port on each node reaches the backend.`,
    );
  }

  // Action → Guardrail: the only supported guardrail direction (guardrail is a
  // pass-through coin sink that asserts then forwards its input).
  if (source.type === "action" && target.type === "guardrail") {
    const sourceData = source.data as ActionNodeData;
    if (!isBackendSupported(sourceData)) {
      return skip(
        `${nodeLabel(source)} doesn't compile yet, so the guardrail has no coin to assert.`,
      );
    }
    return {
      edge: {
        source: edge.source,
        sourceHandle: "coin_out",
        target: edge.target,
        targetHandle: "in",
      },
    };
  }

  if (source.type === "guardrail" && target.type === "action") {
    return skip(
      "Guardrail → Action isn't supported — a guardrail only receives a coin. Wire the action into the guardrail instead.",
    );
  }

  if (source.type !== "action" || target.type !== "action") {
    // guardrail -> guardrail, or any other backend-relevant-but-unpaired combination.
    return skip(
      `${nodeLabel(source)} → ${nodeLabel(target)} isn't a wiring the compiler understands.`,
    );
  }

  const targetData = target.data as ActionNodeData;
  if (!isBackendSupported(targetData)) {
    return skip(`${nodeLabel(target)} doesn't compile yet.`);
  }

  if (wireKindFromEdge(edge, nodes) !== "coin") {
    return skip(
      `${nodeLabel(source)} → ${nodeLabel(target)} isn't a supported coin chain — only Cetus swap → Haedal stake carries a coin between actions today.`,
    );
  }

  const handles = resolveBackendCoinHandles(source, target);
  if (!handles) {
    return skip(`${nodeLabel(source)} → ${nodeLabel(target)} has no known coin-handle mapping.`);
  }

  return {
    edge: {
      source: edge.source,
      sourceHandle: handles.sourceHandle,
      target: edge.target,
      targetHandle: handles.targetHandle,
    },
  };
}

export function buildFlowGraph(
  nodes: Node[],
  edges: Edge[],
): FlowGraph & {
  skipped: string[];
  skippedEdges: SkippedEdge[];
  wireConstraintChanges: WireConstraintChange[];
} {
  const wireConstraintChanges = applyWireConstraints(nodes, edges);

  const changesByNode = new Map<string, WireConstraintChange[]>();
  for (const c of wireConstraintChanges) {
    const list = changesByNode.get(c.nodeId);
    if (list) list.push(c);
    else changesByNode.set(c.nodeId, [c]);
  }

  // Apply the constraint changes to an internal copy so compiled output reflects
  // them — the caller's node objects are never mutated.
  const correctedNodes: Node[] = nodes.map((n) => {
    const nodeChanges = changesByNode.get(n.id);
    if (!nodeChanges || n.type !== "action") return n;
    const data = n.data as ActionNodeData;
    const patchedConfig = { ...(data.config ?? {}) };
    for (const c of nodeChanges) patchedConfig[c.field] = c.to;
    return { ...n, data: { ...data, config: patchedConfig } };
  });

  const skipped: string[] = [];
  const flowNodes: FlowNode[] = [];

  for (const node of correctedNodes) {
    if (node.type === "ptb") {
      flowNodes.push(mapPtbNode(node.id, node.data as PtbNodeData));
      continue;
    }
    if (node.type === "guardrail") {
      flowNodes.push(mapGuardrailNode(node.id, node.data as GuardrailNodeData));
      continue;
    }
    if (node.type !== "action") continue;
    const data = node.data as ActionNodeData;
    const mapped = mapActionNode(node.id, data);
    if (mapped) {
      flowNodes.push(mapped);
    } else {
      skipped.push(nodeLabel(node));
    }
  }

  const flowEdges: FlowEdge[] = [];
  const skippedEdges: SkippedEdge[] = [];
  for (const e of edges) {
    const result = mapEdge(e, nodes);
    if (!result) continue;
    if (result.edge) flowEdges.push(result.edge);
    else if (result.skip) skippedEdges.push(result.skip);
  }

  return { nodes: flowNodes, edges: flowEdges, skipped, skippedEdges, wireConstraintChanges };
}
