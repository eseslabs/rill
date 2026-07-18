import type { Edge, Node } from "reactflow";
import type { ActionNodeData, GuardrailNodeData } from "@/components/flow/nodes";
import { isBackendSupported } from "@/lib/flow-mapper";
import { hasCycle } from "@/lib/wire-inference";

/**
 * Single source of truth for "what actually publishes today" vs "what only
 * simulates." Both the builder's up-front gate copy and the simulate dialog's
 * capability copy read from here so the two surfaces can't drift apart again —
 * the simulate dialog used to claim "Cetus swap + Haedal stake only," which
 * omitted DeepBook (which does simulate).
 */
export const SIMULATE_SUPPORTED_LABEL = "Cetus swap, Haedal stake, or DeepBook limit order";
export const PUBLISH_SUPPORTED_LABEL = "exactly one DeepBook limit order";

export const CAPABILITY_COPY = {
  simulateEmpty: `Add a ${SIMULATE_SUPPORTED_LABEL} node to simulate.`,
  simulateSkipped: (skipped: string[]) =>
    `Only ${SIMULATE_SUPPORTED_LABEL} actions simulate today. Skipped: ${skipped.join(", ")}`,
  publishScope: `Publish supports ${PUBLISH_SUPPORTED_LABEL} today — Cetus swap and Haedal stake simulate but can't publish yet.`,
} as const;

function isDeepbookLimitOrder(data: ActionNodeData): boolean {
  return data.protocolId === "deepbook" && data.action.toLowerCase().includes("limit");
}

/** A guardrail with an unset or non-positive minValue enforces nothing — R1: no
 *  silent no-op guards. This is the single predicate both the inline node error
 *  (nodes.tsx) and the flow-level simulate/publish gates check. */
export function isGuardrailMinValueValid(minValue: string | undefined): boolean {
  const raw = (minValue ?? "").trim();
  if (raw === "") return false;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0;
}

export function invalidGuardrailNodes(nodes: Node[]): Node[] {
  return nodes.filter(
    (n) =>
      n.type === "guardrail" && !isGuardrailMinValueValid((n.data as GuardrailNodeData).minValue),
  );
}

/** Blocks BOTH simulate and publish on an unset/non-positive guardrail `minValue` (R1: no
 *  silent no-op guards). Part B removed the amount-required gate that used to live here too —
 *  action-node amounts are no longer canvas-editable (the agent supplies the real amount at
 *  runtime via MCP, bounded by capabilities), so there is nothing left on a node to be "invalid."
 *  Kept under its original name — simulate-dialog.tsx and `computePublishGate` both already call
 *  this single function. */
export function guardrailGateReason(nodes: Node[]): string | null {
  const bad = invalidGuardrailNodes(nodes);
  if (bad.length === 0) return null;
  return bad.length === 1
    ? "Set a guardrail minimum value greater than 0 before simulating or publishing — an unset guardrail enforces nothing."
    : `Set a minimum value greater than 0 on all ${bad.length} guardrail nodes before simulating or publishing.`;
}

export type PublishGateResult = { publishable: boolean; reason: string | null };

/** Up-front, truthful publish eligibility computed straight from canvas state —
 *  the builder can render this before the user ever clicks publish, instead of
 *  discovering ineligibility only after a failed API call. */
export function computePublishGate(nodes: Node[], edges: Edge[]): PublishGateResult {
  const guardrailReason = guardrailGateReason(nodes);
  if (guardrailReason) return { publishable: false, reason: guardrailReason };

  if (hasCycle(edges)) {
    return { publishable: false, reason: "This flow has a cycle — remove it before publishing." };
  }

  const actionNodes = nodes.filter((n) => n.type === "action");
  const deepbookNodes = actionNodes.filter((n) => isDeepbookLimitOrder(n.data as ActionNodeData));
  const allSupported = actionNodes.every((n) => isBackendSupported(n.data as ActionNodeData));

  if (actionNodes.length !== 1 || deepbookNodes.length !== 1 || !allSupported) {
    return { publishable: false, reason: CAPABILITY_COPY.publishScope };
  }

  return { publishable: true, reason: null };
}
