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
  ReactFlowProvider,
  useReactFlow,
} from "reactflow";
import { motion, AnimatePresence } from "framer-motion";
import gsap from "gsap";
import { toast } from "sonner";
import {
  Search,
  Download,
  Play,
  ChevronRight,
  X,
  ScanSearch,
  Shield,
  Layers,
  Check,
  Loader2,
  Wallet,
} from "lucide-react";
import { SiteHeader } from "@/components/site-chrome";
import {
  ActionNode,
  TriggerNode,
  OutputNode,
  PtbNode,
  GuardrailNode,
  WalletNode,
  type ActionNodeData,
  type WalletNodeData,
} from "@/components/flow/nodes";
import { PROTOCOLS, BACKEND_PROTOCOL_IDS, type Protocol } from "@/lib/protocols";
import { DiscoverDialog } from "@/components/flow/discover-dialog";
import { ProtocolLogo } from "@/components/flow/protocol-logo";
import { DeletableEdge } from "@/components/flow/deletable-edge";
import { SimulateDialog } from "@/components/flow/simulate-dialog";
import { buildFlowGraph } from "@/lib/flow-mapper";
import {
  inferWireKindFromConnection,
  isValidWireConnection,
  WIRE_IN,
  WIRE_OUT,
} from "@/lib/wire-inference";
import { applyProtocolRegistry, defaultActionConfig } from "@/lib/action-config";
import { getActionPorts } from "@/lib/action-ports";
import { rillApi, type PublishResult } from "@/lib/rill-api";
import type { DiscoveredFunction, IntrospectionResult } from "@/lib/rill-types";

export const Route = createFileRoute("/builder")({
  component: BuilderPage,
});

const nodeTypes = {
  action: ActionNode,
  trigger: TriggerNode,
  output: OutputNode,
  ptb: PtbNode,
  guardrail: GuardrailNode,
  wallet: WalletNode,
};

const edgeTypes = {
  default: DeletableEdge,
  deletable: DeletableEdge,
};

const initialNodes: Node[] = [
  { id: "trigger", type: "trigger", position: { x: 40, y: 200 }, data: { label: "Agent prompt", sub: "Describe the goal" } },
  { id: "output", type: "output", position: { x: 920, y: 200 }, data: { label: "MCP Server", sub: "Auto-generated" } },
];
const initialEdges: Edge[] = [];

const easeOut = [0.22, 1, 0.36, 1] as const;

const stagger = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.07, delayChildren: 0.05 },
  },
};

