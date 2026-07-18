import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, ArrowRight, ShieldCheck, Boxes, BrainCircuit } from "lucide-react";
import { SiteHeader } from "@/components/site-chrome";

export const Route = createFileRoute("/pitch")({
  head: () => ({
    meta: [
      { title: "Pitch — Rill" },
      { name: "description", content: "Rill — software for agents on Sui. The pitch in eight slides." },
      { property: "og:title", content: "Pitch — Rill" },
      { property: "og:description", content: "Rill — software for agents on Sui." },
    ],
  }),
  component: PitchPage,
});

const AGENT_WALLET = "0xd9265581b6b930f5fd27d9ec98e67b48f876f5de7bd25155639d808e9da636da";
const RILL_GUARD = "0xadec99557cf7771bce94737fdd3ea0bcc989d81e0860f3e69af55433dae8c034";

/** Each slide is a kicker + a render fn. Keep them punchy — a deck, not a doc. */
const slides: { kicker: string; render: () => React.ReactNode }[] = [
  {
    kicker: "Sui Overflow 2026 · Agentic Web",
    render: () => (
      <div className="text-center">
        <div className="text-xs uppercase tracking-[0.3em] text-muted-foreground">Software for Agents</div>
        <h1 className="mt-4 font-display text-7xl md:text-8xl tracking-tight">Rill</h1>
        <p className="mx-auto mt-6 max-w-2xl text-xl md:text-2xl text-muted-foreground leading-relaxed">
          The transaction layer for AI agents on Sui — so any agent can safely transact with any protocol.
        </p>
        <div className="mt-8 inline-flex items-center gap-2 rounded-full border border-border/60 px-4 py-1.5 text-sm text-muted-foreground">
          No hallucinated params · no human in the loop · bounded on-chain
        </div>
      </div>
    ),
  },
  {
    kicker: "The shift",
    render: () => (
      <div className="mx-auto max-w-3xl">
        <blockquote className="font-display text-4xl md:text-5xl leading-tight tracking-tight">
          “The next wave of internet users will be{" "}
          <span className="text-primary">AI agents, not humans.</span>”
        </blockquote>
        <p className="mt-6 text-lg text-muted-foreground">
          Today's software was built for humans clicking — for agents it's slow, inconsistent, brittle.
          <span className="text-foreground"> Every major category needs to be rebuilt for agents.</span>
        </p>
        <p className="mt-4 text-sm text-muted-foreground">— Y Combinator, RFS: Software for Agents</p>
      </div>
    ),
  },
  {
    kicker: "The problem",
    render: () => (
      <div className="mx-auto max-w-4xl">
        <h2 className="font-display text-4xl md:text-5xl tracking-tight">On-chain finance was built for humans.</h2>
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {[
            { t: "Semantic gap", d: "ABIs expose arg0, arg1, arg2 — agents guess and build the wrong transaction." },
            { t: "The approve wall", d: "Every action needs a human signature, or a raw key that can drain the wallet." },
            { t: "Fragmentation", d: "Cetus, DeepBook, Haedal — each ships a different SDK written for humans." },
          ].map((c) => (
            <div key={c.t} className="rounded-xl border border-border/60 bg-card p-5 text-left">
              <div className="font-display text-xl">{c.t}</div>
              <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{c.d}</p>
            </div>
          ))}
        </div>
      </div>
    ),
  },
  {
    kicker: "The solution",
    render: () => (
      <div className="mx-auto max-w-3xl">
        <h2 className="font-display text-4xl md:text-5xl tracking-tight">
          Rill rebuilds it for agents as <span className="text-primary">first-class citizens.</span>
        </h2>
        <ul className="mt-8 space-y-4 text-lg">
          {[
            ["Machine-readable", "one flow, exposed as MCP · REST · Skill — paste it into any agent."],
            ["Self-describing", "semantic parameters, so agents stop hallucinating."],
            ["Keyless", "Rill builds + simulates the PTB; it never holds your key."],
            ["Safe unattended", "two on-chain chokepoints bound every action."],
          ].map(([t, d]) => (
            <li key={t} className="flex gap-3">
              <ArrowRight className="mt-1.5 h-4 w-4 shrink-0 text-primary" />
              <span><span className="font-medium">{t}</span> — <span className="text-muted-foreground">{d}</span></span>
            </li>
          ))}
        </ul>
      </div>
    ),
  },
  {
    kicker: "Why it's safe",
    render: () => (
      <div className="mx-auto max-w-4xl">
        <h2 className="font-display text-4xl md:text-5xl tracking-tight">Two on-chain chokepoints.</h2>
        <p className="mt-3 text-muted-foreground">Deterministic Move objects — not a prompt rule.</p>
        <div className="mt-10 grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-border/60 bg-card p-6 text-left">
            <ShieldCheck className="h-6 w-6 text-primary" />
            <div className="mt-3 font-display text-2xl">agent_wallet</div>
            <p className="mt-2 text-sm text-muted-foreground">Capped, revocable budget: budget · per-tx max · protocol scope · expiry · owner revoke. Every spend flows through <code>spend()</code>.</p>
          </div>
          <div className="rounded-xl border border-border/60 bg-card p-6 text-left">
            <Boxes className="h-6 w-6 text-primary" />
            <div className="mt-3 font-display text-2xl">rill_guard</div>
            <p className="mt-2 text-sm text-muted-foreground">On-chain slippage floor: <code>assert_min_value</code> aborts any swap below the caller's minimum — sandwich/MEV backstop, injected automatically.</p>
          </div>
        </div>
      </div>
    ),
  },
  {
    kicker: "Proven on-chain",
    render: () => (
      <div className="mx-auto max-w-3xl">
        <h2 className="font-display text-4xl md:text-5xl tracking-tight">Battle-tested on testnet.</h2>
        <div className="mt-8 grid gap-3 sm:grid-cols-2 text-left text-sm">
          {[
            "3 protocol adapters — Cetus, Haedal, DeepBook — executed on-chain",
            "agent_wallet — 10 Move unit tests + 7 live scenarios (all abort codes, revoke, expiry)",
            "rill_guard — Move tests + live slippage abort",
            "Full build → sign → submit proven via @rill/signer + MCP SDK",
          ].map((t) => (
            <div key={t} className="rounded-lg border border-border/60 bg-card p-4 text-muted-foreground">{t}</div>
          ))}
        </div>
        <div className="mt-6 space-y-1 font-mono text-xs text-muted-foreground">
          <div>agent_wallet · <span className="text-foreground">{AGENT_WALLET.slice(0, 18)}…</span></div>
          <div>rill_guard&nbsp;&nbsp; · <span className="text-foreground">{RILL_GUARD.slice(0, 18)}…</span></div>
        </div>
      </div>
    ),
  },
  {
    kicker: "The stack",
    render: () => (
      <div className="mx-auto max-w-3xl">
        <h2 className="font-display text-4xl md:text-5xl tracking-tight">One agent stack for Sui.</h2>
        <div className="mt-10 grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-border/60 bg-card p-6 text-left">
            <div className="font-display text-2xl">Rill</div>
            <p className="mt-1 text-xs uppercase tracking-widest text-muted-foreground">tools / cockpit</p>
            <p className="mt-3 text-sm text-muted-foreground">Safe transactions for any agent — keyless build, bounded on-chain.</p>
          </div>
          <div className="rounded-xl border border-border/60 bg-card p-6 text-left">
            <BrainCircuit className="h-6 w-6 text-primary" />
            <div className="mt-3 font-display text-2xl">Thiny</div>
            <p className="mt-1 text-xs uppercase tracking-widest text-muted-foreground">runtime</p>
            <p className="mt-3 text-sm text-muted-foreground">An agent that remembers via Walrus and signs via Sui.</p>
          </div>
        </div>
        <p className="mt-8 text-lg text-muted-foreground">
          An autonomous agent that trades on DeepBook within on-chain caps — and keeps a verifiable memory on Walrus.
        </p>
      </div>
    ),
  },
  {
    kicker: "The ask",
    render: () => (
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="font-display text-5xl md:text-6xl tracking-tight">Something agents want.</h2>
        <p className="mx-auto mt-6 max-w-xl text-xl text-muted-foreground">
          The software agents depend on to move money on Sui — built agent-first.
        </p>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <Link to="/builder" className="inline-flex items-center gap-1.5 rounded-full bg-foreground text-background px-5 py-2.5 text-sm font-medium hover:opacity-90 transition">
            Open the builder <ArrowRight className="h-4 w-4" />
          </Link>
          <a href="https://api.rill.naisu.one" target="_blank" rel="noreferrer" className="rounded-full border border-border/60 px-5 py-2.5 text-sm text-muted-foreground hover:text-foreground transition">
            Live API
          </a>
        </div>
      </div>
    ),
  },
];

function PitchPage() {
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
