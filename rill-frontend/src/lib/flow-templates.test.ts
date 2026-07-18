import { describe, expect, it } from "vitest";
import type { Node } from "reactflow";
import { FLOW_TEMPLATES } from "@/lib/flow-templates";
import type { ActionNodeData, GuardrailNodeData } from "@/components/flow/nodes";
import { actionAmountError, TOKEN_COIN_TYPE, type SwapTokenSymbol } from "@/lib/action-config";
import { isGuardrailMinValueValid } from "@/lib/publish-gate";
import { wireKindFromEdge } from "@/lib/wire-inference";

/** Same `n_${n}` id scheme Builder's `idRef` counter produces — a fresh,
 *  monotonic counter per call mirrors calling `template.build(makeId)` once
 *  against a clean canvas. */
function makeCounterId(counter: { n: number }): () => string {
  return () => `n_${counter.n++}`;
}

const KNOWN_NODE_TYPES = new Set(["action", "guardrail"]);

/** Mirrors nodes.tsx's own amount-coin-type detection so a template's action
 *  amount is checked against the exact rule the canvas node itself enforces. */
function amountCoinTypeFor(data: ActionNodeData): string | null {
  if (data.protocolId === "cetus" && data.action.toLowerCase().includes("swap")) {
    const tokenIn = (data.config?.tokenIn as SwapTokenSymbol) || "SUI";
    return TOKEN_COIN_TYPE[tokenIn] ?? TOKEN_COIN_TYPE.SUI;
  }
  if (data.protocolId === "haedal" && data.action.toLowerCase().includes("stake")) {
    return TOKEN_COIN_TYPE.SUI;
  }
  return null;
}

describe("FLOW_TEMPLATES", () => {
  it("is non-empty and every id is unique", () => {
    expect(FLOW_TEMPLATES.length).toBeGreaterThan(0);
    const ids = FLOW_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const template of FLOW_TEMPLATES) {
    describe(`template: ${template.id}`, () => {
      it("builds a non-empty node list with unique ids and valid node types", () => {
        const built = template.build(makeCounterId({ n: 0 }));
        expect(built.nodes.length).toBeGreaterThan(0);

        const nodeIds = built.nodes.map((n) => n.id);
        expect(new Set(nodeIds).size).toBe(nodeIds.length);

        for (const node of built.nodes) {
          expect(KNOWN_NODE_TYPES.has(node.type ?? "")).toBe(true);
          expect(node.position).toBeTruthy();
          expect(typeof node.position.x).toBe("number");
          expect(typeof node.position.y).toBe("number");
        }
      });

      it("only wires edges between node ids that actually exist in the build", () => {
        const built = template.build(makeCounterId({ n: 0 }));
        const nodeIds = new Set(built.nodes.map((n) => n.id));
        for (const edge of built.edges) {
          expect(nodeIds.has(edge.source)).toBe(true);
          expect(nodeIds.has(edge.target)).toBe(true);
          expect(edge.source).not.toBe(edge.target);
        }
      });

      it("every edge id is unique and distinct from node ids", () => {
        const built = template.build(makeCounterId({ n: 0 }));
        const edgeIds = built.edges.map((e) => e.id);
        expect(new Set(edgeIds).size).toBe(edgeIds.length);
        const nodeIds = new Set(built.nodes.map((n) => n.id));
        for (const id of edgeIds) expect(nodeIds.has(id)).toBe(false);
      });

      it("every action node's amount passes the same gate the canvas node enforces (R5)", () => {
        const built = template.build(makeCounterId({ n: 0 }));
        for (const node of built.nodes) {
          if (node.type !== "action") continue;
          const data = node.data as ActionNodeData;
          const coinType = amountCoinTypeFor(data);
          if (!coinType) continue; // e.g. DeepBook — not amount-gated the same way
          expect(actionAmountError(data.config?.amount, coinType)).toBeNull();
        }
      });

      it("every guardrail node's minValue passes the publish gate (R1)", () => {
        const built = template.build(makeCounterId({ n: 0 }));
        for (const node of built.nodes) {
          if (node.type !== "guardrail") continue;
          const data = node.data as GuardrailNodeData;
          expect(isGuardrailMinValueValid(data.minValue)).toBe(true);
        }
      });
    });
  }

  it("re-running build() with a fresh makeId never collides with a prior build's ids (multi-template drop)", () => {
    const counter = { n: 0 };
    const makeId = makeCounterId(counter);
    const allIds = new Set<string>();
    for (const template of FLOW_TEMPLATES) {
      const built = template.build(makeId);
      for (const node of built.nodes) {
        expect(allIds.has(node.id)).toBe(false);
        allIds.add(node.id);
      }
    }
  });

  it("swap-stake wires a coin chain whose swap output is SUI (feeds Haedal cleanly, no wire-correction needed)", () => {
    const template = FLOW_TEMPLATES.find((t) => t.id === "swap-stake");
    expect(template).toBeTruthy();
    const built = template!.build(makeCounterId({ n: 0 }));

    const swap = built.nodes.find((n) => (n.data as ActionNodeData).protocolId === "cetus") as Node;
    const stake = built.nodes.find(
      (n) => (n.data as ActionNodeData).protocolId === "haedal",
    ) as Node;
    expect(swap).toBeTruthy();
    expect(stake).toBeTruthy();

    const swapData = swap.data as ActionNodeData;
    expect(swapData.config?.tokenOut).toBe("SUI");

    expect(built.edges).toHaveLength(1);
    const edge = built.edges[0];
    expect(edge.source).toBe(swap.id);
    expect(edge.target).toBe(stake.id);
    expect(wireKindFromEdge(edge, built.nodes)).toBe("coin");
  });

  it("guarded-swap wires the swap into the guardrail (Action -> Guardrail, the only supported direction)", () => {
    const template = FLOW_TEMPLATES.find((t) => t.id === "guarded-swap");
    expect(template).toBeTruthy();
    const built = template!.build(makeCounterId({ n: 0 }));

    const swap = built.nodes.find((n) => n.type === "action") as Node;
    const guardrail = built.nodes.find((n) => n.type === "guardrail") as Node;
    expect(swap).toBeTruthy();
    expect(guardrail).toBeTruthy();

    expect(built.edges).toHaveLength(1);
    expect(built.edges[0].source).toBe(swap.id);
    expect(built.edges[0].target).toBe(guardrail.id);
  });
});
