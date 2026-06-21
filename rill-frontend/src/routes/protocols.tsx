import { createFileRoute, Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { SiteHeader, SiteFooter } from "@/components/site-chrome";
import { PROTOCOLS } from "@/lib/protocols";

export const Route = createFileRoute("/protocols")({
  head: () => ({
    meta: [
      { title: "Protocols — Rill" },
      { name: "description", content: "Browse Sui protocols available as nodes in Rill." },
      { property: "og:title", content: "Protocols — Rill" },
      { property: "og:description", content: "Browse Sui protocols available as nodes in Rill." },
    ],
  }),
  component: ProtocolsPage,
});

const colorMap: Record<string, string> = {
  mint: "bg-mint text-mint-foreground",
  peach: "bg-peach text-peach-foreground",
  sky: "bg-sky text-sky-foreground",
  lilac: "bg-lilac text-lilac-foreground",
};

function ProtocolsPage() {
  return (
    <div className="min-h-screen">
      <SiteHeader />
      <section className="mx-auto max-w-6xl px-6 pt-14 pb-10">
        <div className="text-xs uppercase tracking-widest text-muted-foreground">Library</div>
        <h1 className="mt-2 font-display text-5xl tracking-tight">Sui protocols, agent-ready.</h1>
        <p className="mt-4 max-w-2xl text-muted-foreground text-lg leading-relaxed">
          Every protocol exposes a set of typed actions. Drop them into the builder and Rill handles the boring parts —
          transactions, signing, validation, and the agent-facing schema.
        </p>

        <div className="mt-10 grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {PROTOCOLS.map((p, i) => (
            <motion.div
              key={p.id}
              initial={{ opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{ delay: i * 0.04, duration: 0.5 }}
              className="rounded-2xl border border-border/70 bg-card p-5 shadow-[var(--shadow-soft)] hover:shadow-[var(--shadow-float)] transition"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className={`inline-flex items-center gap-1.5 rounded-full ${colorMap[p.color]} px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider`}>
                    {p.category}
                  </div>
                  <div className="mt-3 text-xl font-semibold">{p.name}</div>
                  <div className="text-sm text-muted-foreground mt-0.5">{p.tagline}</div>
                </div>
                <div className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded-md font-mono">
                  {p.actions.length} actions
                </div>
              </div>
              <div className="mt-4 space-y-1.5">
                {p.actions.slice(0, 3).map((a) => (
                  <div key={a.id} className="flex items-center justify-between text-sm">
                    <span className="text-foreground/80">{a.name}</span>
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{a.inputs.length} inputs</span>
                  </div>
                ))}
              </div>
            </motion.div>
          ))}
        </div>

        <div className="mt-14 flex justify-center">
          <Link
            to="/builder"
            className="inline-flex items-center gap-2 rounded-full bg-foreground text-background px-5 py-2.5 text-sm font-medium hover:opacity-90 transition"
          >
            Start composing <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}
