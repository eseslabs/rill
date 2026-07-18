import { describe, expect, it } from "vitest";
import type { Edge, Node } from "reactflow";
import type { ActionNodeData, GuardrailNodeData } from "@/components/flow/nodes";
import { hasCycle, isValidWireConnection, WIRE_IN, WIRE_OUT } from "@/lib/wire-inference";

function actionNode(id: string, protocolId: string, action: string): Node {
  const data: ActionNodeData = {
    protocol: protocolId,
    protocolId,
    action,
    description: "",
    color: "mint",
    inputs: [],
    config: {},
  };
  return { id, type: "action", position: { x: 0, y: 0 }, data };
}

function guardrailNode(id: string): Node {
  const data: GuardrailNodeData = { rules: [] };
  return { id, type: "guardrail", position: { x: 0, y: 0 }, data };
}

const cetusSwap = (id: string) => actionNode(id, "cetus", "Swap");
const haedalStake = (id: string) => actionNode(id, "haedal", "Stake");

function edge(id: string, source: string, target: string): Edge {
  return { id, source, target, sourceHandle: WIRE_OUT, targetHandle: WIRE_IN };
}

describe("isValidWireConnection", () => {
  it("rejects a guardrail as the source feeding into an action", () => {
    const nodes = [guardrailNode("g1"), haedalStake("n1")];
    const result = isValidWireConnection(
      { source: "g1", target: "n1", sourceHandle: WIRE_OUT, targetHandle: WIRE_IN },
      nodes,
      [],
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/guardrail can't feed an action/i);
  });

  it("accepts a legal Action -> Guardrail connection", () => {
    const nodes = [cetusSwap("n1"), guardrailNode("g1")];
    const result = isValidWireConnection(
      { source: "n1", target: "g1", sourceHandle: WIRE_OUT, targetHandle: WIRE_IN },
      nodes,
      [],
    );
    expect(result).toEqual({ valid: true, reason: null });
  });

  it("rejects a 2nd incoming coin edge into a target that already has one", () => {
    const nodes = [cetusSwap("n1"), cetusSwap("n2"), haedalStake("n3")];
    const existingEdges = [edge("e1", "n1", "n3")]; // n1 (swap) -> n3 (stake): coin edge already feeding n3

    const result = isValidWireConnection(
      { source: "n2", target: "n3", sourceHandle: WIRE_OUT, targetHandle: WIRE_IN },
      nodes,
      existingEdges,
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/already has an incoming coin/i);
  });

  it("does not limit a guardrail target to one incoming coin edge (multi-input guardrail)", () => {
    const nodes = [cetusSwap("n1"), cetusSwap("n2"), guardrailNode("g1")];
    const existingEdges = [edge("e1", "n1", "g1")];

    const result = isValidWireConnection(
      { source: "n2", target: "g1", sourceHandle: WIRE_OUT, targetHandle: WIRE_IN },
      nodes,
      existingEdges,
    );

    expect(result).toEqual({ valid: true, reason: null });
  });
});

describe("hasCycle", () => {
  it("is false for a DAG", () => {
    const edges = [edge("e1", "a", "b"), edge("e2", "b", "c")];
    expect(hasCycle(edges)).toBe(false);
  });

  it("is true when a back-edge closes a loop", () => {
    const edges = [edge("e1", "a", "b"), edge("e2", "b", "c"), edge("e3", "c", "a")];
    expect(hasCycle(edges)).toBe(true);
  });
});
