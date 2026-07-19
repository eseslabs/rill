import type { Edge, Node } from "reactflow";
import type { LucideIcon } from "lucide-react";
import { ArrowLeftRight, ListOrdered, PiggyBank, ShieldCheck, Workflow } from "lucide-react";
import type { ActionNodeData } from "@/components/flow/nodes";
import { PROTOCOLS } from "@/lib/protocols";
import { defaultActionConfig, type ActionConfig } from "@/lib/action-config";
import { getActionPorts } from "@/lib/action-ports";
import { inferWireKind, WIRE_IN, WIRE_OUT, type WireKind } from "@/lib/wire-inference";
import {
  assetScopeRule,
  budgetRule,
  perTxRule,
  rateLimitRule,
  recipientAllowlistRule,
  slippageFloorRule,
  timeWindowRule,
  type CapabilityManifest,
  type CapabilityRule,
} from "@/lib/capabilities";

/**
 * FLOW-ONLY preset canvases for the "Start from a template" gallery
 * (template-dialog.tsx). Deliberately mirrors the exact node/edge shapes
 * Builder itself constructs (buildActionData/addAction in routes/builder.tsx
 * and the onConnect edge shape) so a template-built canvas is indistinguishable
 * from one a user assembled by hand — it renders, wires, simulates, and (where
 * the underlying actions are backend-supported) publishes exactly the same way.
 *
 * Part C: each template also ships an optional, schema-valid `manifest` — a suggested
 * wallet-level CapabilityManifest bundled via `lib/capabilities.ts`'s rule builders.
 * `applyTemplate` (routes/builder.tsx) sets it as the canvas's manifest when the template is
 * picked, so the owner starts from a sensible cap set instead of an empty (schema-invalid, KTD-6)
 * one — they can still open Capabilities and tune or replace it before onboarding.
 */

/** Every template manifest targets native SUI — the only coin the composer offers a switcher for
 *  today (mirrors `lib/capabilities.ts`'s `emptyManifest` default). */
const WALLET_COIN_TYPE = "0x2::sui::SUI";

function manifestOf(...rules: CapabilityRule[]): CapabilityManifest {
  return { walletCoinType: WALLET_COIN_TYPE, rules };
}

/** Obviously-a-placeholder recipient (64 hex chars, ends in `1`) for the DeepBook template's
 *  `recipient_allowlist` — the owner MUST replace this with a real address before onboarding; it
 *  is schema-valid (so the manifest previews cleanly) but not a usable destination. */
const PLACEHOLDER_RECIPIENT = `0x${"0".repeat(63)}1`;

/** Baked in at module-eval time (effectively page-load time for this SPA) — a reasonable window
 *  for a template preset the owner reviews/tunes before onboarding, not a live countdown. */
const now = Date.now();
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function findAction(protocolId: string, actionId: string) {
  const protocol = PROTOCOLS.find((p) => p.id === protocolId);
  const action = protocol?.actions.find((a) => a.id === actionId);
  if (!protocol || !action) {
    throw new Error(`flow-templates: unknown protocol/action ${protocolId}/${actionId}`);
  }
  return { protocol, action };
}

/** Same shape Builder's `buildActionData` constructs when a library action is
 *  added to the canvas — `configOverride` lets a template seed non-default
 *  values (e.g. a swap pre-wired to output SUI) without hand-rolling the rest
 *  of the node data. */
function actionNodeData(
  protocolId: string,
  actionId: string,
  configOverride?: ActionConfig,
): ActionNodeData {
  const { protocol, action } = findAction(protocolId, actionId);
  return {
    protocol: protocol.name,
    protocolId: protocol.id,
    actionId: action.id,
    action: action.name,
    description: action.description,
    color: protocol.color,
    inputs: action.inputs,
    config: { ...defaultActionConfig(protocol.id, action.id), ...configOverride },
    ports: getActionPorts(protocol.id, action.id),
  };
}

function actionNode(
  id: string,
  protocolId: string,
  actionId: string,
  position: { x: number; y: number },
  configOverride?: ActionConfig,
): Node {
  return {
    id,
    type: "action",
    position,
    data: actionNodeData(protocolId, actionId, configOverride),
  } as Node;
}

/** Same edge shape Builder's `onConnect` constructs for a drawn wire — the
 *  wire kind (coin vs flow) is derived from the endpoint node pair via
 *  `inferWireKind`, exactly like the canvas does for a hand-drawn connection,
 *  so a template edge renders (solid/dashed, animated) identically to one the
 *  user drew themselves. */
export function connectEdge(id: string, source: Node, target: Node): Edge {
  const wireKind: WireKind = inferWireKind(source, target);
  return {
    id,
    source: source.id,
    target: target.id,
    sourceHandle: WIRE_OUT,
    targetHandle: WIRE_IN,
    type: "deletable",
    animated: wireKind === "flow",
    className: wireKind === "coin" ? "coin-edge" : "flow-edge",
    data: { wireKind },
  };
}

export type FlowTemplateBuild = { nodes: Node[]; edges: Edge[] };

