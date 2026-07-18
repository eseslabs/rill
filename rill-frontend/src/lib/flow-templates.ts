import type { Edge, Node } from "reactflow";
import type { ActionNodeData, GuardrailNodeData } from "@/components/flow/nodes";
import { PROTOCOLS } from "@/lib/protocols";
import { defaultActionConfig, type ActionConfig } from "@/lib/action-config";
import { getActionPorts } from "@/lib/action-ports";
import { inferWireKind, WIRE_IN, WIRE_OUT, type WireKind } from "@/lib/wire-inference";

/**
 * FLOW-ONLY preset canvases for the "Start from a template" gallery
 * (template-dialog.tsx). Deliberately mirrors the exact node/edge shapes
 * Builder itself constructs (buildActionData/addAction in routes/builder.tsx,
 * addGuardrail, and the onConnect edge shape) so a template-built canvas is
 * indistinguishable from one a user assembled by hand — it renders, wires,
 * simulates, and (where the underlying actions are backend-supported)
 * publishes exactly the same way. No capabilities/manifest here — that's a
 * later phase.
 */

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

/** Same checklist labels `addGuardrail` (routes/builder.tsx) seeds a new
 *  guardrail node with — cosmetic only (see DEFAULT_GUARDRAILS doc comment
 *  there); the actually-enforced fields are `minValue`/`coinType` below. */
function guardrailNode(id: string, position: { x: number; y: number }, minValue: string): Node {
  const data: GuardrailNodeData = {
    rules: [
      { id: "max_in", label: "Max amount_in ≤ 100 SUI" },
      { id: "slippage", label: "Slippage ≤ 1.0%" },
      { id: "ttl", label: "Deadline within 60s" },
      { id: "dry_run", label: "Require successful dry-run" },
    ],
    minValue,
    coinType: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
  };
  return { id, type: "guardrail", position, data } as Node;
}

/** Same edge shape Builder's `onConnect` constructs for a drawn wire — the
 *  wire kind (coin vs flow) is derived from the endpoint node pair via
 *  `inferWireKind`, exactly like the canvas does for a hand-drawn connection,
 *  so a template edge renders (solid/dashed, animated) identically to one the
 *  user drew themselves. */
function connectEdge(id: string, source: Node, target: Node): Edge {
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
  tags?: string[];
  /** `makeId` mints a fresh, canvas-unique node id (Builder passes its
   *  `n_${idRef.current++}` counter) — every node this returns MUST come from
   *  it, so a template drop never collides with ids already on the canvas. */
  build: (makeId: () => string) => FlowTemplateBuild;
};

const BASE_X = 80;
const STEP_X = 360;
const BASE_Y = 140;
const STAGGER_Y = 90;

/** Spread-out position for the i-th node of a template (x steps of ~360,
 *  staggered y so multi-node templates don't render in a dead-straight row). */
function slot(i: number): { x: number; y: number } {
  return { x: BASE_X + i * STEP_X, y: BASE_Y + (i % 2) * STAGGER_Y };
}

export const FLOW_TEMPLATES: FlowTemplate[] = [
  {
    id: "swap",
    name: "Swap",
    description: "A single Cetus swap — trade SUI for USDC.",
    tags: ["Cetus", "DEX"],
    build: (makeId) => ({
      nodes: [actionNode(makeId(), "cetus", "swap", slot(0))],
      edges: [],
    }),
  },
  {
    id: "stake",
    name: "Stake",
    description: "A single Haedal stake — stake SUI and mint haSUI.",
    tags: ["Haedal", "Staking"],
    build: (makeId) => ({
      nodes: [actionNode(makeId(), "haedal", "stake", slot(0))],
      edges: [],
    }),
  },
  {
    id: "swap-stake",
    name: "Swap → Stake",
    description: "Swap USDC for SUI, then stake the output with Haedal in one coin chain.",
    tags: ["Cetus", "Haedal"],
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
    tags: ["DeepBook", "DEX"],
    build: (makeId) => ({
      nodes: [actionNode(makeId(), "deepbook", "limit_order", slot(0))],
      edges: [],
    }),
  },
  {
    id: "guarded-swap",
    name: "Guarded swap",
    description: "A Cetus swap with a guardrail enforcing a minimum output value.",
    tags: ["Cetus", "Guardrail"],
    build: (makeId) => {
      const swap = actionNode(makeId(), "cetus", "swap", slot(0));
      const guardrail = guardrailNode(makeId(), slot(1), "0.05");
      return {
        nodes: [swap, guardrail],
        edges: [connectEdge(makeId(), swap, guardrail)],
      };
    },
  },
];
