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
import {
  Search,
  Download,
  Play,
  Box,
  ChevronRight,
  X,
  Bot,
  Code2,
  Terminal,
  Sparkles,
  Shield,
  Layers,
} from "lucide-react";
import { SiteHeader } from "@/components/site-chrome";
import {
  ActionNode,
  TriggerNode,
  OutputNode,
  PtbNode,
  GuardrailNode,
  type ActionNodeData,
} from "@/components/flow/nodes";
import { PROTOCOLS, BACKEND_PROTOCOL_IDS, type Protocol } from "@/lib/protocols";
import { DiscoverDialog } from "@/components/flow/discover-dialog";
import { SimulateDialog, DEFAULT_GUARDRAILS, type Guardrail } from "@/components/flow/simulate-dialog";
import { buildFlowGraph } from "@/lib/flow-mapper";
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
};

const initialNodes: Node[] = [
  { id: "trigger", type: "trigger", position: { x: 40, y: 200 }, data: { label: "Agent prompt", sub: "Describe the goal" } },
  { id: "output", type: "output", position: { x: 920, y: 200 }, data: { label: "MCP Server", sub: "Auto-generated" } },
];
const initialEdges: Edge[] = [];

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
  const [guardrails, setGuardrails] = useState<Guardrail[]>(DEFAULT_GUARDRAILS);
  const idRef = useRef(1);
  const { screenToFlowPosition } = useReactFlow();

  useEffect(() => {
    rillApi.protocols().then(applyProtocolRegistry).catch(() => {
      /* bundled TESTNET_MANIFEST is fallback */
    });
  }, []);

  const onConnect = useCallback(
    (c: Connection) => setEdges((es) => addEdge({ ...c, animated: true }, es)),
    [setEdges],
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
        data: { rules: guardrails.filter((g) => g.enabled).map((g) => ({ id: g.id, label: g.label })) },
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
            <h2 className="mt-1 font-display text-2xl tracking-tight">Live on testnet</h2>
            <p className="mt-2 text-[11px] text-muted-foreground leading-relaxed">
              1. Drag node → set <strong>token & amount</strong> on canvas
              <br />
              2. Wire <strong>coin_out → sui_coin</strong> (swap must output SUI for stake)
              <br />
              3. <strong>Simulate</strong> → then <strong>Compile & export</strong> for MCP URL
            </p>
            <button
              onClick={() => setDiscoverOpen(true)}
              className="mt-3 w-full inline-flex items-center justify-center gap-2 rounded-lg bg-foreground text-background px-3 py-2 text-sm font-medium hover:opacity-90 transition"
            >
              <Sparkles className="h-3.5 w-3.5" /> Discover / Import
            </button>
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
            {filtered.map((p) => (
              <ProtocolGroup key={p.id} p={p} onAdd={addAction} onDragStart={onDragStart} />
            ))}
            {filtered.length === 0 && (
              <div className="text-sm text-muted-foreground text-center py-12">No matching actions.</div>
            )}
          </div>
        </aside>

        {/* Canvas — fixed viewport; pan/zoom inside ReactFlow only */}
        <main className="flex-1 min-h-0 relative overflow-hidden">
          <div className="absolute top-3 right-3 z-10 flex flex-wrap gap-2 justify-end">
            <button
              onClick={addPtb}
              className="inline-flex items-center gap-2 rounded-full bg-card border border-border px-3.5 py-2 text-sm font-medium hover:bg-secondary transition"
            >
              <Layers className="h-4 w-4" /> Add PTB
            </button>
            <button
              onClick={addGuardrail}
              className="inline-flex items-center gap-2 rounded-full bg-card border border-border px-3.5 py-2 text-sm font-medium hover:bg-secondary transition"
            >
              <Shield className="h-4 w-4" /> Guardrails
            </button>
            <button
              onClick={() => setSimulateOpen(true)}
              className="inline-flex items-center gap-2 rounded-full bg-card border border-border px-3.5 py-2 text-sm font-medium shadow-[var(--shadow-soft)] hover:bg-secondary transition"
            >
              <Play className="h-4 w-4" /> Simulate
            </button>
            <button
              onClick={() => setExportOpen(true)}
              className="inline-flex items-center gap-2 rounded-full bg-foreground text-background px-3.5 py-2 text-sm font-medium shadow-[var(--shadow-float)] hover:opacity-90 transition"
            >
              <Download className="h-4 w-4" /> Compile & export
            </button>
          </div>

          <div className="absolute top-3 left-3 z-10 rounded-full bg-card/80 backdrop-blur border border-border px-3 py-1.5 text-[11px] text-muted-foreground flex items-center gap-2">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-mint-foreground" />
            Drag to wire labeled ports (amount_in → amount_out)
          </div>

          <div className="absolute inset-0 touch-none" onDrop={onDrop} onDragOver={onDragOver}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              nodeTypes={nodeTypes as any}
              fitView
              className="h-full w-full"
              proOptions={{ hideAttribution: true }}
              defaultEdgeOptions={{ animated: true }}
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
          <ExportDialog nodes={nodes} edges={edges} guardrails={guardrails} onClose={() => setExportOpen(false)} />
        )}
        {discoverOpen && (
          <DiscoverDialog onClose={() => setDiscoverOpen(false)} onImport={importDiscovered} />
        )}
        {simulateOpen && (
          <SimulateDialog
            nodes={nodes}
            edges={edges}
            guardrails={guardrails}
            onChange={setGuardrails}
            onClose={() => setSimulateOpen(false)}
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
  const colorMap: Record<string, string> = {
    mint: "bg-mint text-mint-foreground",
    peach: "bg-peach text-peach-foreground",
    sky: "bg-sky text-sky-foreground",
    lilac: "bg-lilac text-lilac-foreground",
  };
  const colorCls = colorMap[p.color];
  return (
    <div className="rounded-xl border border-border/70 bg-card overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-secondary/60 transition"
      >
        <div className="flex items-center gap-2">
          <span className={`h-6 w-6 rounded-md ${colorCls} flex items-center justify-center`}>
            <Box className="h-3.5 w-3.5" />
          </span>
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
              {p.actions.map((a) => (
                <div
                  key={a.id}
                  draggable
                  onDragStart={(e) => onDragStart(e, p, a.id)}
                  onDoubleClick={() => onAdd(p, a.id)}
                  className="group flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 hover:bg-secondary/70 cursor-grab active:cursor-grabbing"
                >
                  <div>
                    <div className="text-sm font-medium leading-tight">{a.name}</div>
                    <div className="text-[11px] text-muted-foreground line-clamp-1">{a.description}</div>
                  </div>
                  <button
                    onClick={() => onAdd(p, a.id)}
                    className="opacity-0 group-hover:opacity-100 transition text-[11px] rounded-md border border-border bg-background px-2 py-1"
                  >
                    Add
                  </button>
                </div>
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
  guardrails,
  onClose,
}: {
  nodes: Node[];
  edges: Edge[];
  guardrails: Guardrail[];
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"mcp" | "skill" | "cli">("mcp");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState<PublishResult | null>(null);
  const actions = nodes.filter((n) => n.type === "action").map((n) => n.data as ActionNodeData);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      const { nodes: flowNodes, edges: flowEdges, skipped } = buildFlowGraph(nodes, edges);
      if (flowNodes.length === 0) {
        setError(
          skipped.length
            ? `Only Cetus swap + Haedal stake compile today. Skipped: ${skipped.join(", ")}`
            : "Add a supported action before publishing.",
        );
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

  const mcp = useMemo(() => {
    if (published) {
      return JSON.stringify(
        {
          name: published.toolDefs.name,
          description: published.toolDefs.description,
          mcpUrl: published.mcpUrl,
          skillId: published.skillId,
          runtime: { network: "sui:testnet", mode: "keyless", sign: "thiny" },
          guardrails: guardrails.filter((g) => g.enabled).map((g) => g.id),
          warnings: published.warnings,
        },
        null,
        2,
      );
    }
    return loading ? "Publishing to Rill backend…" : error ?? "";
  }, [published, guardrails, loading, error]);

  const cli = useMemo(() => {
    if (!published) return error ?? "Waiting for publish…";
    return [
      "# Rill MCP — paste into Thiny / Claude Code",
      `curl -X POST ${published.mcpUrl} \\`,
      '  -H "Content-Type: application/json" \\',
      '  -d \'{"jsonrpc":"2.0","id":1,"method":"tools/list"}\'',
      "",
      "Guardrails:",
      ...guardrails.filter((g) => g.enabled).map((g) => `  - ${g.label}`),
      "",
      "Steps:",
      ...actions.map((a, i) => `  ${i + 1}. ${a.protocol} · ${a.action}`),
    ].join("\n");
  }, [published, guardrails, actions, error]);

  const skill = useMemo(() => {
    if (!published) return error ?? "";
    return [
      "---",
      `name: ${published.toolDefs.name}`,
      `description: ${published.toolDefs.description}`,
      "---",
      "",
      "## MCP URL",
      published.mcpUrl,
      "",
      "## Steps",
      ...actions.map((a, i) => `${i + 1}. **${a.protocol} — ${a.action}**: ${a.description}`),
      "",
      "## Runtime",
      "Agent calls MCP → Rill returns unsigned PTB + preview → Thiny signs (keyless backend).",
    ].join("\n");
  }, [published, actions, error]);

  const content = tab === "mcp" ? mcp : tab === "cli" ? cli : skill;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-foreground/30 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.98 }}
        transition={{ duration: 0.2 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl rounded-2xl bg-card border border-border shadow-[var(--shadow-float)] overflow-hidden"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <div className="text-xs uppercase tracking-widest text-muted-foreground">Compile flow</div>
            <h3 className="font-display text-2xl tracking-tight">Ship to your agent</h3>
            {published && (
              <a
                href={published.mcpUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-primary hover:underline mt-1 block truncate max-w-md"
              >
                {published.mcpUrl}
              </a>
            )}
          </div>
          <button onClick={onClose} className="rounded-full p-1.5 hover:bg-secondary">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 pt-4 flex gap-1">
          {[
            { id: "mcp", label: "MCP Server", icon: Bot },
            { id: "skill", label: "Agent Skill", icon: Code2 },
            { id: "cli", label: "CLI Tool", icon: Terminal },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id as "mcp" | "skill" | "cli")}
              className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm transition ${
                tab === t.id ? "bg-foreground text-background" : "text-muted-foreground hover:bg-secondary"
              }`}
            >
              <t.icon className="h-3.5 w-3.5" /> {t.label}
            </button>
          ))}
        </div>
        <div className="p-5">
          <pre className="rounded-xl bg-foreground/5 border border-border p-4 text-xs font-mono overflow-auto max-h-[420px] text-foreground/85 whitespace-pre-wrap">
            {loading ? "Publishing flow to Rill backend…" : content}
          </pre>
          <div className="mt-4 flex justify-end gap-2">
            <button
              disabled={!content || loading}
              onClick={() => navigator.clipboard.writeText(content)}
              className="rounded-full border border-border bg-background px-4 py-2 text-sm hover:bg-secondary transition disabled:opacity-50"
            >
              Copy
            </button>
            {published && (
              <button
                onClick={() => window.open(published.mcpUrl, "_blank")}
                className="rounded-full bg-foreground text-background px-4 py-2 text-sm hover:opacity-90 transition"
              >
                Open MCP URL
              </button>
            )}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