export type FlowTemplate = {
  id: string;
  name: string;
  description: string;
  /** Card icon (template-dialog.tsx) — one glance identifies the template's shape before reading
   *  the description. */
  icon: LucideIcon;
  /** Ordered protocol ids this template's action nodes touch, e.g. `["cetus","haedal"]` — drives
   *  the step-preview row of protocol icons/labels on the gallery card. */
  steps: string[];
  /** Suggested wallet-level CapabilityManifest — schema-valid, built from `lib/capabilities.ts`'s
   *  rule builders. `applyTemplate` (routes/builder.tsx) sets this as the canvas's manifest when
   *  the template is picked; `undefined` falls back to `emptyManifest()`. */
  manifest?: CapabilityManifest;
  /** `makeId` mints a fresh, canvas-unique node id (Builder passes its
   *  `n_${idRef.current++}` counter) — every node this returns MUST come from
   *  it, so a template drop never collides with ids already on the canvas. */
  build: (makeId: () => string) => FlowTemplateBuild;
};

// Part D: BASE_X sits well right of the mandatory Trigger scaffold node (routes/builder.tsx's
// `initialNodes`, x:40, ~228px wide) so a freshly-applied template never stacks its first action
// node on top of the Trigger — Trigger -> action(s) -> Output reads left-to-right with no overlap.
// STEP_X is comfortably wider than the widest action-node card renders (measured: Cetus swap
// ~371px, DeepBook limit order ~449px, both since Part A's per-swap "Min swap output" field and
// existing multi-field cards grew node height/width) — that alone guarantees adjacent template
// nodes never overlap horizontally, regardless of the y stagger below.
//
// Output stays wherever the canvas already has it (applyTemplate, routes/builder.tsx) — by
// default `initialNodes`' y:200, height ~213 (so occupying roughly y:[200,413]) — rather than
// being pushed dynamically. A multi-node template's LAST node (odd i) sits close enough in x to
// possibly reach Output's x-range too (e.g. swap-stake's Haedal node), so STAGGER_Y has to clear
// that y-band on its own: 400 puts an odd-index node's top at 540, well below 413.
const BASE_X = 360;
const STEP_X = 480;
const BASE_Y = 140;
const STAGGER_Y = 400;

/** Spread-out position for the i-th node of a template (x steps of ~480, staggered y so
 *  multi-node templates don't render in a dead-straight row — and so a template's last node,
 *  which may sit x-adjacent to the canvas's existing Output node, never y-overlaps it either). */
function slot(i: number): { x: number; y: number } {
  return { x: BASE_X + i * STEP_X, y: BASE_Y + (i % 2) * STAGGER_Y };
}

export const FLOW_TEMPLATES: FlowTemplate[] = [
  {
    id: "swap",
    name: "Swap",
    description: "A single Cetus swap — trade SUI for USDC.",
    icon: ArrowLeftRight,
    steps: ["cetus"],
    manifest: manifestOf(budgetRule("5"), slippageFloorRule("0.05")),
    build: (makeId) => ({
      nodes: [actionNode(makeId(), "cetus", "swap", slot(0))],
      edges: [],
    }),
  },
  {
    id: "stake",
    name: "Stake",
    description: "A single Haedal stake — stake SUI and mint haSUI.",
    icon: PiggyBank,
    steps: ["haedal"],
    manifest: manifestOf(
      budgetRule("20"),
      perTxRule("5"),
      timeWindowRule(new Date(now).toISOString(), new Date(now + THIRTY_DAYS_MS).toISOString()),
    ),
    build: (makeId) => ({
      nodes: [actionNode(makeId(), "haedal", "stake", slot(0))],
      edges: [],
    }),
  },
  {
    id: "swap-stake",
    name: "Swap → Stake",
    description: "Swap USDC for SUI, then stake the output with Haedal in one coin chain.",
    icon: Workflow,
    steps: ["cetus", "haedal"],
    manifest: manifestOf(budgetRule("10"), rateLimitRule("2", "3600000")),
    build: (makeId) => {
      const swap = actionNode(makeId(), "cetus", "swap", slot(0), {
        tokenIn: "USDC",
        tokenOut: "SUI",
        amount: "0.1",
      });
      const stake = actionNode(makeId(), "haedal", "stake", slot(1), { amount: "0.1" });
      return {
        nodes: [swap, stake],
        edges: [connectEdge(makeId(), swap, stake)],
      };
    },
  },
  {
    id: "deepbook-limit-order",
    name: "DeepBook limit order",
    description: "A single DeepBook limit order against a pre-funded BalanceManager.",
    icon: ListOrdered,
    steps: ["deepbook"],
    manifest: manifestOf(budgetRule("15"), recipientAllowlistRule(PLACEHOLDER_RECIPIENT)),
    build: (makeId) => ({
      nodes: [actionNode(makeId(), "deepbook", "limit_order", slot(0))],
      edges: [],
    }),
  },
  {
    id: "guarded-swap",
    name: "Guarded swap",
    description:
      "A Cetus swap bounded by a wallet-level slippage floor (min swap output) plus an asset scope — set once in Capabilities, enforced on every swap.",
    icon: ShieldCheck,
    steps: ["cetus"],
    manifest: manifestOf(
      budgetRule("5"),
      slippageFloorRule("0.05"),
      assetScopeRule(WALLET_COIN_TYPE),
    ),
    build: (makeId) => ({
      nodes: [actionNode(makeId(), "cetus", "swap", slot(0), { min_amount_out: "0.05" })],
      edges: [],
    }),
  },
];
