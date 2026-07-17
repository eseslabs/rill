import type { Edge, Node } from "reactflow";
import type { ActionNodeData, GuardrailNodeData } from "@/components/flow/nodes";
import { actionAmountError, TOKEN_COIN_TYPE, type SwapTokenSymbol } from "@/lib/action-config";
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
    (n) => n.type === "guardrail" && !isGuardrailMinValueValid((n.data as GuardrailNodeData).minValue),
  );
}

function isCetusSwapAction(data: ActionNodeData): boolean {
  return data.protocolId === "cetus" && data.action.toLowerCase().includes("swap");
}

function isHaedalStakeAction(data: ActionNodeData): boolean {
  return data.protocolId === "haedal" && data.action.toLowerCase().includes("stake");
}

/** Coin type an action node's `amount` field is denominated in, for R5 amount validation —
 *  mirrors the detection nodes.tsx itself uses to render the field. `null` for action kinds not
 *  validated here (e.g. DeepBook, which takes raw price/quantity strings, not one converted
 *  amount). */
function actionAmountCoinType(data: ActionNodeData): string | null {
  if (isCetusSwapAction(data)) {
    const tokenIn = (data.config?.tokenIn as SwapTokenSymbol) || "SUI";
    return TOKEN_COIN_TYPE[tokenIn] ?? TOKEN_COIN_TYPE.SUI;
  }
  if (isHaedalStakeAction(data)) {
    return TOKEN_COIN_TYPE.SUI;
  }
  return null;
}

export type InvalidAmountNode = { node: Node; error: string };

/** R5: no silent fallback — an invalid/non-positive/over-precision amount blocks simulate and
 *  publish instead of being converted to a fallback base-unit amount. Same predicate
 *  (`actionAmountError`, action-config.ts) drives the node's own inline field error. */
export function invalidAmountNodes(nodes: Node[]): InvalidAmountNode[] {
  const result: InvalidAmountNode[] = [];
  for (const n of nodes) {
    if (n.type !== "action") continue;
    const data = n.data as ActionNodeData;
    const coinType = actionAmountCoinType(data);
    if (!coinType) continue;
    const error = actionAmountError(data.config?.amount, coinType);
    if (error) result.push({ node: n, error });
  }
  return result;
}

/** Names the node/protocol in the reason so an invalid-amount node that's off-screen on a
 *  multi-node canvas is still discoverable from the blocking message. Panning/selecting the
 *  canvas to the node is a follow-up — not built this sweep. */
export function amountGateReason(nodes: Node[]): string | null {
  const bad = invalidAmountNodes(nodes);
  if (bad.length === 0) return null;
  if (bad.length === 1) {
    const data = bad[0].node.data as ActionNodeData;
    return `${data.protocol} · ${data.action}: ${bad[0].error}`;
  }
  return `${bad.length} nodes have an invalid amount — fix before simulating or publishing.`;
}

/** Blocks BOTH simulate and publish. Covers two independent no-op-guard/no-silent-fallback
 *  cases: an unset/non-positive guardrail `minValue` (R1) and an invalid/non-positive action
 *  amount (R5). Kept under its original name — simulate-dialog.tsx and `computePublishGate`
 *  both already call this single function, so broadening it here covers both call sites without
 *  touching either. */
export function guardrailGateReason(nodes: Node[]): string | null {
  const amountReason = amountGateReason(nodes);
  if (amountReason) return amountReason;

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
