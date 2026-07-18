import { describe, expect, it } from "vitest";
import type { Edge, Node } from "reactflow";
import { computeAutoLayout } from "@/lib/auto-layout";

function node(id: string, type: string): Node {
  return { id, type, position: { x: 0, y: 0 }, data: {} };
}

function edge(id: string, source: string, target: string): Edge {
  return { id, source, target };
}

describe("computeAutoLayout", () => {
  it("returns a position for every input node, keyed by id", () => {
    const nodes = [node("trigger", "trigger"), node("output", "output")];
    const positions = computeAutoLayout(nodes, []);
    expect(positions.size).toBe(nodes.length);
    for (const n of nodes) expect(positions.has(n.id)).toBe(true);
  });

  it("Trigger always lands in the leftmost column, even fully unwired", () => {
    const nodes = [node("trigger", "trigger"), node("output", "output"), node("a1", "action")];
    const positions = computeAutoLayout(nodes, []);
    const triggerX = positions.get("trigger")!.x;
    for (const n of nodes) {
      if (n.id === "trigger") continue;
      expect(positions.get(n.id)!.x).toBeGreaterThanOrEqual(triggerX);
    }
  });

  it("Output always lands strictly right of every other node, even on an empty canvas", () => {
    const nodes = [node("trigger", "trigger"), node("output", "output")];
    const positions = computeAutoLayout(nodes, []);
    expect(positions.get("output")!.x).toBeGreaterThan(positions.get("trigger")!.x);
  });

  it("a linear chain gets strictly increasing x per hop", () => {
    const nodes = [
      node("trigger", "trigger"),
      node("a1", "action"),
      node("a2", "action"),
      node("output", "output"),
    ];
    const edges = [edge("e1", "trigger", "a1"), edge("e2", "a1", "a2"), edge("e3", "a2", "output")];
    const positions = computeAutoLayout(nodes, edges);
    const xs = ["trigger", "a1", "a2", "output"].map((id) => positions.get(id)!.x);
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
    expect(xs[2]).toBeLessThan(xs[3]);
  });

  it("two parallel branches fed by Trigger share a column (same x) but sit at different y", () => {
    const nodes = [
      node("trigger", "trigger"),
      node("a1", "action"),
      node("a2", "action"),
      node("output", "output"),
    ];
    const edges = [
      edge("e1", "trigger", "a1"),
      edge("e2", "trigger", "a2"),
      edge("e3", "a1", "output"),
      edge("e4", "a2", "output"),
    ];
    const positions = computeAutoLayout(nodes, edges);
    expect(positions.get("a1")!.x).toBe(positions.get("a2")!.x);
    expect(positions.get("a1")!.y).not.toBe(positions.get("a2")!.y);
  });

  it("never throws and still places every node when the graph contains a cycle", () => {
    const nodes = [node("a1", "action"), node("a2", "action")];
    const edges = [edge("e1", "a1", "a2"), edge("e2", "a2", "a1")];
    expect(() => computeAutoLayout(nodes, edges)).not.toThrow();
    const positions = computeAutoLayout(nodes, edges);
    expect(positions.size).toBe(2);
  });

  it("ignores dangling edges that reference a node id not in the input list", () => {
    const nodes = [node("trigger", "trigger"), node("output", "output")];
    const edges = [edge("e1", "trigger", "ghost"), edge("e2", "ghost", "output")];
    expect(() => computeAutoLayout(nodes, edges)).not.toThrow();
  });

  it("an empty node list returns an empty map", () => {
    expect(computeAutoLayout([], []).size).toBe(0);
  });
});
