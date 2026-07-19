import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type OnConnectStartParams,
  ReactFlowProvider,
  useReactFlow,
} from "reactflow";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  Search,
  Download,
  Play,
  ChevronRight,
  ScanSearch,
  ShieldCheck,
  Layers,
  LayoutTemplate,
  LayoutGrid,
  HelpCircle,
  PanelLeft,
  PanelLeftClose,
} from "lucide-react";
import { SiteHeader } from "@/components/site-chrome";
import {
  ActionNode,
  TriggerNode,
  OutputNode,
  CapabilitiesNode,
  PtbNode,
  GuardrailNode,
  type ActionNodeData,
} from "@/components/flow/nodes";
import { PROTOCOLS, BACKEND_PROTOCOL_IDS, type Protocol } from "@/lib/protocols";
import { DiscoverDialog } from "@/components/flow/discover-dialog";
import { ExportDialog } from "@/components/flow/export-dialog";
import { TemplateDialog } from "@/components/flow/template-dialog";
import { ProtocolLogo } from "@/components/flow/protocol-logo";
import { DeletableEdge } from "@/components/flow/deletable-edge";
import { SimulateDialog } from "@/components/flow/simulate-dialog";
import { CapabilitiesDialog } from "@/components/flow/capabilities-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { applyWireConstraints } from "@/lib/flow-mapper";
import {
  inferWireKindFromConnection,
  isValidWireConnection,
  WIRE_IN,
  WIRE_OUT,
} from "@/lib/wire-inference";
import { computePublishGate } from "@/lib/publish-gate";
import { applyProtocolRegistry, defaultActionConfig } from "@/lib/action-config";
import { getActionPorts } from "@/lib/action-ports";
import { FLOW_TEMPLATES, connectEdge } from "@/lib/flow-templates";
import { computeAutoLayout } from "@/lib/auto-layout";
import { rillApi } from "@/lib/rill-api";
import { loadDraftFromStorage, saveDraftToStorage, maxNodeId } from "@/lib/draft-storage";
import { emptyManifest, type CapabilityManifest } from "@/lib/capabilities";
import { ManifestContext } from "@/lib/manifest-context";
import { OpenCapabilitiesContext } from "@/lib/open-capabilities-context";
import type { DiscoveredFunction, IntrospectionResult } from "@/lib/rill-types";

export const Route = createFileRoute("/builder")({
  component: BuilderPage,
});

const nodeTypes = {
  action: ActionNode,
  trigger: TriggerNode,
  output: OutputNode,
  capabilities: CapabilitiesNode,
  ptb: PtbNode,
  guardrail: GuardrailNode,
};

const edgeTypes = {
  default: DeletableEdge,
  deletable: DeletableEdge,
};

const TRIGGER_NODE: Node = {
  id: "trigger",
  type: "trigger",
  position: { x: 40, y: 200 },
  data: { label: "Agent prompt", sub: "Describe the goal" },
};
// The global wallet caps live in ONE inline card the flow runs THROUGH — Trigger → Capabilities →
// actions → Output — so the canvas reads as "every action passes the capability gate." It carries
// real flow-in/flow-out handles like any node, but is mandatory scaffolding (can't be deleted), and
// its edges are canvas-only annotations the compiler ignores (same as Trigger/Output edges).
const CAPABILITIES_NODE: Node = {
  id: "capabilities",
  type: "capabilities",
  position: { x: 360, y: 200 },
  data: {},
  deletable: false,
};
const OUTPUT_NODE: Node = {
  id: "output",
  type: "output",
  position: { x: 720, y: 200 },
  data: { label: "MCP Server", sub: "Auto-generated" },
};
const initialNodes: Node[] = [TRIGGER_NODE, CAPABILITIES_NODE, OUTPUT_NODE];

/** A dashed canvas-sequence edge (Trigger→Capabilities, Capabilities→Output, …) in the exact shape
 *  `onConnect` builds for a hand-drawn flow wire. */
function flowEdge(id: string, source: string, target: string): Edge {
  return {
    id,
    source,
    target,
    sourceHandle: WIRE_OUT,
    targetHandle: WIRE_IN,
    type: "deletable",
    animated: true,
    className: "flow-edge",
    data: { wireKind: "flow" },
  };
}
// Starter canvas is already a connected chain THROUGH the caps gate — no floating nodes to wire.
const initialEdges: Edge[] = [
  flowEdge("e_trigger_capabilities", "trigger", "capabilities"),
  flowEdge("e_capabilities_output", "capabilities", "output"),
];

