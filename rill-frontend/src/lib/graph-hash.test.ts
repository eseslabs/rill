import { describe, expect, it } from "vitest";
import { hashFlowGraph, stableHash, stableStringify } from "@/lib/graph-hash";

describe("stableStringify", () => {
  it("produces identical output regardless of object key order", () => {
    const a = { b: 1, a: 2, c: { y: 1, x: 2 } };
    const b = { a: 2, c: { x: 2, y: 1 }, b: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("preserves array element order — order is semantically meaningful (edges connect specific nodes in sequence)", () => {
    const a = [{ id: "1" }, { id: "2" }];
    const b = [{ id: "2" }, { id: "1" }];
    expect(stableStringify(a)).not.toBe(stableStringify(b));
  });
});

describe("hashFlowGraph", () => {
  const graph = {
    nodes: [{ id: "n1", type: "cetus_swap", config: { amount_in: "100", pool: "p1" } }],
    edges: [{ source: "n1", target: "n2" }],
  };

  it("is stable across differing key order within node/edge objects", () => {
    const reorderedKeys = {
      nodes: [{ id: "n1", config: { pool: "p1", amount_in: "100" }, type: "cetus_swap" }],
      edges: [{ target: "n2", source: "n1" }],
    };
    expect(hashFlowGraph(graph)).toBe(hashFlowGraph(reorderedKeys));
  });

  it("changes when a node's config value changes", () => {
    const configEdited = {
      nodes: [{ id: "n1", type: "cetus_swap", config: { amount_in: "999", pool: "p1" } }],
      edges: [{ source: "n1", target: "n2" }],
    };
    expect(hashFlowGraph(configEdited)).not.toBe(hashFlowGraph(graph));
  });

  it("changes when the node array's order changes (order is preserved, not sorted)", () => {
    const twoNodeGraph = {
      nodes: [
        { id: "n1", type: "cetus_swap", config: { amount_in: "100" } },
        { id: "n2", type: "haedal_stake", config: {} },
      ],
      edges: [{ source: "n1", target: "n2" }],
    };
    const reorderedNodes = {
      nodes: [
        { id: "n2", type: "haedal_stake", config: {} },
        { id: "n1", type: "cetus_swap", config: { amount_in: "100" } },
      ],
      edges: [{ source: "n1", target: "n2" }],
    };
    expect(hashFlowGraph(reorderedNodes)).not.toBe(hashFlowGraph(twoNodeGraph));
  });
});

describe("stableHash", () => {
  it("is deterministic for the same input", () => {
    expect(stableHash("hello")).toBe(stableHash("hello"));
  });

  it("differs for different input", () => {
    expect(stableHash("hello")).not.toBe(stableHash("world"));
  });
});
