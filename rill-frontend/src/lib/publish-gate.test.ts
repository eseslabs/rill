import { describe, expect, it } from "vitest";
import type { Edge, Node } from "reactflow";
import type { ActionNodeData, GuardrailNodeData } from "@/components/flow/nodes";
import { CAPABILITY_COPY, computePublishGate } from "@/lib/publish-gate";

function actionNode(
  id: string,
  protocolId: string,
  action: string,
  protocol: string,
  config: Record<string, string> = {},
): Node {
  const data: ActionNodeData = {
    protocol,
    protocolId,
    action,
    description: "",
    color: "mint",
    inputs: [],
    config,
  };
  return { id, type: "action", position: { x: 0, y: 0 }, data };
}

function guardrailNode(id: string, minValue?: string): Node {
  const data: GuardrailNodeData = { rules: [], minValue };
  return { id, type: "guardrail", position: { x: 0, y: 0 }, data };
}

const deepbookNode = (id = "n1") =>
  actionNode(id, "deepbook", "Limit order", "DeepBook", {
    poolKey: "SUI_DBUSDC",
    depositSui: "1.1",
  });
const cetusSwapNode = (id = "n1", amount = "0.1") =>
  actionNode(id, "cetus", "Swap", "Cetus", { tokenIn: "SUI", tokenOut: "USDC", amount });

describe("computePublishGate", () => {
  it("a single DeepBook limit-order flow is publishable", () => {
    const nodes = [deepbookNode()];
    const edges: Edge[] = [];
    expect(computePublishGate(nodes, edges)).toEqual({ publishable: true, reason: null });
  });

  it("a Cetus/Haedal-only flow is not publishable, with the capability reason", () => {
    const nodes = [cetusSwapNode()];
    const result = computePublishGate(nodes, []);
    expect(result.publishable).toBe(false);
    expect(result.reason).toBe(CAPABILITY_COPY.publishScope);
  });

  it("an empty flow is not publishable", () => {
    const result = computePublishGate([], []);
    expect(result.publishable).toBe(false);
    expect(result.reason).toBe(CAPABILITY_COPY.publishScope);
  });

  it("blocks on an unset guardrail minValue even alongside an otherwise-publishable flow", () => {
    const nodes = [deepbookNode(), guardrailNode("g1", undefined)];
    const result = computePublishGate(nodes, []);
    expect(result.publishable).toBe(false);
    expect(result.reason).toMatch(/guardrail minimum value/i);
  });

  it("blocks on a zero guardrail minValue", () => {
    const nodes = [deepbookNode(), guardrailNode("g1", "0")];
    const result = computePublishGate(nodes, []);
    expect(result.publishable).toBe(false);
    expect(result.reason).toMatch(/guardrail minimum value/i);
  });

  it("Part B: an action node is never blocked for a missing/invalid amount — amount is agent-supplied at runtime, not canvas-editable", () => {
    // "abc" would have failed the old amount gate; the action-node amount input no longer exists,
    // so this config key is now inert and computePublishGate must not look at it.
    const nodes = [cetusSwapNode("n1", "abc")];
    const result = computePublishGate(nodes, []);
    expect(result.publishable).toBe(false);
    // Still blocked, but for the pre-existing capability-scope reason (a lone Cetus swap can't
    // publish yet — only DeepBook can), never an amount-shaped reason.
    expect(result.reason).toBe(CAPABILITY_COPY.publishScope);
  });
});
