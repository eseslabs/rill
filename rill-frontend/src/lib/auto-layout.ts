import type { Edge, Node } from "reactflow";

/**
 * Part D: deterministic left-to-right auto-layout for the "Auto-arrange" toolbar button
 * (routes/builder.tsx). Places every node into a column by its longest-path depth from a source
 * (a node with no incoming edges) — Trigger is always column 0 (wire-inference.ts's
 * `isValidWireConnection` never allows an edge to target it, so it structurally can't have an
 * incoming edge) and Output is always the rightmost column (same file never allows an edge to
 * source from it), with every action node in between placed in dependency order. No dagre
 * dependency — good enough for the small flows this canvas holds.
 */

const LAYOUT_BASE_X = 40;
// Comfortably wider than the widest action-node card renders (measured: Cetus swap ~371px,
// DeepBook limit order ~449px) — mirrors flow-templates.ts's own STEP_X and the same reasoning:
// that alone guarantees two nodes in adjacent columns never overlap horizontally, regardless of y.
const LAYOUT_STEP_X = 480;
// Vertical center-line every column balances around, so a single-node column (Trigger, Output, one
// action) sits at the same height and the whole flow reads as one straight, centered row instead of
// top-ragged columns.
const LAYOUT_MID_Y = 300;
// Comfortably taller than the tallest action-node card renders (measured: DeepBook limit order
// ~419px) — two nodes CAN share a column here (e.g. unwired siblings both fed by Trigger), so
// this needs to clear the tallest card's height, not just look tidy.
const LAYOUT_STEP_Y = 450;

/** Returns a position for every node in `nodes` — always the same length/id set as the input, so
 *  a caller can blindly look up `positions.get(node.id)!` for each node it re-lays-out. */
export function computeAutoLayout(
  nodes: Node[],
  edges: Edge[],
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();

  // Capabilities is an inline flow node (Trigger → Capabilities → actions → Output) with real wires,
  // so it lays out by depth like any other node — no special-casing.
  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const outgoing = new Map<string, string[]>(ids.map((id) => [id, []]));
  const incoming = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) {
    if (!e.source || !e.target || !idSet.has(e.source) || !idSet.has(e.target)) continue;
    outgoing.get(e.source)!.push(e.target);
    incoming.get(e.target)!.push(e.source);
  }

  // Kahn's-style topological order. Any node left over is part of a cycle (the publish gate
  // already blocks cycles from ever reaching compile, but auto-arrange runs on live, possibly
  // mid-edit canvas state) — appended afterward in canvas order so a malformed graph still lays
  // out deterministically instead of infinite-looping or crashing.
  const inDegree = new Map(ids.map((id) => [id, incoming.get(id)!.length]));
  const queue = ids.filter((id) => inDegree.get(id) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of outgoing.get(id)!) {
      const d = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  for (const id of ids) if (!order.includes(id)) order.push(id);

  // depth[n] = 0 for a source node, else 1 + the max depth of any predecessor already placed.
  const depth = new Map<string, number>();
  for (const id of order) {
    const preds = incoming.get(id)!.filter((p) => depth.has(p));
    depth.set(id, preds.length > 0 ? Math.max(...preds.map((p) => depth.get(p)!)) + 1 : 0);
  }

  // Trigger owns column 0 alone; Output is pinned strictly last. Any OTHER node the DP left at
  // depth 0 (a freshly-dropped, not-yet-wired action) is bumped to column 1 so it never stacks on
  // top of the Trigger — the old layout let unwired actions share the Trigger's column, which read
  // as a collision.
  for (const node of nodes) {
    if (node.type === "trigger") depth.set(node.id, 0);
    else if (node.type !== "output" && (depth.get(node.id) ?? 0) === 0) depth.set(node.id, 1);
  }
  const nonOutputDepths = nodes.filter((n) => n.type !== "output").map((n) => depth.get(n.id) ?? 0);
  const nonOutputMax = nonOutputDepths.length > 0 ? Math.max(...nonOutputDepths) : 0;
  for (const node of nodes) {
    if (node.type === "output")
      depth.set(node.id, Math.max(depth.get(node.id) ?? 0, nonOutputMax + 1));
  }

  const columns = new Map<number, string[]>();
  for (const id of order) {
    const d = depth.get(id) ?? 0;
    const col = columns.get(d);
    if (col) col.push(id);
    else columns.set(d, [id]);
  }

  // Center each column on LAYOUT_MID_Y: a column of N cards spans (N-1)*STEP_Y, so its first card
  // starts half that span above the mid-line and they fill downward — single-card columns land
  // exactly on the line, keeping the mainline flow dead straight.
  for (const [d, colIds] of columns) {
    const span = (colIds.length - 1) * LAYOUT_STEP_Y;
    const startY = LAYOUT_MID_Y - span / 2;
    colIds.forEach((id, i) => {
      positions.set(id, { x: LAYOUT_BASE_X + d * LAYOUT_STEP_X, y: startY + i * LAYOUT_STEP_Y });
    });
  }

  return positions;
}
