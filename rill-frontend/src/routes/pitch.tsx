import { Fragment, useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import ReactFlow, { Background, BackgroundVariant, type Edge, type Node } from "reactflow";
import {
  ArrowLeft,
  ArrowRight,
  ShieldCheck,
  Boxes,
  Blocks,
  KeyRound,
  Layers,
  Check,
  X,
  AppWindow,
  Wallet,
  PenLine,
  Box,
  SquareTerminal,
  Share2,
  Bot,
  Workflow,
  FileText,
  Plus,
  Waves,
  UserRound,
} from "lucide-react";
import { Claude, Codex, Cursor, HermesAgent, OpenClaw, OpenCode } from "@lobehub/icons";
import type { IconType } from "@lobehub/icons/es/types";
import { SiteHeader } from "@/components/site-chrome";
import { cn } from "@/lib/utils";
import { RillMark } from "@/components/rill-mark";
import { ProtocolLogo } from "@/components/flow/protocol-logo";
import { ActionNode, TriggerNode, OutputNode } from "@/components/flow/nodes";

export const Route = createFileRoute("/pitch")({
  head: () => ({
    meta: [
      { title: "Pitch — Rill" },
      {
        name: "description",
        content:
          "Rill makes Sui agent-native — a safe transaction layer for AI agents. The pitch in fifteen slides.",
      },
      { property: "og:title", content: "Pitch — Rill" },
      { property: "og:description", content: "Rill — software for agents on Sui." },
    ],
  }),
  component: PitchPage,
});

const AGENT_WALLET = "0xd9265581b6b930f5fd27d9ec98e67b48f876f5de7bd25155639d808e9da636da";
const RILL_GUARD = "0xadec99557cf7771bce94737fdd3ea0bcc989d81e0860f3e69af55433dae8c034";

/** Icon-step pipeline diagram, shared by the "human-first" vs "agent-first" slides. */
function PipelineFlow({
  steps,
  tone,
}: {
  steps: { label: string; sub?: string; Icon: typeof AppWindow; Icon2?: typeof AppWindow }[];
  tone: "muted" | "primary";
}) {
  return (
    <div className="flex items-center justify-center gap-2 sm:gap-3">
      {steps.map((s, idx) => (
        <Fragment key={s.label}>
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ delay: idx * 0.12, duration: 0.4, ease: "easeOut" }}
            className="flex flex-col items-center gap-2"
          >
            <div
              className={cn(
                "relative flex h-16 items-center justify-center rounded-2xl border shadow-sm",
                s.Icon2 ? "w-20" : "w-16",
                tone === "primary"
                  ? "border-primary/40 bg-primary/5 text-primary shadow-primary/20"
                  : "border-border/60 bg-card text-foreground",
              )}
            >
              {tone === "primary" && (
                <motion.span
                  aria-hidden
                  className="absolute inset-0 rounded-2xl bg-primary/15"
                  animate={{ opacity: [0.35, 0, 0.35] }}
                  transition={{
                    duration: 2.2,
                    repeat: Infinity,
                    delay: idx * 0.25,
                    ease: "easeInOut",
                  }}
                />
              )}
              {s.Icon2 ? (
                <span className="relative flex items-center gap-1">
                  <s.Icon className="h-5 w-5" strokeWidth={2} />
                  <Plus className="h-3 w-3 opacity-60" strokeWidth={2.5} />
                  <s.Icon2 className="h-5 w-5" strokeWidth={2} />
                </span>
              ) : (
                <s.Icon className="relative h-6 w-6" strokeWidth={2} />
              )}
            </div>
            <span className="flex max-w-[8.5rem] flex-col items-center text-center leading-snug">
              <span
                className={cn(
                  "text-xs",
                  tone === "primary" ? "font-medium text-primary" : "text-muted-foreground",
                )}
              >
                {s.label}
              </span>
              {s.sub && <span className="text-[10px] text-muted-foreground">{s.sub}</span>}
            </span>
          </motion.div>
          {idx < steps.length - 1 && (
            <motion.div
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: idx * 0.12 + 0.2, duration: 0.3 }}
              className="mb-6"
            >
              <ArrowRight
                className={cn(
                  "h-4 w-4 shrink-0",
                  tone === "primary" ? "text-primary/70" : "text-muted-foreground",
                )}
              />
            </motion.div>
          )}
        </Fragment>
      ))}
    </div>
  );
}

