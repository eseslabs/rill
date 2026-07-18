import type { FlowGraph } from './types';

/** Per-node-type registry of valid edge handle names. Mirrors the handles the frontend actually
 *  emits (`rill-frontend/src/lib/wire-inference.ts` `resolveBackendCoinHandles`, `flow-mapper.ts`
 *  `mapEdge`'s Action -> Guardrail branch) plus the handles each adapter's own `build()` looks up
 *  by (`cetus.adapter.ts`'s `coin_inputs`, `haedal.adapter.ts`'s `sui_coin`). Used to reject a
 *  typo'd/unknown handle (e.g. `targetHandle: "coin"` instead of `"sui_coin"`) at validation time —
 *  without this, a mis-wired edge silently fails to chain a coin and the target node falls back to
 *  drawing a *second*, independent helping of root funding instead (R13).
 */
export interface HandleSpec {
  /** Valid `targetHandle` names this node type accepts on incoming edges. */
  readonly targetHandles: readonly string[];
  /** Valid `sourceHandle` names this node type emits on outgoing edges. */
  readonly sourceHandles: readonly string[];
}

export const NODE_HANDLES: Record<string, HandleSpec> = {
  cetus_swap: { targetHandles: ['coin_inputs'], sourceHandles: ['coin_out'] },
  haedal_stake: { targetHandles: ['sui_coin'], sourceHandles: [] },
  deepbook_limit_order: { targetHandles: [], sourceHandles: [] },
  ptb: { targetHandles: [], sourceHandles: [] },
  // Guardrail ports are the generic single in/out handles (matches the frontend's WIRE_IN/WIRE_OUT
  // convention for non-protocol-specific nodes) — the compiler supports many edges targeting the
  // same "in" handle (a multi-input guardrail asserts each then merges).
  guardrail: { targetHandles: ['in'], sourceHandles: ['out'] },
};

export interface FlowStructureIssue {
  message: string;
  path: (string | number)[];
}

/**
 * Structural checks shared by the HTTP schema (`api.schema.ts`'s `FlowSchema.superRefine`) and the
 * compiler's own defense-in-depth gate (`compiler.service.ts` calls this at the top of
 * `compileFlow`, throwing `ValidationError` on any issue — the same 422 path direct callers like
 * the MCP skill-runner get, since they bypass the HTTP schema layer entirely):
 *   - unique node ids
 *   - every edge's source/target references an existing node
 *   - every edge's source/targetHandle is registered for its endpoint's node type
 *
 * Node types with no registry entry (an unsupported/experimental node type) are left unchecked
 * here on purpose — an unrecognized node type is already reported as a soft warning by the
 * compiler's per-node adapter lookup, not a hard validation error, and handle-checking it here
 * would turn that existing graceful-skip into a hard failure.
 */
export function findFlowStructureIssues(flow: FlowGraph): FlowStructureIssue[] {
  const issues: FlowStructureIssue[] = [];

  const seen = new Set<string>();
  flow.nodes.forEach((node, i) => {
    if (seen.has(node.id)) {
      issues.push({ message: `Duplicate node id "${node.id}".`, path: ['nodes', i, 'id'] });
    }
    seen.add(node.id);
  });

  const nodesById = new Map(flow.nodes.map((n) => [n.id, n]));
  flow.edges.forEach((edge, i) => {
    const sourceNode = nodesById.get(edge.source);
    const targetNode = nodesById.get(edge.target);

    if (!sourceNode) {
      issues.push({
        message: `Edge ${i}: source "${edge.source}" does not reference an existing node.`,
        path: ['edges', i, 'source'],
      });
    }
    if (!targetNode) {
      issues.push({
        message: `Edge ${i}: target "${edge.target}" does not reference an existing node.`,
        path: ['edges', i, 'target'],
      });
    }

    if (sourceNode) {
      const spec = NODE_HANDLES[sourceNode.type];
      if (spec && !spec.sourceHandles.includes(edge.sourceHandle)) {
        issues.push({
          message:
            `Edge ${i}: "${edge.sourceHandle}" is not a valid output handle for node type `
            + `"${sourceNode.type}" (expected one of: ${spec.sourceHandles.join(', ') || '<none>'}).`,
          path: ['edges', i, 'sourceHandle'],
        });
      }
    }
    if (targetNode) {
      const spec = NODE_HANDLES[targetNode.type];
      if (spec && !spec.targetHandles.includes(edge.targetHandle)) {
        issues.push({
          message:
            `Edge ${i}: "${edge.targetHandle}" is not a valid input handle for node type `
            + `"${targetNode.type}" (expected one of: ${spec.targetHandles.join(', ') || '<none>'}).`,
          path: ['edges', i, 'targetHandle'],
        });
      }
    }
  });

  return issues;
}