const easeOut = [0.22, 1, 0.36, 1] as const;

// Part C: sidebar resize clamp (px).
const MIN_SIDEBAR_WIDTH = 260;
const MAX_SIDEBAR_WIDTH = 480;

function BuilderPage() {
  return (
    <ReactFlowProvider>
      <Builder />
    </ReactFlowProvider>
  );
}

function Builder() {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [search, setSearch] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [simulateOpen, setSimulateOpen] = useState(false);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  // Wallet-level CapabilityManifest (U7) — composed in the Capabilities dialog, persisted
  // alongside nodes/edges below. Deliberately NOT wired into /simulate or /publish yet (next
  // phase); this phase is compose + honest live preview + persist only.
  const [manifest, setManifest] = useState<CapabilityManifest>(() => emptyManifest());
  // Part C: sidebar collapse/width are pure UI state — not persisted to the draft (component
  // state is enough; nothing about a canvas's meaning depends on how wide the library panel was).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const idRef = useRef(1);
  const { screenToFlowPosition, fitView } = useReactFlow();

  // "Latest ref" pattern (see lib/use-flow-request.ts) — kept current on every
  // render so the beforeunload listener below can read live canvas state
  // without re-registering itself on every node/edge change.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  useEffect(() => {
    rillApi
      .protocols()
      .then(applyProtocolRegistry)
      .catch(() => {
        /* bundled TESTNET_MANIFEST is fallback */
      });
  }, []);

  // Restore-on-mount (R16): a valid autosaved draft replaces the default
  // trigger/output starter canvas and seeds idRef past the highest restored
  // node id so newly-created nodes never collide with a restored one. A
  // corrupt/mismatched draft (deserializeDraft returned null) is discarded —
  // the canvas simply stays at its default — and surfaced once via toast,
  // never as a crash.
  useEffect(() => {
    const result = loadDraftFromStorage();
    if (result.status === "restored") {
      // A draft saved before the standalone Capabilities card existed won't contain it — inject the
      // mandatory card at the head so restoring an older draft never drops the global-caps affordance.
      const restored = result.draft.nodes.some((n) => n.type === "capabilities")
        ? result.draft.nodes
        : [CAPABILITIES_NODE, ...result.draft.nodes];
      setNodes(restored);
      setEdges(result.draft.edges);
      setManifest(result.draft.manifest);
      idRef.current = maxNodeId(result.draft.nodes) + 1;
    } else if (result.status === "corrupt") {
      toast.error("Previous draft couldn't be restored");
    }
  }, []);

  // Debounced autosave (R16): waits for a ~800ms pause in canvas activity
  // (drags, wiring, node adds, capability-manifest edits) before persisting,
  // so continuous in-flight changes don't hammer localStorage on every
  // intermediate frame. Standard effect-cleanup debounce — each
  // nodes/edges/manifest change clears the previous pending save and
  // schedules a fresh one.
  useEffect(() => {
    const timer = setTimeout(() => {
      saveDraftToStorage(nodes, edges, manifest);
    }, 800);
    return () => clearTimeout(timer);
  }, [nodes, edges, manifest]);

  // Warn on tab close/reload once the canvas has diverged from the default
  // trigger->output starter graph (R16) — registered once and reads live
  // state via nodesRef/edgesRef rather than re-subscribing on every edit.
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      // Only real action/guardrail work counts — the Trigger→Capabilities→Output scaffold (nodes and
      // their edges) is always present, so it must not trigger the unsaved-work prompt.
      const hasContent = nodesRef.current.some(
        (n) => n.type !== "trigger" && n.type !== "output" && n.type !== "capabilities",
      );
      if (!hasContent) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  const onConnect = useCallback(
    (c: Connection) => {
      const wireKind = inferWireKindFromConnection(c, nodes);
      setEdges((es) =>
        addEdge(
          {
            ...c,
            sourceHandle: c.sourceHandle ?? WIRE_OUT,
            targetHandle: c.targetHandle ?? WIRE_IN,
            type: "deletable",
            animated: wireKind === "flow",
            className: wireKind === "coin" ? "coin-edge" : "flow-edge",
            data: { wireKind },
          },
          es,
        ),
      );
    },
    [setEdges, nodes],
  );

  const isValidConnection = useCallback(
    (c: Connection) => isValidWireConnection(c, nodes, edges).valid,
    [nodes, edges],
  );

  // ReactFlow's isValidConnection only returns a boolean (nothing tells the app
  // *why* a dropped connection didn't attach), so a rejected drag is re-validated
  // here from the raw DOM handle attributes ReactFlow itself stamps on each
  // handle element, purely to recover the reason for a toast.
  const connectStartRef = useRef<OnConnectStartParams | null>(null);

  const onConnectStart = useCallback((_event: unknown, params: OnConnectStartParams) => {
    connectStartRef.current = params;
  }, []);

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
      const start = connectStartRef.current;
      connectStartRef.current = null;
      if (!start?.nodeId) return;

      const targetEl = event.target as HTMLElement | null;
      const handleEl = targetEl?.closest?.(".react-flow__handle") as HTMLElement | null;
      if (!handleEl) return; // dropped on empty canvas — not a rejected node-to-node attempt

      const otherNodeId = handleEl.getAttribute("data-nodeid");
      const otherHandleId = handleEl.getAttribute("data-handleid");
      if (!otherNodeId || otherNodeId === start.nodeId) return;

      const connection: Connection =
        start.handleType === "source"
          ? {
              source: start.nodeId,
              sourceHandle: start.handleId,
              target: otherNodeId,
              targetHandle: otherHandleId,
            }
          : {
              source: otherNodeId,
              sourceHandle: otherHandleId,
              target: start.nodeId,
              targetHandle: start.handleId,
            };

      const validation = isValidWireConnection(connection, nodes, edges);
      if (!validation.valid && validation.reason) {
        toast.error(validation.reason);
      }
    },
    [nodes, edges],
  );

  const publishGate = useMemo(() => computePublishGate(nodes, edges), [nodes, edges]);

  // Applies applyWireConstraints' change list to real canvas state (setNodes) and
  // explains what changed and why — the compiled output was already self-correcting
  // (buildFlowGraph applies the same list to its own internal copy), this is purely
  // about making the correction visible instead of silent. A no-op when the canvas
  // already matches (empty change list), so reopening a conformant flow stays quiet.
  const applyWireCorrections = useCallback(() => {
    const changes = applyWireConstraints(nodes, edges);
    if (changes.length === 0) return;

    setNodes((nds) =>
      nds.map((n) => {
        const nodeChanges = changes.filter((c) => c.nodeId === n.id);
        if (nodeChanges.length === 0) return n;
        const data = n.data as ActionNodeData;
        const patchedConfig = { ...(data.config ?? {}) };
        for (const c of nodeChanges) patchedConfig[c.field] = c.to;
        return { ...n, data: { ...data, config: patchedConfig } };
      }),
    );

    const reasons = Array.from(new Set(changes.map((c) => c.reason)));
    reasons.forEach((reason) => toast.warning(reason));
  }, [nodes, edges, setNodes]);

  const openSimulate = useCallback(() => {
    applyWireCorrections();
    setSimulateOpen(true);
  }, [applyWireCorrections]);

  const openExport = useCallback(() => {
    if (!publishGate.publishable) {
      if (publishGate.reason) toast.error(publishGate.reason);
      return;
    }
    applyWireCorrections();
    setExportOpen(true);
  }, [publishGate, applyWireCorrections]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const supported = PROTOCOLS.filter((p) => BACKEND_PROTOCOL_IDS.has(p.id))
      .sort((a, b) => (a.id === "cetus" ? -1 : b.id === "cetus" ? 1 : 0))
      .map((p) => ({
        ...p,
        actions: p.actions.filter(
          (a) =>
            (p.id === "cetus" && a.id === "swap") ||
            (p.id === "haedal" && a.id === "stake") ||
            (p.id === "deepbook" && a.id === "limit_order"),
        ),
      }));

    if (!q) return supported;

    return supported
      .map((p) => ({
        ...p,
        actions: p.actions.filter(
          (a) =>
            a.name.toLowerCase().includes(q) ||
            p.name.toLowerCase().includes(q) ||
            p.category.toLowerCase().includes(q),
        ),
      }))
      .filter((p) => p.actions.length > 0);
  }, [search]);

  const buildActionData = (p: Protocol, action: (typeof p.actions)[number]): ActionNodeData => ({
    protocol: p.name,
    protocolId: p.id,
    actionId: action.id,
    action: action.name,
    description: action.description,
    color: p.color,
    inputs: action.inputs,
    config: defaultActionConfig(p.id, action.id),
    ports: getActionPorts(p.id, action.id),
  });

  const addAction = useCallback(
    (p: Protocol, actionId: string) => {
      const action = p.actions.find((a) => a.id === actionId);
      if (!action) return;
      const id = `n_${idRef.current++}`;
      const data = buildActionData(p, action);
      const pos = screenToFlowPosition({
        x: 280 + Math.random() * 60,
        y: 120 + Math.random() * 120,
      });
      setNodes((nds) => nds.concat({ id, type: "action", position: pos, data } as Node));
    },
    [screenToFlowPosition, setNodes],
  );

  const importDiscovered = useCallback(
    (fns: DiscoveredFunction[], meta: IntrospectionResult) => {
      const baseX = 320;
      const baseY = 80;
      const newNodes: Node[] = fns.map((f, i) => {
        const id = `n_${idRef.current++}`;
        const data: ActionNodeData = {
          protocol: meta.protocol,
          protocolId:
            meta.source.kind === "protocol" ? meta.source.value : meta.protocol.toLowerCase(),
          action: f.name,
          description: f.description,
          color: f.color,
          inputs: f.inputs.map((p) => ({ key: p.key, label: p.label, type: p.type })),
          ports: { inputs: f.inputs, outputs: f.outputs },
          discovered: true,
          module: f.module,
        };
        return {
          id,
          type: "action",
          position: { x: baseX + (i % 2) * 340, y: baseY + Math.floor(i / 2) * 260 },
          data,
        } as Node;
      });
      setNodes((nds) => nds.concat(newNodes));
    },
    [setNodes],
  );

  // Same `n_${idRef.current++}` scheme every add*/import path already uses —
  // shared so a template-built node id can never collide with a hand-added one.
  const makeId = useCallback(() => `n_${idRef.current++}`, []);

  // Template gallery (FLOW-ONLY presets, template-dialog.tsx / lib/flow-templates.ts):
  // replaces the ACTION nodes/edges with the chosen preset while ALWAYS keeping the
  // mandatory Trigger + Output scaffolding (see below). Confirms first if the canvas
  // already has content so a template never silently wipes in-progress
  // work (mirrors the beforeunload "hasContent" check). Part C: also replaces the
  // wallet-level manifest with the template's suggested preset (or an empty one if the
  // template doesn't ship one), so picking a template seeds both canvas AND capabilities
  // in one step.
  const applyTemplate = useCallback(
    (templateId: string) => {
      const template = FLOW_TEMPLATES.find((t) => t.id === templateId);
      if (!template) return;
      // Capabilities/Trigger/Output are all mandatory scaffolding, so they don't count as "content"
      // when deciding whether a template would clobber real work.
      const isScaffold = (n: Node) =>
        n.type === "trigger" || n.type === "output" || n.type === "capabilities";
      // Only real action/guardrail work counts as content — the starter canvas is already a wired
      // Trigger→Capabilities→Output chain, so scaffold edges must NOT trigger the replace confirm.
      const hasContent = nodesRef.current.some((n) => !isScaffold(n));
      if (hasContent && !window.confirm("Replace the current flow with this template?")) return;
      const built = template.build(makeId);
      // Capabilities + Trigger + Output are MANDATORY scaffolding on every flow — a template swaps
      // the action nodes/edges but must never wipe them. Keep the current ones (preserving any
      // position the user moved them to), falling back to the defaults if one was removed.
      const capabilities =
        nodesRef.current.find((n) => n.type === "capabilities") ?? CAPABILITIES_NODE;
      const trigger = nodesRef.current.find((n) => n.type === "trigger") ?? TRIGGER_NODE;
      const output = nodesRef.current.find((n) => n.type === "output") ?? OUTPUT_NODE;
      // Auto-wire the FULL flow THROUGH the caps gate: Trigger → Capabilities → entry node(s), and
      // exit node(s) → Output, so a template drops a complete, connected canvas — never floating
      // nodes the user has to wire by hand. Entry = a template node with no incoming template edge;
      // exit = one with no outgoing edge (a single-node template is both). `connectEdge` derives the
      // wire kind exactly like a hand-drawn wire, so these read as normal flow edges.
      const targeted = new Set(built.edges.map((e) => e.target));
      const sourced = new Set(built.edges.map((e) => e.source));
      const scaffoldEdges = [
        connectEdge(makeId(), trigger, capabilities),
        ...built.nodes
          .filter((n) => !targeted.has(n.id))
          .map((n) => connectEdge(makeId(), capabilities, n)),
        ...built.nodes
          .filter((n) => !sourced.has(n.id))
          .map((n) => connectEdge(makeId(), n, output)),
      ];
      setNodes([trigger, capabilities, output, ...built.nodes]);
      setEdges([...built.edges, ...scaffoldEdges]);
      setManifest(template.manifest ?? emptyManifest());
      idRef.current = maxNodeId(built.nodes) + 1;
    },
    [makeId, setNodes, setEdges, setManifest],
  );

  const onDragStart = (e: React.DragEvent, p: Protocol, actionId: string) => {
    e.dataTransfer.setData("application/rill", JSON.stringify({ protocolId: p.id, actionId }));
    e.dataTransfer.effectAllowed = "move";
  };

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const raw = e.dataTransfer.getData("application/rill");
      if (!raw) return;
      let parsed: { protocolId?: string; actionId?: string };
      try {
        parsed = JSON.parse(raw);
      } catch {
        toast.error("Invalid drop payload");
        return;
      }
      const { protocolId, actionId } = parsed;
      const p = PROTOCOLS.find((x) => x.id === protocolId);
      if (!p) return;
      const action = p.actions.find((a) => a.id === actionId);
      if (!action) return;
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const id = `n_${idRef.current++}`;
      const data = buildActionData(p, action);
      setNodes((nds) => nds.concat({ id, type: "action", position: pos, data } as Node));
    },
    [screenToFlowPosition, setNodes],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  // Part A: every flow already compiles to exactly one PTB — a manual "Add PTB" button implied
  // that batching was an opt-in step instead of an automatic fact, so it's gone. This derived
  // count feeds the read-only status pill next to the toolbar instead (below), and the `PtbNode`
  // component (nodes.tsx) is kept only so a legacy draft that still has a `ptb` node on canvas
  // keeps rendering.
  const actionNodeCount = useMemo(() => nodes.filter((n) => n.type === "action").length, [nodes]);

  // Part D: re-lays-out the current canvas left-to-right in flow order (Trigger first, Output
  // last, action nodes in between by dependency depth) — see lib/auto-layout.ts. Only positions
  // change; node/edge data and ids are untouched.
  const autoArrange = useCallback(() => {
    const positions = computeAutoLayout(nodesRef.current, edgesRef.current);
    setNodes((nds) =>
      nds.map((n) => (positions.has(n.id) ? { ...n, position: positions.get(n.id)! } : n)),
    );
    // Re-lay-out only moves nodes — the viewport keeps its old pan/zoom, so an arranged flow can
    // sit off-screen or half-cut (the "not centered / can't see everything" complaint). Fit the
    // viewport to the new positions once React Flow has committed them (rAF → next paint) and cap
    // the zoom so a 1- or 2-node flow frames at a sane size instead of blowing up to max zoom.
    requestAnimationFrame(() =>
      fitView({ padding: 0.2, duration: 400, maxZoom: 1, minZoom: 0.4 }),
    );
  }, [setNodes, fitView]);

  // Part C: hand-rolled drag-resize (not react-resizable-panels — that library sizes panels by
  // percentage of the group, and the ask here is a literal 260-480px clamp) — a mousedown on the
  // aside's right-edge handle starts tracking window-level mousemove/mouseup so the drag keeps
  // working even if the cursor leaves the handle's thin hit area mid-drag.
  const sidebarResizeStartRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const onSidebarResizeMove = useCallback((e: MouseEvent) => {
    const start = sidebarResizeStartRef.current;
    if (!start) return;
    const next = start.startWidth + (e.clientX - start.startX);
    setSidebarWidth(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, next)));
  }, []);

  const onSidebarResizeEnd = useCallback(() => {
    sidebarResizeStartRef.current = null;
    window.removeEventListener("mousemove", onSidebarResizeMove);
    window.removeEventListener("mouseup", onSidebarResizeEnd);
  }, [onSidebarResizeMove]);

  const onSidebarResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      sidebarResizeStartRef.current = { startX: e.clientX, startWidth: sidebarWidth };
      window.addEventListener("mousemove", onSidebarResizeMove);
      window.addEventListener("mouseup", onSidebarResizeEnd);
    },
    [sidebarWidth, onSidebarResizeMove, onSidebarResizeEnd],
  );

  // Drag listeners are registered/torn down per-drag (start/end above), but if the component
  // unmounts mid-drag they'd otherwise leak — same cleanup-on-unmount shape as every other
  // window listener in this file (see the beforeunload effect above).
  useEffect(() => {
    return () => {
      window.removeEventListener("mousemove", onSidebarResizeMove);
      window.removeEventListener("mouseup", onSidebarResizeEnd);
    };
  }, [onSidebarResizeMove, onSidebarResizeEnd]);

  return (
    <div className="h-[100dvh] flex flex-col overflow-hidden">
      <div className="shrink-0">
        <SiteHeader />
      </div>
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Sidebar — Part C: collapsible to a thin rail + resizable (260-480px, drag handle on
         *  the right edge). Width is plain component state, not persisted to the draft. */}
        {sidebarCollapsed ? (
          <aside className="w-11 shrink-0 border-r border-border/60 bg-card/40 backdrop-blur flex flex-col items-center min-h-0">
            <button
              type="button"
              onClick={() => setSidebarCollapsed(false)}
              aria-label="Expand library sidebar"
              className="mt-3 inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition hover:bg-secondary/60 hover:text-foreground"
            >
              <PanelLeft className="h-4 w-4" />
            </button>
          </aside>
        ) : (
          <aside
            style={{ width: sidebarWidth }}
            className="relative shrink-0 border-r border-border/60 bg-card/40 backdrop-blur flex flex-col min-h-0"
          >
            <div className="p-4 border-b border-border/60 shrink-0">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs uppercase tracking-widest text-muted-foreground">
                  Library
                </div>
                <div className="flex items-center gap-1">
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        aria-label="How it works"
                        className="inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border border-border/70 text-muted-foreground transition hover:border-border hover:text-foreground"
                      >
                        <HelpCircle className="h-3 w-3" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent
                      side="bottom"
                      align="end"
                      className="w-64 text-[11px] leading-relaxed text-muted-foreground"
                    >
                      <p className="mb-1.5 text-xs font-semibold text-foreground">How it works</p>
                      <p>
                        1. Drag actions onto canvas
                        <br />
                        2. Wire <strong>out → in</strong> — solid = coin chain, dashed = sequence
                        <br />
                        3. <strong>Simulate</strong> → <strong>Compile & export</strong>
                      </p>
                    </PopoverContent>
                  </Popover>
                  <button
                    type="button"
                    onClick={() => setSidebarCollapsed(true)}
                    aria-label="Collapse library sidebar"
                    className="inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border border-border/70 text-muted-foreground transition hover:border-border hover:text-foreground"
                  >
                    <PanelLeftClose className="h-3 w-3" />
                  </button>
                </div>
              </div>
              <motion.button
                whileHover={{ scale: 1.02, y: -1 }}
                whileTap={{ scale: 0.98 }}
                transition={{ type: "spring", stiffness: 420, damping: 24 }}
                onClick={() => setDiscoverOpen(true)}
                className="mt-3 w-full inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg bg-foreground text-background px-3 py-2 text-sm font-medium shadow-[var(--shadow-soft)]"
              >
                <ScanSearch className="h-3.5 w-3.5" /> Discover / Import
              </motion.button>
              <motion.button
                whileHover={{ scale: 1.02, y: -1 }}
                whileTap={{ scale: 0.98 }}
                transition={{ type: "spring", stiffness: 420, damping: 24 }}
                onClick={() => setTemplateOpen(true)}
                className="mt-2 w-full inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg bg-background border border-border text-foreground px-3 py-2 text-sm font-medium shadow-[var(--shadow-soft)]"
              >
                <LayoutTemplate className="h-3.5 w-3.5" /> Template
              </motion.button>
              <div className="mt-3 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search actions…"
                  className="w-full rounded-lg bg-background border border-border pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
              <AnimatePresence mode="popLayout">
                {filtered.map((p, i) => (
                  <motion.div
                    key={p.id}
                    layout
                    initial={{ opacity: 0, x: -16 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -8, scale: 0.98 }}
                    transition={{ delay: i * 0.05, duration: 0.35, ease: easeOut }}
                  >
                    <ProtocolGroup p={p} onAdd={addAction} onDragStart={onDragStart} />
                  </motion.div>
                ))}
              </AnimatePresence>
              {filtered.length === 0 && (
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-sm text-muted-foreground text-center py-12"
                >
                  No matching actions.
                </motion.p>
              )}
            </div>
            {/* Resize handle — drag to resize within MIN/MAX_SIDEBAR_WIDTH above. */}
            <div
              onMouseDown={onSidebarResizeStart}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize library sidebar"
              className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize hover:bg-primary/30 active:bg-primary/50"
            />
          </aside>
        )}

        {/* Canvas — fixed viewport; pan/zoom inside ReactFlow only */}
        <main className="flex-1 min-h-0 relative overflow-hidden">
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <motion.div
              className="absolute -top-24 -right-24 h-72 w-72 rounded-full bg-mint/20 blur-3xl"
              animate={{ x: [0, 24, 0], y: [0, 16, 0], scale: [1, 1.08, 1] }}
              transition={{ duration: 14, repeat: Infinity, ease: "easeInOut" }}
            />
            <motion.div
              className="absolute bottom-0 left-1/4 h-64 w-64 rounded-full bg-lilac/15 blur-3xl"
              animate={{ x: [0, -20, 0], y: [0, -12, 0], scale: [1, 1.05, 1] }}
              transition={{ duration: 18, repeat: Infinity, ease: "easeInOut", delay: 2 }}
            />
          </div>

          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.4, ease: easeOut }}
            className="absolute top-3 right-3 z-10 flex flex-col items-end gap-2"
          >
            <div className="flex flex-wrap items-center gap-2 justify-end">
              <div
                title="Every flow compiles into exactly one Programmable Transaction Block — batching is automatic, not a step you add."
                className="inline-flex items-center gap-1.5 rounded-full bg-card/60 backdrop-blur border border-border/70 px-3 py-2 text-[11px] font-medium text-muted-foreground"
              >
                <Layers className="h-3.5 w-3.5" /> 1 PTB ·{" "}
                <span className="font-mono text-foreground/80">{actionNodeCount}</span> moves
              </div>
              {(
                [
                  {
                    label: "Auto-arrange",
                    icon: LayoutGrid,
                    onClick: autoArrange,
                    badge: undefined,
                  },
                  {
                    label: "Capabilities",
                    icon: ShieldCheck,
                    onClick: () => setCapabilitiesOpen(true),
                    badge: manifest.rules.length > 0 ? manifest.rules.length : undefined,
                  },
                  { label: "Simulate", icon: Play, onClick: openSimulate, badge: undefined },
                ] as const
              ).map(({ label, icon: Icon, onClick, badge }) => (
                <motion.button
                  key={label}
                  whileHover={{ scale: 1.04, y: -2 }}
                  whileTap={{ scale: 0.96 }}
                  transition={{ type: "spring", stiffness: 480, damping: 22 }}
                  onClick={onClick}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-card/90 backdrop-blur border border-border px-3.5 py-2 text-sm font-medium shadow-[var(--shadow-soft)]"
                >
                  <Icon className="h-4 w-4" /> {label}
                  {badge !== undefined && (
                    <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                      {badge}
                    </span>
                  )}
                </motion.button>
              ))}
              <motion.button
                whileHover={publishGate.publishable ? { scale: 1.04, y: -2 } : undefined}
                whileTap={publishGate.publishable ? { scale: 0.96 } : undefined}
                transition={{ type: "spring", stiffness: 480, damping: 22 }}
                onClick={openExport}
                aria-disabled={!publishGate.publishable}
                aria-describedby={!publishGate.publishable ? "publish-gate-reason" : undefined}
                className={`inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-sm font-medium shadow-[var(--shadow-float)] transition-colors ${
                  publishGate.publishable
                    ? "cursor-pointer bg-foreground text-background"
                    : "cursor-not-allowed bg-foreground/50 text-background/80"
                }`}
              >
                <Download className="h-4 w-4" /> Compile & export
              </motion.button>
            </div>
            {!publishGate.publishable && publishGate.reason && (
              <p
                id="publish-gate-reason"
                role="status"
                className="max-w-xs rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 text-right text-[11px] text-amber-800 dark:text-amber-300"
              >
                {publishGate.reason}
              </p>
            )}
          </motion.div>

          <motion.div
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.35, duration: 0.4, ease: easeOut }}
            className="absolute top-3 left-3 z-10 rounded-full bg-card/80 backdrop-blur border border-border px-3 py-1.5 text-[11px] text-muted-foreground flex items-center gap-2"
          >
            <motion.span
              className="inline-block h-1.5 w-1.5 rounded-full bg-mint-foreground"
              animate={{ scale: [1, 1.35, 1], opacity: [1, 0.65, 1] }}
              transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
            />
            Wire out → in · Delete to remove
          </motion.div>

          <div className="absolute inset-0 touch-none" onDrop={onDrop} onDragOver={onDragOver}>
            {/* Part B: the only prop path from Builder's `manifest`/`setCapabilitiesOpen` state
             *  into the free-standing ActionNode components ReactFlow renders internally — see
             *  lib/manifest-context.ts and lib/open-capabilities-context.ts. */}
            <ManifestContext.Provider value={manifest}>
              <OpenCapabilitiesContext.Provider value={() => setCapabilitiesOpen(true)}>
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                  onConnectStart={onConnectStart}
                  onConnectEnd={onConnectEnd}
                  isValidConnection={isValidConnection}
                  nodeTypes={nodeTypes as any}
                  edgeTypes={edgeTypes as any}
                  fitView
                  fitViewOptions={{ padding: 0.2, maxZoom: 1, minZoom: 0.4 }}
                  minZoom={0.3}
                  maxZoom={1.5}
                  className="h-full w-full"
                  proOptions={{ hideAttribution: true }}
                  defaultEdgeOptions={{ type: "deletable", animated: true }}
                  edgesDeletable
                  deleteKeyCode={["Backspace", "Delete"]}
                  connectionRadius={28}
                  connectionLineStyle={{ stroke: "var(--color-primary)", strokeWidth: 2 }}
                  preventScrolling
                  panOnScroll
                  zoomOnScroll
                >
                  <Background
                    variant={BackgroundVariant.Dots}
                    gap={22}
                    size={1.2}
                    color="oklch(0.85 0.02 90)"
                  />
                  <Controls showInteractive={false} />
                  {/* Part E: shrunk from ReactFlow's default (~200x150) — it was crowding the
                   *  bottom-right corner of the canvas. */}
                  <MiniMap
                    pannable
                    zoomable
                    style={{
                      width: 140,
                      height: 100,
                      background: "var(--color-card)",
                      borderRadius: 12,
                      border: "1px solid var(--color-border)",
                    }}
                    nodeColor={(n) => {
                      const c = (n.data as ActionNodeData)?.color;
                      if (c === "mint") return "oklch(0.9 0.06 165)";
                      if (c === "peach") return "oklch(0.9 0.06 50)";
                      if (c === "sky") return "oklch(0.9 0.06 230)";
                      if (c === "lilac") return "oklch(0.9 0.06 305)";
                      return "oklch(0.7 0.02 250)";
                    }}
                  />
                </ReactFlow>
              </OpenCapabilitiesContext.Provider>
            </ManifestContext.Provider>
          </div>
        </main>
      </div>

      <AnimatePresence>
        {exportOpen && (
          <ExportDialog
            nodes={nodes}
            edges={edges}
            open
            onOpenChange={(o) => !o && setExportOpen(false)}
          />
        )}
        {discoverOpen && (
          <DiscoverDialog
            open
            onOpenChange={(o) => !o && setDiscoverOpen(false)}
            onImport={importDiscovered}
          />
        )}
        {templateOpen && (
          <TemplateDialog
            open
            onOpenChange={(o) => !o && setTemplateOpen(false)}
            onApply={(id) => {
              applyTemplate(id);
              setTemplateOpen(false);
            }}
          />
        )}
        {simulateOpen && (
          <SimulateDialog
            nodes={nodes}
            edges={edges}
            open
            onOpenChange={(o) => !o && setSimulateOpen(false)}
          />
        )}
        {capabilitiesOpen && (
          <CapabilitiesDialog
            open
            onOpenChange={(o) => !o && setCapabilitiesOpen(false)}
            manifest={manifest}
            onChange={setManifest}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function ProtocolGroup({
  p,
  onAdd,
  onDragStart,
}: {
  p: Protocol;
  onAdd: (p: Protocol, actionId: string) => void;
  onDragStart: (e: React.DragEvent, p: Protocol, actionId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-xl border border-border/70 bg-card overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex cursor-pointer items-center justify-between px-3 py-2.5 hover:bg-secondary/60 transition"
      >
        <div className="flex items-center gap-2">
          <ProtocolLogo protocolId={p.id} name={p.name} />
          <div className="text-left">
            <div className="text-sm font-semibold leading-tight">{p.name}</div>
            <div className="text-[11px] text-muted-foreground">{p.category}</div>
          </div>
        </div>
        <ChevronRight
          className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden border-t border-border/60"
          >
            <div className="p-2 space-y-1">
              {p.actions.map((a, i) => (
                <motion.div
                  key={a.id}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.04, duration: 0.25, ease: easeOut }}
                  whileHover={{ x: 4, backgroundColor: "var(--color-secondary)" }}
                  draggable
                  onDragStart={(e) => onDragStart(e, p, a.id)}
                  onDoubleClick={() => onAdd(p, a.id)}
                  className="group flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 cursor-grab active:cursor-grabbing"
                >
                  <div>
                    <div className="text-sm font-medium leading-tight">{a.name}</div>
                    <div className="text-[11px] text-muted-foreground line-clamp-1">
                      {a.description}
                    </div>
                  </div>
                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => onAdd(p, a.id)}
                    className="opacity-0 group-hover:opacity-100 transition cursor-pointer text-[11px] rounded-md border border-border bg-background px-2 py-1"
                  >
                    Add
                  </motion.button>
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