/** Each slide is a kicker + a render fn. Keep them punchy — a deck, not a doc. */
export const pitchSlides: { kicker: string; render: () => React.ReactNode }[] = [
  {
    kicker: "Sui Overflow 2026 · Agentic Web",
    render: () => (
      <div className="text-center">
        <motion.img
          src="/rill-logo.png"
          alt="Rill"
          initial={{ opacity: 0, scale: 0.7, y: -8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="mx-auto h-20 w-20 rounded-2xl shadow-lg shadow-primary/25 md:h-24 md:w-24"
        />
        <motion.h1
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1, duration: 0.5, ease: "easeOut" }}
          className="mt-6 font-display text-7xl md:text-8xl tracking-tight"
        >
          Rill
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.5, ease: "easeOut" }}
          className="mx-auto mt-6 max-w-2xl text-xl leading-relaxed text-muted-foreground md:text-2xl"
        >
          Turn every Sui protocol into{" "}
          <span className="font-medium text-foreground">agent actions.</span>
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.32, duration: 0.5, ease: "easeOut" }}
          className="mt-5 inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-4 py-1.5 text-sm font-medium text-primary shadow-sm shadow-primary/10"
        >
          <RillMark className="h-3.5 w-3.5" />
          The protocol for agents layer.
        </motion.div>
      </div>
    ),
  },
  {
    kicker: "The setup",
    render: () => (
      <div className="mx-auto max-w-4xl">
        <h2 className="font-display text-4xl md:text-5xl tracking-tight">AI is getting smarter.</h2>
        <div className="mt-10 grid items-start gap-8 text-left md:grid-cols-2">
          <div>
            <div className="text-xs uppercase tracking-widest text-muted-foreground">
              Today's agents
            </div>
            <ul className="mt-4 space-y-3">
              {[
                { name: "Claude", Icon: Claude },
                { name: "OpenAI Codex", Icon: Codex },
                { name: "Cursor", Icon: Cursor },
                { name: "Hermes", Icon: HermesAgent },
                { name: "OpenClaw", Icon: OpenClaw },
                { name: "OpenCode", Icon: OpenCode },
              ].map(({ name, Icon }) => (
                <li key={name} className="flex items-center gap-3 text-lg">
                  <Icon size={22} className="shrink-0" /> {name}
                </li>
              ))}
            </ul>
          </div>
          <table className="w-full overflow-hidden rounded-xl border border-border/60 bg-card text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left">
                <th className="px-4 py-3 font-medium">Can</th>
                <th className="w-24 border-l border-border/60 px-4 py-3 text-center font-medium">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ["Write smart contracts", true],
                  ["Deploy applications", true],
                  ["Read documentation", true],
                  ["Use DeepBook", false],
                  ["Swap on Cetus", false],
                  ["Stake on Haedal", false],
                  ["Lend on Navi Protocol", false],
                ] as [string, boolean][]
              ).map(([label, ok]) => (
                <tr key={label} className="border-b border-border/40 last:border-b-0">
                  <td className="px-4 py-2.5 text-muted-foreground">{label}</td>
                  <td className="border-l border-border/40 px-4 py-2.5">
                    {ok ? (
                      <span className="mx-auto flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500">
                        <Check className="h-3 w-3 text-white" strokeWidth={3} />
                      </span>
                    ) : (
                      <X className="mx-auto h-4 w-4 text-red-500" strokeWidth={3} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    ),
  },
  {
    kicker: "Built for humans",
    render: () => (
      <div className="mx-auto max-w-3xl">
        <h2 className="font-display text-4xl md:text-5xl tracking-tight">
          Because Sui protocols were designed for <span className="text-red-500">humans.</span>
        </h2>
        <div className="mt-12">
          <PipelineFlow
            tone="muted"
            steps={[
              { label: "Frontend", Icon: AppWindow },
              { label: "Wallet", Icon: Wallet },
              { label: "Approve", Icon: PenLine },
              { label: "Execute", Icon: Box },
            ]}
          />
        </div>
      </div>
    ),
  },
  {
    kicker: "A different interface",
    render: () => (
      <div className="mx-auto max-w-3xl">
        <h2 className="font-display text-4xl md:text-5xl tracking-tight">
          <span className="text-primary">AI agents</span> need a different interface.
        </h2>
        <div className="mt-12 grid grid-cols-3 gap-4 sm:gap-6">
          {[
            { label: "SKILL.md", Icon: FileText },
            { label: "MCP", Icon: Share2 },
            { label: "CLIs", Icon: SquareTerminal },
          ].map(({ label, Icon }, idx) => (
            <motion.div
              key={label}
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ delay: idx * 0.1, duration: 0.4, ease: "easeOut" }}
              className="relative flex flex-col items-center gap-3 rounded-2xl border border-primary/40 bg-primary/5 p-6 shadow-sm shadow-primary/20"
            >
              <motion.span
                aria-hidden
                className="absolute inset-0 rounded-2xl bg-primary/15"
                animate={{ opacity: [0.35, 0, 0.35] }}
                transition={{
                  duration: 2.2,
                  repeat: Infinity,
                  delay: idx * 0.25,
                  ease: "easeInOut",
                }}
              />
              <Icon className="relative h-7 w-7 text-primary" strokeWidth={2} />
              <span className="relative text-sm font-medium text-primary">{label}</span>
            </motion.div>
          ))}
        </div>
      </div>
    ),
  },
  {
    kicker: "The shift",
    render: () => (
      <div className="mx-auto max-w-4xl text-center">
        <blockquote className="font-display text-4xl md:text-5xl leading-tight tracking-tight">
          “The next trillion users on the internet won't be people.{" "}
          <span className="text-primary">They'll be AI agents.</span>”
        </blockquote>
        <p className="mt-4 text-sm text-muted-foreground">
          — Aaron Epstein, Y Combinator · RFS: Software for Agents
        </p>
        <img
          src="/yc-thesis-highlight.png"
          alt="Y Combinator — Request for Startups: Software for Agents"
          className="mx-auto mt-8 w-full max-w-2xl rounded-xl border border-border/60 shadow-sm"
        />
      </div>
    ),
  },
  {
    kicker: "Meet Rill",
    render: () => {
      const Connector = () => (
        <div className="hidden items-center gap-1 text-muted-foreground md:flex">
          <div className="h-0 w-8 border-t border-dashed border-border" />
          <ArrowRight className="h-4 w-4" />
        </div>
      );
      const protocols: [string, string][] = [
        ["deepbook", "DeepBook"],
        ["cetus", "Cetus"],
        ["haedal", "Haedal"],
        ["navi", "Navi Protocol"],
      ];
      const agents: { name: string; Icon: IconType }[] = [
        { name: "Claude", Icon: Claude },
        { name: "Codex", Icon: Codex },
        { name: "Cursor", Icon: Cursor },
        { name: "Hermes", Icon: HermesAgent },
        { name: "OpenCode", Icon: OpenCode },
      ];
      return (
        <div className="mx-auto max-w-5xl">
          <div className="flex items-center justify-center gap-3">
            <RillMark className="h-8 w-8 text-primary" />
            <h2 className="font-display text-4xl md:text-5xl tracking-tight">
              Meet <span className="text-primary">Rill.</span>
            </h2>
          </div>
          <p className="mt-3 text-center text-lg text-muted-foreground">
            Turn every Sui protocol into{" "}
            <span className="text-foreground">reusable AI skills.</span>
          </p>

          <div className="mt-10 flex flex-col items-stretch justify-center gap-6 md:flex-row md:items-center">
            <div className="rounded-xl border border-border/60 bg-card p-5 text-left md:w-56">
              <div className="text-xs uppercase tracking-widest text-muted-foreground">
                Sui Protocols
              </div>
              <ul className="mt-4 space-y-3">
                {protocols.map(([id, name]) => (
                  <li key={id} className="flex items-center gap-3 text-base">
                    <ProtocolLogo protocolId={id} name={name} /> {name}
                  </li>
                ))}
                <li className="text-sm text-muted-foreground">…and more</li>
              </ul>
            </div>

            <Connector />

            <div className="flex shrink-0 flex-col items-center justify-center gap-2 self-center rounded-2xl border border-primary/40 bg-card px-8 py-6">
              <RillMark className="h-9 w-9 text-primary" />
              <span className="font-display text-3xl tracking-tight">Rill</span>
            </div>

            <Connector />

            <div className="rounded-xl border border-border/60 bg-card p-5 text-left md:w-56">
              <div className="text-xs uppercase tracking-widest text-muted-foreground">
                AI Agents
              </div>
              <ul className="mt-4 space-y-3">
                {agents.map(({ name, Icon }) => (
                  <li key={name} className="flex items-center gap-3 text-base">
                    <Icon size={22} className="shrink-0" /> {name}
                  </li>
                ))}
                <li className="text-sm text-muted-foreground">…and more</li>
              </ul>
            </div>
          </div>

          <div className="mt-8 rounded-lg border border-border/60 bg-card px-5 py-3 text-center text-sm text-muted-foreground">
            The <span className="text-primary">compilation layer</span> between AI agents and Sui
            protocols.
          </div>
        </div>
      );
    },
  },
  {
    kicker: "Reverse engineered",
    render: () => {
      const NodeChip = ({
        protocolId,
        label,
        sub,
      }: {
        protocolId: string;
        label: string;
        sub: string;
      }) => (
        <div className="flex items-center gap-1.5 rounded-lg border border-primary/30 bg-background px-2.5 py-1.5 text-xs">
          <ProtocolLogo protocolId={protocolId} name={sub} className="h-4 w-4" />
          <span className="font-medium text-foreground">{label}</span>
        </div>
      );
      return (
        <div className="mx-auto max-w-4xl text-center">
          <h2 className="font-display text-4xl md:text-5xl tracking-tight">
            Any transaction becomes <span className="text-primary">an AI skill.</span>
          </h2>
          <div className="mt-14 flex flex-col items-center justify-center gap-5 md:flex-row md:items-stretch md:gap-4">
            <motion.div
              initial={{ opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.4, ease: "easeOut" }}
              className="flex flex-col justify-center rounded-xl border border-border/60 bg-card px-5 py-4 text-left"
            >
              <div className="text-xs uppercase tracking-widest text-muted-foreground">
                Raw call args
              </div>
              <div className="mt-2.5 space-y-1 font-mono text-xs text-muted-foreground/70">
                <div>
                  arg0: <span className="text-muted-foreground">0x2::sui::SUI</span>
                </div>
                <div>
                  arg1: <span className="text-muted-foreground">47000000</span>
                </div>
                <div>
                  arg2: <span className="text-muted-foreground">0x8ba2481f3c9…</span>
                </div>
              </div>
            </motion.div>

            <div className="flex items-center justify-center gap-2">
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              <motion.div
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.15, duration: 0.4, ease: "easeOut" }}
                className="relative flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-primary/40 bg-primary/5 shadow-sm shadow-primary/20"
              >
                <motion.span
                  aria-hidden
                  className="absolute inset-0 rounded-2xl bg-primary/15"
                  animate={{ opacity: [0.35, 0, 0.35] }}
                  transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                />
                <RillMark className="relative h-6 w-6 text-primary" />
              </motion.div>
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </div>

            <motion.div
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.3, duration: 0.4, ease: "easeOut" }}
              className="flex flex-col justify-center rounded-xl border border-primary/40 bg-primary/5 p-4 text-left shadow-sm shadow-primary/20"
            >
              <div className="text-xs uppercase tracking-widest text-primary">Visual strategy</div>
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <NodeChip protocolId="cetus" label="Swap" sub="Cetus" />
                <ArrowRight className="h-3 w-3 shrink-0 text-primary/60" />
                <NodeChip protocolId="deepbook" label="Limit Order" sub="DeepBook" />
                <ArrowRight className="h-3 w-3 shrink-0 text-primary/60" />
                <NodeChip protocolId="haedal" label="Stake" sub="Haedal" />
              </div>
            </motion.div>
          </div>
          <div className="mt-10 rounded-lg border border-border/60 bg-card px-5 py-3 text-sm text-muted-foreground">
            <span className="text-foreground">Rill convert every transaction</span> into{" "}
            <span className="text-primary">reusable building blocks.</span>
          </div>
        </div>
      );
    },
  },
  {
    kicker: "Composable",
    render: () => {
      const Chip = ({
        protocolId,
        label,
        sub,
      }: {
        protocolId: string;
        label: string;
        sub: string;
      }) => (
        <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-card px-3 py-2.5 text-sm shadow-sm">
          <ProtocolLogo protocolId={protocolId} name={sub} />
          <span>
            <span className="font-medium">{label}</span>{" "}
            <span className="text-muted-foreground">({sub})</span>
          </span>
        </div>
      );
      const nodeTypes = { action: ActionNode, trigger: TriggerNode, output: OutputNode };
      const compositionNodes: Node[] = [
        {
          id: "t",
          type: "trigger",
          position: { x: 0, y: 70 },
          data: { label: "Strategy", sub: "Compose & simulate" },
        },
        {
          id: "a1",
          type: "action",
          position: { x: 230, y: 0 },
          data: {
            protocol: "Cetus",
            protocolId: "cetus",
            action: "Swap tokens",
            color: "mint",
            description: "Swap SUI → USDC via Cetus pools.",
            inputs: [{ key: "amount", label: "Amount", type: "number" }],
          },
        },
        {
          id: "a2",
          type: "action",
          position: { x: 480, y: 140 },
          data: {
            protocol: "DeepBook",
            protocolId: "deepbook",
            action: "Limit order",
            color: "sky",
            description: "Place a limit order on a DeepBook pool.",
            inputs: [{ key: "price", label: "Price", type: "number" }],
          },
        },
        {
          id: "a3",
          type: "action",
          position: { x: 730, y: 0 },
          data: {
            protocol: "Haedal",
            protocolId: "haedal",
            action: "Stake SUI",
            color: "lilac",
            description: "Stake SUI and mint haSUI.",
            inputs: [{ key: "amount", label: "Amount", type: "number" }],
          },
        },
        {
          id: "o",
          type: "output",
          position: { x: 980, y: 70 },
          data: { label: "One PTB", sub: "Atomic on-chain result" },
        },
      ];
      const compositionEdges: Edge[] = [
        { id: "e1", source: "t", target: "a1", animated: true },
        { id: "e2", source: "a1", target: "a2", animated: true },
        { id: "e3", source: "a2", target: "a3", animated: true },
        { id: "e4", source: "a3", target: "o", animated: true },
      ];
      return (
        <div className="mx-auto max-w-5xl text-center">
          <h2 className="font-display text-4xl md:text-5xl tracking-tight">
            Strategies become <span className="text-primary">composable.</span>
          </h2>
          <div className="mt-10 flex flex-col items-center gap-3">
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Chip protocolId="cetus" label="Swap" sub="Cetus" />
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              <Chip protocolId="deepbook" label="Limit Order" sub="DeepBook" />
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              <Chip protocolId="haedal" label="Stake" sub="Haedal" />
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Chip protocolId="navi" label="Borrow" sub="Navi" />
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              <Chip protocolId="navi" label="Supply" sub="Navi" />
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-dashed border-border/60 text-muted-foreground">
                <Plus className="h-4 w-4" />
              </div>
            </div>
          </div>
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.5, ease: "easeOut" }}
            className="mt-8 w-full overflow-hidden rounded-xl border border-border/60 bg-card"
            style={{ height: 440 }}
          >
            <ReactFlow
              nodes={compositionNodes}
              edges={compositionEdges}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous node data types vs ReactFlow's NodeTypes map; same pattern as builder.tsx
              nodeTypes={nodeTypes as any}
              fitView
              fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
              proOptions={{ hideAttribution: true }}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              panOnDrag={false}
              zoomOnScroll={false}
              zoomOnPinch={false}
              zoomOnDoubleClick={false}
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
            </ReactFlow>
          </motion.div>
          {/* <img
            src="/rill-studio-canvas.webp"
            alt="Rill Studio — visual canvas composing Cetus, Haedal, and DeepBook into one PTB"
            className="mx-auto mt-6 w-full max-w-2xl rounded-xl border border-border/60 shadow-sm"
          /> */}
          <div className="mt-8 rounded-lg border border-border/60 bg-card px-5 py-3 text-sm text-muted-foreground">
            Drag, compose and optimize <span className="text-primary">any onchain strategy.</span>
          </div>
        </div>
      );
    },
  },
  {
    kicker: "Compile to skill",
    render: () => (
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="font-display text-4xl md:text-5xl tracking-tight">
          Convert strategy into <span className="text-primary">agent-native artifacts.</span>
        </h2>
        <div className="mt-12">
          <PipelineFlow
            tone="primary"
            steps={[
              { label: "Strategy", sub: "Canvas", Icon: Workflow },
              { label: "PTB", sub: "Programmable Tx", Icon: Boxes },
              {
                label: "SKILL.md + MCP",
                sub: "Documentation + Server",
                Icon: FileText,
                Icon2: Share2,
              },
            ]}
          />
        </div>
        {/* <div className="mt-10 rounded-lg border border-border/60 bg-card px-5 py-3 text-sm text-muted-foreground">
          We're not exporting transactions.{" "}
          <span className="text-primary">We're compiling knowledge.</span>
        </div> */}
      </div>
    ),
  },
  // {
  //   kicker: "The problem",
  //   render: () => (
  //     <div className="mx-auto max-w-4xl">
  //       <h2 className="font-display text-4xl md:text-5xl tracking-tight">
  //         Agents can read Sui. They can't act on it safely.
  //       </h2>
  //       <div className="mt-10 grid gap-4 md:grid-cols-3">
  //         {[
  //           {
  //             t: "Semantic gap",
  //             d: "ABIs expose arg0, arg1, arg2 — agents guess and build the wrong transaction.",
  //           },
  //           {
  //             t: "The key wall",
  //             d: "Every action needs a human signature, or a raw key that can drain the whole wallet.",
  //           },
  //           {
  //             t: "Fragmentation",
  //             d: "Cetus, DeepBook, Haedal — each ships a different SDK written for humans.",
  //           },
  //         ].map((c) => (
  //           <div key={c.t} className="rounded-xl border border-border/60 bg-card p-5 text-left">
  //             <div className="font-display text-xl">{c.t}</div>
  //             <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{c.d}</p>
  //           </div>
  //         ))}
  //       </div>
  //     </div>
  //   ),
  // },
  // {
  //   kicker: "Why it's safe",
  //   render: () => (
  //     <div className="mx-auto max-w-4xl">
  //       <h2 className="font-display text-4xl md:text-5xl tracking-tight">
  //         Two on-chain chokepoints.
  //       </h2>
  //       <p className="mt-3 text-muted-foreground">
  //         Deterministic Move objects — not a prompt rule.
  //       </p>
  //       <div className="mt-10 grid gap-4 md:grid-cols-2">
  //         <div className="rounded-xl border border-border/60 bg-card p-6 text-left">
  //           <ShieldCheck className="h-6 w-6 text-primary" />
  //           <div className="mt-3 font-display text-2xl">agent_wallet</div>
  //           <p className="mt-2 text-sm text-muted-foreground">
  //             Capped, revocable budget: budget · per-tx max · protocol scope · expiry · owner
  //             revoke. Every spend flows through <code>spend()</code>.
  //           </p>
  //         </div>
  //         <div className="rounded-xl border border-border/60 bg-card p-6 text-left">
  //           <Boxes className="h-6 w-6 text-primary" />
  //           <div className="mt-3 font-display text-2xl">rill_guard</div>
  //           <p className="mt-2 text-sm text-muted-foreground">
  //             On-chain slippage floor: <code>assert_min_value</code> aborts any swap below the
  //             caller's minimum — sandwich/MEV backstop, injected automatically.
  //           </p>
  //         </div>
  //       </div>
  //     </div>
  //   ),
  // },
  {
    kicker: "Why Sui — and only Sui",
    render: () => (
      <div className="mx-auto max-w-4xl">
        <h2 className="font-display text-4xl md:text-5xl tracking-tight">
          This is only safe because of{" "}
          <span className="inline-flex items-center align-middle">
            <img src="/sui-logo.png" alt="Sui" className="h-9 md:h-11" />
          </span>
          .
        </h2>
        <p className="mt-3 text-muted-foreground">
          Not "because Sui is fast." Because of primitives no account-based chain has.
        </p>
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {[
            {
              icon: <Blocks className="h-6 w-6 text-primary" />,
              t: "Programmable Transaction Blocks",
              d: "Compose many protocol calls and inject a slippage guard into one atomic transaction. All-or-nothing.",
            },
            {
              icon: <KeyRound className="h-6 w-6 text-primary" />,
              t: "Object-capabilities",
              d: "Hand an agent a capped, revocable capability object — not a raw key. The chain enforces the budget.",
            },
            {
              icon: <Layers className="h-6 w-6 text-primary" />,
              t: "Composition, on-chain",
              d: "Multiple protocols, one PTB, one result. On an account-based chain you can't atomically bound and compose like this.",
            },
          ].map((c) => (
            <div key={c.t} className="rounded-xl border border-border/60 bg-card p-5 text-left">
              {c.icon}
              <div className="mt-3 font-display text-lg">{c.t}</div>
              <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{c.d}</p>
            </div>
          ))}
        </div>
      </div>
    ),
  },
  // {
  //   kicker: "Proven on-chain",
  //   render: () => (
  //     <div className="mx-auto max-w-3xl">
  //       <h2 className="font-display text-4xl md:text-5xl tracking-tight">
  //         Live on testnet — not a mockup.
  //       </h2>
  //       <div className="mt-8 grid gap-3 sm:grid-cols-2 text-left text-sm">
  //         {[
  //           "DeepBook limit order executed live via agent + MCP",
  //           "3 protocol adapters — Cetus, Haedal, DeepBook — compiled & executed on-chain",
  //           "agent_wallet — 10 Move unit tests + 7 live scenarios (all abort codes, revoke, expiry)",
  //           "rill_guard — Move tests + live slippage abort",
  //         ].map((t) => (
  //           <div
  //             key={t}
  //             className="rounded-lg border border-border/60 bg-card p-4 text-muted-foreground"
  //           >
  //             {t}
  //           </div>
  //         ))}
  //       </div>
  //       <div className="mt-6 space-y-1 font-mono text-xs text-muted-foreground">
  //         <div>
  //           agent_wallet · <span className="text-foreground">{AGENT_WALLET.slice(0, 18)}…</span>
  //         </div>
  //         <div>
  //           rill_guard&nbsp;&nbsp; ·{" "}
  //           <span className="text-foreground">{RILL_GUARD.slice(0, 18)}…</span>
  //         </div>
  //       </div>
  //     </div>
  //   ),
  // },
  {
    kicker: "The future",
    render: () => {
      const TimelineColumn = ({
        title,
        tone,
        items,
      }: {
        title: string;
        tone: "muted" | "primary";
        items: { label: string; Icon: typeof AppWindow }[];
      }) => (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: "easeOut", delay: tone === "primary" ? 0.15 : 0 }}
          className="flex flex-col items-center gap-3"
        >
          <span className="text-xs uppercase tracking-widest text-muted-foreground">{title}</span>
          <div
            className={cn(
              "flex flex-col items-center gap-2 rounded-2xl border p-4 shadow-sm",
              tone === "primary"
                ? "border-primary/40 bg-primary/5 shadow-primary/20"
                : "border-border/60 bg-card",
            )}
          >
            {items.map((it, idx) => (
              <Fragment key={it.label}>
                <div className="flex items-center gap-2">
                  <it.Icon
                    className={cn(
                      "h-4 w-4",
                      tone === "primary" ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                  <span
                    className={cn(
                      "text-sm",
                      tone === "primary" ? "font-medium text-primary" : "text-foreground",
                    )}
                  >
                    {it.label}
                  </span>
                </div>
                {idx < items.length - 1 && (
                  <div
                    className={cn("h-3 w-px", tone === "primary" ? "bg-primary/30" : "bg-border")}
                  />
                )}
              </Fragment>
            ))}
          </div>
        </motion.div>
      );
      return (
        <div className="mx-auto max-w-4xl">
          <h2 className="text-center font-display text-4xl tracking-tight md:text-left md:text-5xl">
            The future is <span className="text-primary">agent-native.</span>
          </h2>
          <div className="mt-10 grid items-center gap-10 md:grid-cols-2">
            <div className="flex items-center justify-center gap-4">
              <TimelineColumn
                title="Today"
                tone="muted"
                items={[
                  { label: "Protocol", Icon: Box },
                  { label: "Frontend", Icon: AppWindow },
                  { label: "Human", Icon: UserRound },
                ]}
              />
              <ArrowRight className="h-5 w-5 shrink-0 text-muted-foreground" />
              <TimelineColumn
                title="Tomorrow"
                tone="primary"
                items={[
                  { label: "Protocol", Icon: Box },
                  { label: "Rill", Icon: Waves },
                  { label: "Agent", Icon: Bot },
                ]}
              />
            </div>
            {/* <div className="text-center text-muted-foreground md:text-left">
              <p>Every protocol already has documentation, SDKs, and frontends.</p>
              <p className="mt-4">
                Soon, they'll also need machine-readable skills, reusable execution, and
                agent-native interfaces.
              </p>
              <p className="mt-4 font-medium text-primary">Rill makes that possible.</p>
            </div> */}
          </div>
        </div>
      );
    },
  },
  {
    kicker: "The ask",
    render: () => (
      <div className="mx-auto flex min-h-[70vh] max-w-3xl flex-col items-center justify-center text-center">
        <h2 className="font-display text-5xl md:text-6xl tracking-tight">
          Making something agents want.
        </h2>
        <p className="mx-auto mt-6 max-w-xl text-xl text-muted-foreground">
          The infrastructure agents need to move money on Sui — built agent-first, not bolted on.
        </p>
        <p className="mx-auto mt-6 max-w-xl font-display text-2xl">
          Rill makes every Sui protocol <span className="text-primary">agent-native.</span>
        </p>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <Link
            to="/builder"
            className="inline-flex items-center gap-1.5 rounded-full bg-foreground text-background px-5 py-2.5 text-sm font-medium hover:opacity-90 transition"
          >
            Open the builder <ArrowRight className="h-4 w-4" />
          </Link>
          <a
            href="https://api.rill.naisu.one"
            target="_blank"
            rel="noreferrer"
            className="rounded-full border border-border/60 px-5 py-2.5 text-sm text-muted-foreground hover:text-foreground transition"
          >
            Live API
          </a>
        </div>
      </div>
    ),
  },
];

