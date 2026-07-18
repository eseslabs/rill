import { createFileRoute, Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { useEffect, useRef } from "react";
import gsap from "gsap";
import ReactFlow, { Background, BackgroundVariant } from "reactflow";
import { ArrowRight, Workflow, Code2, Terminal, Boxes, Plug } from "lucide-react";
import { SiteHeader, SiteFooter } from "@/components/site-chrome";
import { ActionNode, TriggerNode, OutputNode } from "@/components/flow/nodes";

export const Route = createFileRoute("/")({
  component: Landing,
});

const nodeTypes = { action: ActionNode, trigger: TriggerNode, output: OutputNode };

const demoNodes = [
  { id: "t", type: "trigger", position: { x: 0, y: 80 }, data: { label: "Agent prompt", sub: "“Rebalance my portfolio”" } },
  {
    id: "a1",
    type: "action",
    position: { x: 240, y: 0 },
    data: {
      protocol: "Pyth", protocolId: "pyth", action: "Get price feed", color: "sky",
      description: "Read latest SUI/USD price.",
      inputs: [{ key: "feed", label: "Feed", type: "string" }],
    },
  },
  {
    id: "a2",
    type: "action",
    position: { x: 240, y: 180 },
    data: {
      protocol: "Cetus", protocolId: "cetus", action: "Swap tokens", color: "mint",
      description: "Swap USDC → SUI.",
      inputs: [
        { key: "tokenIn", label: "In", type: "token" },
        { key: "tokenOut", label: "Out", type: "token" },
      ],
    },
  },
  {
    id: "a3",
    type: "action",
    position: { x: 520, y: 180 },
    data: {
      protocol: "Haedal", protocolId: "haedal", action: "Stake SUI", color: "lilac",
      description: "Stake the swapped SUI.",
      inputs: [{ key: "amount", label: "Amount", type: "number" }],
    },
  },
  { id: "o", type: "output", position: { x: 800, y: 100 }, data: { label: "MCP Server", sub: "Ready for any agent" } },
];

const demoEdges = [
  { id: "e1", source: "t", target: "a1", animated: true },
  { id: "e2", source: "t", target: "a2", animated: true },
  { id: "e3", source: "a1", target: "a2", animated: true },
  { id: "e4", source: "a2", target: "a3", animated: true },
  { id: "e5", source: "a3", target: "o", animated: true },
];

function Landing() {
  const headlineRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!headlineRef.current) return;
    const words = headlineRef.current.querySelectorAll<HTMLElement>("[data-word]");
    gsap.fromTo(
      words,
      { y: 24, opacity: 0, filter: "blur(8px)" },
      { y: 0, opacity: 1, filter: "blur(0px)", duration: 0.9, stagger: 0.06, ease: "power3.out" }
    );
  }, []);

  return (
    <div className="min-h-screen">
      <SiteHeader />

      {/* HERO */}
      <section className="relative mx-auto max-w-6xl px-6 pt-16 pb-10">
        <h1
          ref={headlineRef}
          className="font-display text-5xl md:text-7xl leading-[1.02] tracking-tight max-w-4xl"
        >
          {"Make any Sui dApp usable by AI agents."
            .split(" ")
            .map((w, i) => (
              <span key={i} data-word className="inline-block mr-[0.25em]">
                {w}
              </span>
            ))}
        </h1>

        <motion.p
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6, duration: 0.6 }}
          className="mt-6 max-w-2xl text-lg text-muted-foreground leading-relaxed"
        >
          Rill is a visual flow builder for Sui protocols. Drag actions, wire them together,
          and publish a hosted <span className="text-foreground font-medium">MCP server</span> any agent
          (Claude, Cursor, Thiny) can call — grounded, simulated, and signed safely on-chain.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.8, duration: 0.6 }}
          className="mt-7 flex flex-wrap items-center gap-3"
        >
          <Link
            to="/builder"
            className="group inline-flex items-center gap-2 rounded-full bg-foreground text-background px-5 py-2.5 text-sm font-medium hover:opacity-90 transition"
          >
            Start building
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
          <Link
            to="/protocols"
            className="inline-flex items-center gap-2 rounded-full border border-border bg-card/70 backdrop-blur px-5 py-2.5 text-sm font-medium hover:bg-card transition"
          >
            Browse protocols
          </Link>
        </motion.div>

        {/* Demo flow */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1, duration: 0.8 }}
          className="mt-14 rounded-3xl border border-border/70 bg-card/60 backdrop-blur shadow-[var(--shadow-float)] overflow-hidden"
        >
          <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-border/70 bg-background/40">
            <span className="h-2.5 w-2.5 rounded-full bg-peach" />
            <span className="h-2.5 w-2.5 rounded-full bg-mint" />
            <span className="h-2.5 w-2.5 rounded-full bg-sky" />
            <span className="ml-3 text-xs text-muted-foreground font-mono">flow · portfolio-rebalance</span>
          </div>
          <div style={{ height: 380 }}>
            <ReactFlow
              nodes={demoNodes as any}
              edges={demoEdges}
              nodeTypes={nodeTypes as any}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              proOptions={{ hideAttribution: true }}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              panOnDrag={false}
              zoomOnScroll={false}
              zoomOnPinch={false}
              zoomOnDoubleClick={false}
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="oklch(0.85 0.02 90)" />
            </ReactFlow>
          </div>
        </motion.div>
      </section>

      {/* HOW IT WORKS */}
      <section className="mx-auto max-w-6xl px-6 mt-24">
        <div className="max-w-2xl">
          <div className="text-xs uppercase tracking-widest text-muted-foreground">How it works</div>
          <h2 className="mt-2 text-4xl font-display tracking-tight">Three steps from protocol to agent.</h2>
        </div>
        <div className="mt-10 grid md:grid-cols-3 gap-5">
          {[
            { icon: Boxes, color: "bg-mint text-mint-foreground", title: "Compose", body: "Pick protocol nodes — Cetus, Navi, Haedal, Pyth, SuiNS — and wire them on a canvas." },
            { icon: Workflow, color: "bg-peach text-peach-foreground", title: "Configure", body: "Set inputs, validation rules, and which steps the agent decides vs. you pin." },
            { icon: Plug, color: "bg-lilac text-lilac-foreground", title: "Export", body: "Get an MCP server, an agent skill, or a CLI tool — ready to drop into Claude or any model." },
          ].map((s, i) => (
            <motion.div
              key={s.title}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ delay: i * 0.08, duration: 0.5 }}
              className="rounded-2xl bg-card border border-border/70 p-6 shadow-[var(--shadow-soft)]"
            >
              <div className={`inline-flex h-10 w-10 items-center justify-center rounded-xl ${s.color}`}>
                <s.icon className="h-5 w-5" />
              </div>
              <div className="mt-4 text-lg font-semibold">{s.title}</div>
              <p className="mt-1 text-sm text-muted-foreground leading-relaxed">{s.body}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* EXPORTS */}
      <section className="mx-auto max-w-6xl px-6 mt-24">
        <div className="grid md:grid-cols-3 gap-5">
          {[
            { icon: Plug, label: "MCP Server", code: "Add the hosted MCP URL to Claude / Cursor / Thiny" },
            { icon: Terminal, label: "Simulate first", code: "POST /api/simulate → devInspect on Sui" },
            { icon: Code2, label: "Unsigned PTB", code: "returns a base64 PTB — Thiny / wallet signs" },
          ].map((e) => (
            <motion.div
              key={e.label}
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              className="rounded-2xl border border-border/70 bg-card p-5 shadow-[var(--shadow-soft)]"
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <e.icon className="h-4 w-4 text-primary" /> {e.label}
              </div>
              <pre className="mt-3 rounded-lg bg-foreground/5 text-foreground/80 px-3 py-2 text-xs font-mono overflow-x-auto">
                $ {e.code}
              </pre>
            </motion.div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-6 mt-24">
        <div className="rounded-3xl border border-border/70 bg-card/70 backdrop-blur p-10 md:p-14 text-center shadow-[var(--shadow-float)] overflow-hidden relative">
          <div className="absolute inset-0 -z-10 opacity-70" style={{ backgroundImage: "var(--gradient-aura)" }} />
          <h2 className="text-4xl md:text-5xl font-display tracking-tight">Wire your first flow.</h2>
          <p className="mt-3 text-muted-foreground max-w-xl mx-auto">
            Live on Sui testnet. No wallet needed to design — connect when you're ready to ship.
          </p>
          <Link
            to="/builder"
            className="mt-7 inline-flex items-center gap-2 rounded-full bg-foreground text-background px-6 py-3 text-sm font-medium hover:opacity-90 transition"
          >
            Open the builder <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
