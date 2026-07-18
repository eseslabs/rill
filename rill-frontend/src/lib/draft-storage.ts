import type { Edge, Node } from "reactflow";
import type { PublishResult } from "@/lib/rill-api";

/**
 * Pure, localStorage-backed persistence for the builder canvas draft and the
 * last publish result (R16: builder state survives refresh; the last publish
 * result is recoverable). Every exported function that touches `localStorage`
 * is a thin, guarded (try/catch) wrapper around a pure serialize/deserialize
 * pair — the pure pair is what's unit-tested directly (U12), without needing
 * a DOM/localStorage shim.
 */

/** Namespaced + versioned so a future incompatible schema change never
 *  collides with (or gets misread as) whatever a returning user already has
 *  saved under an older shape. */
export const DRAFT_STORAGE_KEY = "rill.builder.draft.v1";
export const PUBLISH_STORAGE_KEY = "rill.builder.publish.v1";

const DRAFT_SCHEMA_VERSION = 1;

export type DraftPayload = { nodes: Node[]; edges: Edge[] };

export type StoredPublishRecord = { hash: string; result: PublishResult };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Draft (nodes/edges) round-trip
// ---------------------------------------------------------------------------

/** nodes/edges -> versioned JSON string. Pure. */
export function serializeDraft(nodes: Node[], edges: Edge[]): string {
  return JSON.stringify({ schemaVersion: DRAFT_SCHEMA_VERSION, nodes, edges });
}

/** A restorable node only needs a non-empty string `id` and an `{x, y}`
 *  position ReactFlow can render — everything else (data, type, etc.) is
 *  passed through as-is. */
function isRestorableNode(value: unknown): value is Node {
  if (!isPlainRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.length === 0) return false;
  const position = value.position;
  if (!isPlainRecord(position)) return false;
  return typeof position.x === "number" && typeof position.y === "number";
}

/** A restorable edge needs a non-empty string `id` and string
 *  `source`/`target` — non-string endpoints would otherwise throw inside
 *  ReactFlow rather than degrading gracefully. */
function isRestorableEdge(value: unknown): value is Edge {
  return (
    isPlainRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.source === "string" &&
    typeof value.target === "string"
  );
}

/**
 * JSON string -> {nodes, edges}, or `null` on ANY corruption, shape
 * mismatch, or schema-version skew (R16: restore is validated, never trusted
 * blindly). Mirrors the `onDrop` JSON.parse guard in builder.tsx — corrupt
 * input degrades to "nothing to restore," never a crash. Pure.
 */
export function deserializeDraft(raw: string | null | undefined): DraftPayload | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainRecord(parsed)) return null;
  if (parsed.schemaVersion !== DRAFT_SCHEMA_VERSION) return null;

  const nodes = parsed.nodes;
  const edges = parsed.edges;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return null;
  if (!nodes.every(isRestorableNode) || !edges.every(isRestorableEdge)) return null;

  return { nodes: nodes as Node[], edges: edges as Edge[] };
}

/** Highest numeric suffix among restored node ids (e.g. `n_12` -> 12), so
 *  `idRef` can be seeded past it and never collide with a restored node. Ids
 *  with no trailing digits (the fixed `trigger`/`output` nodes) are ignored
 *  rather than fatal. Pure. */
export function maxNodeId(nodes: { id: string }[]): number {
  let max = 0;
  for (const node of nodes) {
    const match = /(\d+)$/.exec(node.id);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max;
}

export type DraftRestoreResult =
  | { status: "empty" }
  | { status: "restored"; draft: DraftPayload }
  | { status: "corrupt" };

/** Reads + validates the autosaved draft from localStorage. Distinguishes
 *  "nothing saved yet" from "something was saved but is corrupt/stale" so the
 *  caller only toasts in the latter case. */
export function loadDraftFromStorage(): DraftRestoreResult {
  let raw: string | null;
  try {
    raw = localStorage.getItem(DRAFT_STORAGE_KEY);
  } catch {
    return { status: "empty" }; // storage inaccessible (private mode, etc.) — not "corrupt"
  }
  if (!raw) return { status: "empty" };
  const draft = deserializeDraft(raw);
  return draft ? { status: "restored", draft } : { status: "corrupt" };
}

/** Best-effort autosave — localStorage being full/disabled degrades to "no
 *  autosave," never a thrown error on the canvas's hot path. */
export function saveDraftToStorage(nodes: Node[], edges: Edge[]): void {
  try {
    localStorage.setItem(DRAFT_STORAGE_KEY, serializeDraft(nodes, edges));
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Last publish result (survives refresh; keyed by graph hash — see
// lib/graph-hash.ts — so export-dialog can tell "same flow" from "changed
// flow" without re-hitting the backend)
// ---------------------------------------------------------------------------

function isPublishResult(value: unknown): value is PublishResult {
  return (
    isPlainRecord(value) &&
    typeof value.skillId === "string" &&
    typeof value.mcpUrl === "string" &&
    Array.isArray(value.warnings)
  );
}

/** {hash, result} -> JSON string. Pure. */
export function serializePublishRecord(record: StoredPublishRecord): string {
  return JSON.stringify(record);
}

/** JSON string -> {hash, result}, or `null` on any corruption/shape
 *  mismatch. Pure. */
export function deserializePublishRecord(raw: string | null | undefined): StoredPublishRecord | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainRecord(parsed)) return null;

  const hash = parsed.hash;
  const result = parsed.result;
  if (typeof hash !== "string" || hash.length === 0) return null;
  if (!isPublishResult(result)) return null;

  return { hash, result: result as PublishResult };
}

export function loadPublishRecordFromStorage(): StoredPublishRecord | null {
  try {
    return deserializePublishRecord(localStorage.getItem(PUBLISH_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function savePublishRecordToStorage(record: StoredPublishRecord): void {
  try {
    localStorage.setItem(PUBLISH_STORAGE_KEY, serializePublishRecord(record));
  } catch {
    /* best-effort */
  }
}
