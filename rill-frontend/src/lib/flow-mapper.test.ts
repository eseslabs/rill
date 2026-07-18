import { describe, expect, it } from "vitest";
import type { Edge, Node } from "reactflow";
import type { ActionNodeData, GuardrailNodeData } from "@/components/flow/nodes";
import { applyWireConstraints, buildFlowGraph, isBackendSupported } from "@/lib/flow-mapper";
import { WIRE_IN, WIRE_OUT } from "@/lib/wire-inference";

function actionNode(
  id: string,
  protocolId: string,
  action: string,
  config: Record<string, string> = {},
): Node {
  const data: ActionNodeData = {
    protocol: protocolId,
    protocolId,
    action,
    description: "",
    color: "mint",
    inputs: [],
    config,
  };
  return { id, type: "action", position: { x: 0, y: 0 }, data };
}

function guardrailNode(id: string, minValue?: string, coinType?: string): Node {
  const data: GuardrailNodeData = { rules: [], minValue, coinType };
  return { id, type: "guardrail", position: { x: 0, y: 0 }, data };
}

function edge(
  id: string,
  source: string,
  target: string,
  sourceHandle: string = WIRE_OUT,
  targetHandle: string = WIRE_IN,
): Edge {
  return { id, source, target, sourceHandle, targetHandle };
}

const cetusSwap = (id: string, config: Record<string, string> = {}) =>
  actionNode(id, "cetus", "Swap", { tokenIn: "SUI", tokenOut: "USDC", amount: "0.1", ...config });
const haedalStake = (id: string, config: Record<string, string> = {}) =>
  actionNode(id, "haedal", "Stake", { amount: "1", ...config });
const deepbookOrder = (id: string) => actionNode(id, "deepbook", "Limit order");

describe("isBackendSupported", () => {
  it("is true for cetus swap, haedal stake, and deepbook limit order", () => {
    expect(isBackendSupported(cetusSwap("n1").data as ActionNodeData)).toBe(true);
    expect(isBackendSupported(haedalStake("n2").data as ActionNodeData)).toBe(true);
    expect(isBackendSupported(deepbookOrder("n3").data as ActionNodeData)).toBe(true);
  });

  it("is false for an unknown protocol/action", () => {
    expect(isBackendSupported(actionNode("n1", "unknown", "Foo").data as ActionNodeData)).toBe(
      false,
    );
    // Same protocol, wrong action still fails — matching is per (protocolId, action) pair.
    expect(isBackendSupported(actionNode("n2", "cetus", "Withdraw").data as ActionNodeData)).toBe(
      false,
    );
  });
});

describe("buildFlowGraph edge mapping", () => {
  it("keeps and maps an Action -> Guardrail edge", () => {
    const nodes = [cetusSwap("n1"), guardrailNode("g1", "1", "0x2::sui::SUI")];
    const edges = [edge("e1", "n1", "g1")];

    const graph = buildFlowGraph(nodes, edges);

    expect(graph.skippedEdges).toEqual([]);
    expect(graph.edges).toEqual([
      { source: "n1", sourceHandle: "coin_out", target: "g1", targetHandle: "in" },
    ]);
  });

  it("skips a Guardrail -> Action edge with a direction-explaining reason", () => {
    const nodes = [guardrailNode("g1", "1"), haedalStake("n1")];
    const edges = [edge("e1", "g1", "n1")];

    const graph = buildFlowGraph(nodes, edges);

    expect(graph.edges).toEqual([]);
    expect(graph.skippedEdges).toHaveLength(1);
    expect(graph.skippedEdges[0].reason).toMatch(/Guardrail → Action isn't supported/);
  });

  it("skips an unsupported action <-> action pair (not a coin chain)", () => {
    // Two backend-supported actions that aren't the one recognized swap->stake coin
    // chain — wireKindFromEdge resolves to "flow", not "coin", so it's rejected.
    const nodes = [cetusSwap("n1"), cetusSwap("n2")];
    const edges = [edge("e1", "n1", "n2")];

    const graph = buildFlowGraph(nodes, edges);

    expect(graph.edges).toEqual([]);
    expect(graph.skippedEdges).toHaveLength(1);
    expect(graph.skippedEdges[0].reason).toMatch(/isn't a supported coin chain/);
  });

  it("skips an edge into an action the backend doesn't compile yet", () => {
    const nodes = [cetusSwap("n1"), actionNode("n2", "unknown", "Foo")];
    const edges = [edge("e1", "n1", "n2")];

    const graph = buildFlowGraph(nodes, edges);

    expect(graph.edges).toEqual([]);
    expect(graph.skippedEdges).toHaveLength(1);
    expect(graph.skippedEdges[0].reason).toMatch(/doesn't compile yet/);
  });

  it("maps the recognized Cetus swap -> Haedal stake coin chain", () => {
    const nodes = [cetusSwap("n1", { tokenIn: "USDC", tokenOut: "SUI" }), haedalStake("n2")];
    const edges = [edge("e1", "n1", "n2")];

    const graph = buildFlowGraph(nodes, edges);

    expect(graph.skippedEdges).toEqual([]);
    expect(graph.edges).toEqual([
      { source: "n1", sourceHandle: "coin_out", target: "n2", targetHandle: "sui_coin" },
    ]);
  });
});

describe("applyWireConstraints", () => {
  it("returns the token-pair change list for a swap -> stake wiring whose swap doesn't output SUI", () => {
    // tokenIn "SUI" means the swap outputs USDC, which Haedal can't stake.
    const src = cetusSwap("n1", { tokenIn: "SUI", tokenOut: "USDC" });
    const tgt = haedalStake("n2");
    const edges = [edge("e1", "n1", "n2")];

    const changes = applyWireConstraints([src, tgt], edges);

    expect(changes).toEqual([
      expect.objectContaining({ nodeId: "n1", field: "tokenIn", from: "SUI", to: "USDC" }),
      expect.objectContaining({ nodeId: "n1", field: "tokenOut", from: "USDC", to: "SUI" }),
    ]);
  });

  it("returns an empty list when the token pair already conforms (toast-dedup contract)", () => {
    const src = cetusSwap("n1", { tokenIn: "USDC", tokenOut: "SUI" });
    const tgt = haedalStake("n2");
    const edges = [edge("e1", "n1", "n2")];

    const changes = applyWireConstraints([src, tgt], edges);

    expect(changes).toEqual([]);
  });

  it("no longer caps the stake amount to the swap output (Part B: amount is agent-supplied at runtime, not canvas-editable)", () => {
    const src = cetusSwap("n1", { tokenIn: "USDC", tokenOut: "SUI", amount: "0.1" });
    const tgt = haedalStake("n2", { amount: "999" });
    const edges = [edge("e1", "n1", "n2")];

    const changes = applyWireConstraints([src, tgt], edges);

    expect(changes).toEqual([]);
  });
});
