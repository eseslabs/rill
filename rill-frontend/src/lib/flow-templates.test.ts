import { describe, expect, it } from "vitest";
import type { Node } from "reactflow";
import { FLOW_TEMPLATES } from "@/lib/flow-templates";
import type { ActionNodeData, GuardrailNodeData } from "@/components/flow/nodes";
import {
  actionAmountError,
  otherSwapToken,
  TOKEN_COIN_TYPE,
  type SwapTokenSymbol,
} from "@/lib/action-config";
import { isGuardrailMinValueValid } from "@/lib/publish-gate";
import { wireKindFromEdge } from "@/lib/wire-inference";
import { validateManifest } from "@/lib/capabilities";

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

/** Part A: the OUTPUT token's coin type for a Cetus swap node — `min_amount_out` (the per-swap
 *  slippage floor) is denominated in the output token's own units, mirroring nodes.tsx's "Min
 *  swap output" field. `null` for anything that isn't a Cetus swap (no per-swap floor to check). */
function outputCoinTypeFor(data: ActionNodeData): string | null {
  if (data.protocolId !== "cetus" || !data.action.toLowerCase().includes("swap")) return null;
  const tokenIn = (data.config?.tokenIn as SwapTokenSymbol) || "SUI";
  return TOKEN_COIN_TYPE[otherSwapToken(tokenIn)];
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

      // Part A: every Cetus swap node ships its own per-swap slippage floor now — the backend
      // requires a terminal swap (no downstream guardrail) to set config.min_amount_out, so a
      // template that omitted it would fail to publish/simulate honestly.
      it("every Cetus swap node's min_amount_out is a valid, positive amount in the output token's units", () => {
        const built = template.build(makeCounterId({ n: 0 }));
        for (const node of built.nodes) {
          if (node.type !== "action") continue;
          const data = node.data as ActionNodeData;
          const coinType = outputCoinTypeFor(data);
          if (!coinType) continue; // not a Cetus swap — no per-swap floor to check
          expect(actionAmountError(data.config?.min_amount_out, coinType)).toBeNull();
        }
      });

      // Part D: BASE_X (flow-templates.ts) sits well right of the Trigger scaffold node
      // (routes/builder.tsx's initialNodes, x:40) so a freshly-applied template never stacks its
      // first action node on top of it.
      it("every node's x position sits clear of the Trigger scaffold node (x:40)", () => {
        const built = template.build(makeCounterId({ n: 0 }));
        for (const node of built.nodes) {
          expect(node.position.x).toBeGreaterThan(200);
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

  it("guarded-swap ships a single Cetus swap node with an owner-set min_amount_out — no separate guardrail node (Part B)", () => {
    const template = FLOW_TEMPLATES.find((t) => t.id === "guarded-swap");
    expect(template).toBeTruthy();
    const built = template!.build(makeCounterId({ n: 0 }));

    expect(built.nodes).toHaveLength(1);
    const swap = built.nodes[0];
    expect(swap.type).toBe("action");
    const swapData = swap.data as ActionNodeData;
    expect(swapData.protocolId).toBe("cetus");
    expect(Number(swapData.config?.min_amount_out)).toBeGreaterThan(0);

    expect(built.edges).toHaveLength(0);
  });

  // Part C: template gallery cards (icon, ordered protocol steps, suggested capability manifest).
  describe("Part C card metadata", () => {
    it("every template has an icon component and a non-empty ordered steps list", () => {
      for (const template of FLOW_TEMPLATES) {
        expect(template.icon).toBeTruthy();
        expect(Array.isArray(template.steps)).toBe(true);
        expect(template.steps.length).toBeGreaterThan(0);
      }
    });

    it("every template ships a manifest, and every shipped manifest is schema-valid", () => {
      for (const template of FLOW_TEMPLATES) {
        expect(template.manifest).toBeTruthy();
        if (!template.manifest) continue;
        const result = validateManifest(template.manifest);
        expect(result.ok, `${template.id}: ${!result.ok ? result.error : ""}`).toBe(true);
      }
    });

    it("no template manifest declares a duplicate rule kind", () => {
      for (const template of FLOW_TEMPLATES) {
        if (!template.manifest) continue;
        const kinds = template.manifest.rules.map((r) => r.kind);
        expect(new Set(kinds).size).toBe(kinds.length);
      }
    });
  });
});