function PitchPage() {
  const slides = pitchSlides;
  const [i, setI] = useState(0);
  const n = slides.length;
  const go = useCallback((d: number) => setI((p) => Math.min(n - 1, Math.max(0, p + d))), [n]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " ") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  return (
    <div className="min-h-screen flex flex-col">
      <SiteHeader />
      <main className="relative flex-1 overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.section
            key={i}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            transition={{ duration: 0.25 }}
            className="absolute inset-0 flex flex-col items-center justify-center px-6"
          >
            <div className="absolute top-6 left-6 text-xs uppercase tracking-[0.25em] text-muted-foreground">
              {slides[i].kicker}
            </div>
            {slides[i].render()}
          </motion.section>
        </AnimatePresence>

        {/* controls */}
        <div className="pointer-events-none absolute inset-x-0 bottom-6 flex items-center justify-center gap-6">
          <button
            onClick={() => go(-1)}
            disabled={i === 0}
            className="pointer-events-auto inline-flex h-9 w-9 items-center justify-center rounded-full border border-border/60 bg-background/70 backdrop-blur disabled:opacity-30 hover:text-foreground text-muted-foreground transition"
            aria-label="Previous slide"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-1.5">
            {slides.map((_, idx) => (
              <button
                key={idx}
                onClick={() => setI(idx)}
                className={`pointer-events-auto h-1.5 rounded-full transition-all ${idx === i ? "w-6 bg-foreground" : "w-1.5 bg-border"}`}
                aria-label={`Go to slide ${idx + 1}`}
              />
            ))}
          </div>
          <button
            onClick={() => go(1)}
            disabled={i === n - 1}
            className="pointer-events-auto inline-flex h-9 w-9 items-center justify-center rounded-full border border-border/60 bg-background/70 backdrop-blur disabled:opacity-30 hover:text-foreground text-muted-foreground transition"
            aria-label="Next slide"
          >
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
        <div className="absolute top-6 right-6 font-mono text-xs text-muted-foreground">
          {i + 1} / {n}
        </div>
      </main>
    </div>
  );
}
