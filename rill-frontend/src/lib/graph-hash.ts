/**
 * Pure helpers for turning a compiled flow graph into a short, stable content
 * hash — used to key publish-result idempotence in export-dialog.tsx (R16):
 * same graph content -> same cached skill URL; a changed graph -> presented
 * as unpublished, requiring a new explicit Publish click.
 *
 * No crypto dependency: this only needs to reliably detect "did the graph
 * change," not resist tampering, so a small dependency-free non-cryptographic
 * hash is enough — and keeps this synchronous (crypto.subtle.digest is async
 * and would force every caller into an effect just to compute a cache key).
 * Pure and exported for direct unit testing (U12).
 */

/**
 * JSON.stringify with object keys sorted recursively, so two objects with
 * identical data in a different key order always stringify identically.
 * Array order is preserved — order is semantically part of a flow graph
 * (edges connect specific nodes in a specific sequence).
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted;
  }
  return value;
}

/** One round of 32-bit FNV-1a — fast, deterministic, dependency-free. */
function fnv1a32(input: string, seed: number): number {
  let hash = seed;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic content hash of an arbitrary string: two independent 32-bit
 * FNV-1a passes (different seeds) concatenated into a 16-hex-char digest —
 * cheap insurance against 32-bit collisions without pulling in a crypto
 * dependency.
 */
export function stableHash(input: string): string {
  const a = fnv1a32(input, 0x811c9dc5);
  const b = fnv1a32(input, 0x9e3779b9);
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/**
 * Stable content hash of a compiled flow graph (the `{nodes, edges}` shape
 * `buildFlowGraph` returns). Same graph content, in any key order, always
 * hashes identically.
 */
export function hashFlowGraph(graph: { nodes: unknown[]; edges: unknown[] }): string {
  return stableHash(stableStringify({ nodes: graph.nodes, edges: graph.edges }));
}