const fadeUp = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: easeOut } },
};

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
  const [simulateOpen, setSimulateOpen] = useState(false);
  const [network, setNetwork] = useState<string | null>(null);
  const idRef = useRef(1);
  const headlineRef = useRef<HTMLHeadingElement>(null);
  const { screenToFlowPosition } = useReactFlow();

  useEffect(() => {
    rillApi.protocols().then(applyProtocolRegistry).catch(() => {
      /* bundled TESTNET_MANIFEST is fallback */
    });
    rillApi
      .health()
      .then((h) => {
        const n = typeof h.network === "string" ? h.network : null;
        if (n) setNetwork(n);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!headlineRef.current) return;
    gsap.fromTo(
      headlineRef.current,
      { opacity: 0, y: 16, filter: "blur(6px)" },
      { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.7, ease: "power3.out", delay: 0.1 },
    );
  }, [network]);

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
    (c: Connection) => isValidWireConnection(c, nodes),
    [nodes],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const supported = PROTOCOLS.filter((p) => BACKEND_PROTOCOL_IDS.has(p.id))
      .sort((a, b) => (a.id === "cetus" ? -1 : b.id === "cetus" ? 1 : 0))
      .map((p) => ({
        ...p,
        actions: p.actions.filter((a) =>
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
      const pos = screenToFlowPosition({ x: 280 + Math.random() * 60, y: 120 + Math.random() * 120 });
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
          protocolId: meta.source.kind === "protocol" ? meta.source.value : meta.protocol.toLowerCase(),
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

  const onDragStart = (e: React.DragEvent, p: Protocol, actionId: string) => {
    e.dataTransfer.setData("application/rill", JSON.stringify({ protocolId: p.id, actionId }));
    e.dataTransfer.effectAllowed = "move";
  };

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const raw = e.dataTransfer.getData("application/rill");
      if (!raw) return;
      const { protocolId, actionId } = JSON.parse(raw);
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

  const addPtb = () => {
    const actionCount = nodes.filter((n) => n.type === "action").length || 2;
    const id = `ptb_${idRef.current++}`;
    setNodes((nds) =>
      nds.concat({
        id,
        type: "ptb",
        position: { x: 640, y: 460 },
        data: { label: "Programmable Tx Block", steps: actionCount },
      } as Node),
    );
  };

  const addGuardrail = () => {
    const id = `gr_${idRef.current++}`;
    setNodes((nds) =>
      nds.concat({
        id,
        type: "guardrail",
        position: { x: 320, y: 480 },
        data: {
          // No decorative rule labels: a guardrail enforces its minValue via
          // rill_guard::assert_min_value, and nothing else.
          rules: [],
          minValue: "0",
          coinType: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
        },
      } as Node),
    );
  };

  const addWallet = () => {
    const id = `wallet_${idRef.current++}`;
    setNodes((nds) =>
      nds.concat({
        id,
        type: "wallet",
        position: { x: 120, y: 420 },
        data: {
          label: "Agent wallet",
          coinType: "0x2::sui::SUI",
        } as WalletNodeData,
      } as Node),
    );
  };

  return (
    <div className="h-[100dvh] flex flex-col overflow-hidden">
      <div className="shrink-0">
        <SiteHeader />
      </div>
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-[320px] shrink-0 border-r border-border/60 bg-card/40 backdrop-blur flex flex-col min-h-0">
          <div className="p-4 border-b border-border/60 shrink-0">
            <div className="text-xs uppercase tracking-widest text-muted-foreground">Library</div>
            <h2 ref={headlineRef} className="mt-1 font-display text-2xl tracking-tight">
              {network ? `Live on ${network}` : "Live on Sui"}
            </h2>
            <p className="mt-2 text-[11px] text-muted-foreground leading-relaxed">
              1. Drag actions onto canvas
              <br />
              2. Wire <strong>out → in</strong> — solid = coin chain, dashed = sequence
              <br />
              3. <strong>Simulate</strong> → <strong>Compile & export</strong>
            </p>
            <motion.button
              whileHover={{ scale: 1.02, y: -1 }}
              whileTap={{ scale: 0.98 }}
              transition={{ type: "spring", stiffness: 420, damping: 24 }}
              onClick={() => setDiscoverOpen(true)}
              className="mt-3 w-full inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg bg-foreground text-background px-3 py-2 text-sm font-medium shadow-[var(--shadow-soft)]"
            >
              <ScanSearch className="h-3.5 w-3.5" /> Discover / Import
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
        </aside>

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
            className="absolute top-3 right-3 z-10 flex flex-wrap gap-2 justify-end"
          >
            {(
              [
                { label: "Add Wallet", icon: Wallet, onClick: addWallet, primary: false },
                { label: "Add PTB", icon: Layers, onClick: addPtb, primary: false },
                { label: "Guardrails", icon: Shield, onClick: addGuardrail, primary: false },
                { label: "Simulate", icon: Play, onClick: () => setSimulateOpen(true), primary: false },
                { label: "Compile & export", icon: Download, onClick: () => setExportOpen(true), primary: true },
              ] as const
            ).map(({ label, icon: Icon, onClick, primary }) => (
              <motion.button
                key={label}
                whileHover={{ scale: 1.04, y: -2 }}
                whileTap={{ scale: 0.96 }}
                transition={{ type: "spring", stiffness: 480, damping: 22 }}
                onClick={onClick}
                className={
                  primary
                    ? "inline-flex cursor-pointer items-center gap-2 rounded-full bg-foreground text-background px-3.5 py-2 text-sm font-medium shadow-[var(--shadow-float)]"
                    : "inline-flex cursor-pointer items-center gap-2 rounded-full bg-card/90 backdrop-blur border border-border px-3.5 py-2 text-sm font-medium shadow-[var(--shadow-soft)]"
                }
              >
                <Icon className="h-4 w-4" /> {label}
              </motion.button>
            ))}
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
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              nodeTypes={nodeTypes as any}
              edgeTypes={edgeTypes as any}
              fitView
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
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="oklch(0.85 0.02 90)" />
              <Controls showInteractive={false} />
              <MiniMap
                pannable
                zoomable
                style={{ background: "var(--color-card)", borderRadius: 12, border: "1px solid var(--color-border)" }}
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
          </div>
        </main>
      </div>

      <AnimatePresence>
        {exportOpen && (
          <ExportDialog nodes={nodes} edges={edges} onClose={() => setExportOpen(false)} />
        )}
        {discoverOpen && (
          <DiscoverDialog onClose={() => setDiscoverOpen(false)} onImport={importDiscovered} />
        )}
        {simulateOpen && (
          <SimulateDialog nodes={nodes} edges={edges} onClose={() => setSimulateOpen(false)} />
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
        <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
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
                    <div className="text-[11px] text-muted-foreground line-clamp-1">{a.description}</div>
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

function ExportDialog({
  nodes,
  edges,
  onClose,
}: {
  nodes: Node[];
  edges: Edge[];
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState<PublishResult | null>(null);
  const [copied, setCopied] = useState<"mcp" | "config" | null>(null);
  const mcpBoxRef = useRef<HTMLDivElement>(null);
  const actions = nodes.filter((n) => n.type === "action").map((n) => n.data as ActionNodeData);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      const { nodes: flowNodes, edges: flowEdges, skipped } = buildFlowGraph(nodes, edges);
      const actionNodes = flowNodes.filter(
        (n) => n.type !== "ptb" && n.type !== "guardrail",
      );
      if (actionNodes.length === 0) {
        const message = skipped.length
          ? `No supported action nodes. Skipped: ${skipped.join(", ")}`
          : "Add a supported action before publishing.";
        setError(message);
        toast.error(message);
        setLoading(false);
        return;
      }
      try {
        const data = await rillApi.publish({ nodes: flowNodes, edges: flowEdges });
        if (!cancelled) setPublished(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Publish failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [nodes, edges]);

  useEffect(() => {
    if (!published || !mcpBoxRef.current) return;
    gsap.fromTo(
      mcpBoxRef.current,
      { scale: 0.96, boxShadow: "0 0 0 rgba(0,0,0,0)" },
      {
        scale: 1,
        boxShadow: "0 0 0 3px oklch(0.72 0.12 165 / 0.35)",
        duration: 0.55,
        ease: "back.out(1.6)",
      },
    );
    gsap.to(mcpBoxRef.current, {
      boxShadow: "0 0 0 0px oklch(0.72 0.12 165 / 0)",
      delay: 0.9,
      duration: 0.6,
      ease: "power2.out",
    });
  }, [published]);

  const claudeConfig = useMemo(() => {
    if (!published) return "";
    return JSON.stringify(
      {
        mcpServers: {
          "rill-actions": {
            url: published.mcpUrl,
          },
        },
      },
      null,
      2,
    );
  }, [published]);

  const copy = async (text: string, kind: "mcp" | "config") => {
    await navigator.clipboard.writeText(text);
    setCopied(kind);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 cursor-pointer bg-foreground/30 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12, scale: 0.98 }}
        transition={{ type: "spring", stiffness: 380, damping: 28 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl cursor-default rounded-2xl bg-card border border-border shadow-[var(--shadow-float)] overflow-hidden"
      >
        <div className="flex items-start justify-between px-5 py-4 border-b border-border gap-4">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-widest text-muted-foreground">Publish</div>
            <h3 className="font-display text-2xl tracking-tight">
              {loading ? "Publishing flow…" : published ? "MCP server ready" : "Publish failed"}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {loading
                ? "Publishing action metadata and registering the bounded Rill tools."
                : "Copy the URL below into Claude Code, Cursor, or Thiny — not a browser link."}
            </p>
          </div>
          <motion.button
            whileHover={{ scale: 1.08, rotate: 90 }}
            whileTap={{ scale: 0.92 }}
            onClick={onClose}
            className="cursor-pointer rounded-full p-1.5 hover:bg-secondary shrink-0"
          >
            <X className="h-4 w-4" />
          </motion.button>
        </div>

        <div className="p-5 space-y-4 min-h-[180px]">
          {loading && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col items-center justify-center py-10 gap-4"
            >
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 1.2, repeat: Infinity, ease: "linear" }}
              >
                <Loader2 className="h-8 w-8 text-primary" />
              </motion.div>
              <div className="flex gap-1.5">
                {["Compose", "Simulate", "Publish"].map((step, i) => (
                  <motion.span
                    key={step}
                    className="text-[11px] rounded-full border border-border px-2.5 py-1 text-muted-foreground"
                    initial={{ opacity: 0.4 }}
                    animate={{ opacity: [0.4, 1, 0.4] }}
                    transition={{ duration: 1.4, repeat: Infinity, delay: i * 0.35 }}
                  >
                    {step}
                  </motion.span>
                ))}
              </div>
            </motion.div>
          )}

          {error && !loading && (
            <motion.p
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              className="text-sm text-destructive rounded-lg border border-destructive/30 bg-destructive/5 p-3"
            >
              {error}
            </motion.p>
          )}

          {published && !loading && (
            <motion.div variants={stagger} initial="hidden" animate="show" className="space-y-4">
              <motion.div variants={fadeUp} className="flex items-center gap-2 text-mint-foreground">
                <motion.span
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", stiffness: 500, damping: 18, delay: 0.1 }}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-mint/30"
                >
                  <Check className="h-3.5 w-3.5" />
                </motion.span>
                <span className="text-sm font-medium">Published successfully</span>
              </motion.div>

              <motion.div variants={fadeUp}>
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  MCP server URL
                </label>
                <div ref={mcpBoxRef} className="mt-1.5 flex gap-2 rounded-xl">
                  <code className="flex-1 rounded-lg border border-border bg-foreground/5 px-3 py-2.5 text-xs break-all">
                    {published.mcpUrl}
                  </code>
                  <motion.button
                    whileHover={{ scale: 1.04 }}
                    whileTap={{ scale: 0.96 }}
                    onClick={() => copy(published.mcpUrl, "mcp")}
                    className="shrink-0 cursor-pointer rounded-full bg-foreground text-background px-4 py-2 text-sm font-medium"
                  >
                    <AnimatePresence mode="wait">
                      {copied === "mcp" ? (
                        <motion.span
                          key="copied"
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -6 }}
                          className="inline-flex items-center gap-1"
                        >
                          <Check className="h-3.5 w-3.5" /> Copied
                        </motion.span>
                      ) : (
                        <motion.span key="copy" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                          Copy URL
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </motion.button>
                </div>
              </motion.div>

              <motion.div
                variants={fadeUp}
                className="rounded-lg border border-border/60 bg-muted/30 px-4 py-3 text-sm space-y-2"
              >
                <p className="font-medium">How to use</p>
                <ol className="list-decimal list-inside text-muted-foreground space-y-1 text-xs">
                  <li>Copy the MCP URL above and add it as <code className="text-foreground">rill-actions</code></li>
                  <li>Call <code className="text-foreground">list_actions</code>, then <code className="text-foreground">describe_action</code></li>
                  <li>
                    Call <code className="text-foreground">build_action</code> with public wallet IDs and runtime params → get an unsigned ExecutionEnvelope
                  </li>
                </ol>
              </motion.div>

              <motion.div variants={fadeUp}>
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Claude Code config (optional)
                </label>
                <pre className="mt-1.5 rounded-lg border border-border bg-foreground/5 p-3 text-[11px] font-mono overflow-auto max-h-36">
                  {claudeConfig}
                </pre>
                <motion.button
                  whileHover={{ x: 2 }}
                  onClick={() => copy(claudeConfig, "config")}
                  className="mt-2 cursor-pointer text-xs text-primary hover:underline"
                >
                  {copied === "config" ? "Copied!" : "Copy config JSON"}
                </motion.button>
              </motion.div>

              {published.warnings.length > 0 && (
                <motion.p variants={fadeUp} className="text-xs text-amber-700 dark:text-amber-400">
                  Warnings: {published.warnings.join(" · ")}
                </motion.p>
              )}

              {published.skillUrl && (
                <motion.p variants={fadeUp} className="text-xs text-muted-foreground border-t border-border pt-3">
                  Need human-readable docs?{" "}
                  <a
                    href={published.skillUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline"
                  >
                    Open SKILL.md
                  </a>
                  {" "}(includes the same MCP URL + bounded remote/local handoff)
                </motion.p>
              )}

              <motion.p variants={fadeUp} className="text-[10px] text-muted-foreground">
                Flow: {actions.map((a) => `${a.protocol} · ${a.action}`).join(" → ")}
              </motion.p>
            </motion.div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
