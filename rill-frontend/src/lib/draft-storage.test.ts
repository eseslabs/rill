import { beforeEach, describe, expect, it } from "vitest";
import type { Edge, Node } from "reactflow";
import {
  deserializeDraft,
  DRAFT_STORAGE_KEY,
  loadDraftFromStorage,
  maxNodeId,
  saveDraftToStorage,
  serializeDraft,
} from "@/lib/draft-storage";

/** Minimal in-memory Storage stand-in — the module only calls
 *  getItem/setItem, so a full jsdom localStorage isn't needed to test it. */
function makeMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

beforeEach(() => {
  // Direct global assignment (rather than a mocking-library helper) so this stub works
  // identically under both vitest and bun's `bun:test` vitest-compat shim — the module
  // under test just calls the ambient `localStorage`, nothing environment-specific.
  (globalThis as unknown as { localStorage: Storage }).localStorage = makeMemoryStorage();
});

const sampleNodes: Node[] = [
  { id: "n_1", type: "action", position: { x: 10, y: 20 }, data: { protocol: "cetus" } },
  { id: "gr_2", type: "guardrail", position: { x: 30, y: 40 }, data: { rules: [] } },
];
const sampleEdges: Edge[] = [{ id: "e1", source: "n_1", target: "gr_2" }];

describe("serializeDraft / deserializeDraft round-trip", () => {
  it("preserves nodes, edges, and ids through a round trip", () => {
    const raw = serializeDraft(sampleNodes, sampleEdges);
    const restored = deserializeDraft(raw);

    expect(restored).not.toBeNull();
    expect(restored?.nodes).toEqual(sampleNodes);
    expect(restored?.edges).toEqual(sampleEdges);
  });
});

describe("deserializeDraft corruption handling", () => {
  it("returns null (not a throw) for a garbage string", () => {
    expect(() => deserializeDraft("not valid json{{{")).not.toThrow();
    expect(deserializeDraft("not valid json{{{")).toBeNull();
  });

  it("returns null for null/undefined input", () => {
    expect(deserializeDraft(null)).toBeNull();
    expect(deserializeDraft(undefined)).toBeNull();
  });

  it("discards a version-mismatched blob", () => {
    const blob = JSON.stringify({ schemaVersion: 999, nodes: [], edges: [] });
    expect(deserializeDraft(blob)).toBeNull();
  });

  it("discards a blob whose nodes/edges fail shape validation", () => {
    const blob = JSON.stringify({
      schemaVersion: 1,
      nodes: [{ id: "n_1" /* missing position */ }],
      edges: [],
    });
    expect(deserializeDraft(blob)).toBeNull();
  });
});

describe("loadDraftFromStorage / saveDraftToStorage", () => {
  it("reports 'empty' when nothing has been saved", () => {
    expect(loadDraftFromStorage()).toEqual({ status: "empty" });
  });

  it("round-trips through saveDraftToStorage/loadDraftFromStorage", () => {
    saveDraftToStorage(sampleNodes, sampleEdges);
    const result = loadDraftFromStorage();
    expect(result.status).toBe("restored");
    if (result.status === "restored") {
      expect(result.draft.nodes).toEqual(sampleNodes);
      expect(result.draft.edges).toEqual(sampleEdges);
    }
  });

  it("reports 'corrupt' (not empty, not a throw) for a garbage stored blob", () => {
    localStorage.setItem(DRAFT_STORAGE_KEY, "{{{not json");
    expect(() => loadDraftFromStorage()).not.toThrow();
    expect(loadDraftFromStorage()).toEqual({ status: "corrupt" });
  });
});

describe("maxNodeId", () => {
  it("returns the highest numeric id suffix across n_/ptb_/gr_ prefixed ids", () => {
    const nodes = [{ id: "n_1" }, { id: "ptb_7" }, { id: "gr_3" }, { id: "trigger" }, { id: "output" }];
    expect(maxNodeId(nodes)).toBe(7);
  });

  it("returns 0 when no id has a numeric suffix", () => {
    expect(maxNodeId([{ id: "trigger" }, { id: "output" }])).toBe(0);
  });

  it("returns 0 for an empty node list", () => {
    expect(maxNodeId([])).toBe(0);
  });
});
