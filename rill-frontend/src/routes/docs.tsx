import { createFileRoute, Link } from "@tanstack/react-router";
import { SiteHeader, SiteFooter } from "@/components/site-chrome";

export const Route = createFileRoute("/docs")({
  head: () => ({
    meta: [
      { title: "Docs — Rill" },
      { name: "description", content: "Learn how Rill turns Sui dApps into agent-callable tools." },
      { property: "og:title", content: "Docs — Rill" },
      { property: "og:description", content: "Learn how Rill turns Sui dApps into agent-callable tools." },
    ],
  }),
  component: DocsPage,
});

function DocsPage() {
  return (
    <div className="min-h-screen">
      <SiteHeader />
      <section className="mx-auto max-w-3xl px-6 pt-14 pb-10">
        <div className="text-xs uppercase tracking-widest text-muted-foreground">Docs</div>
        <h1 className="mt-2 font-display text-5xl tracking-tight">Getting started</h1>
        <div className="prose prose-neutral mt-8 max-w-none">
          <p className="text-lg text-muted-foreground leading-relaxed">
            Rill gives AI agents a clean, typed surface over Sui protocols. You design the flow once; agents call it forever.
          </p>

          <h2 className="font-display text-2xl mt-10">1 · Compose</h2>
          <p className="text-muted-foreground">
            Open the <Link to="/builder" className="text-foreground underline underline-offset-4">builder</Link>, drag actions from the sidebar,
            and wire them between the <em>Agent prompt</em> trigger and the <em>MCP Server</em> output.
          </p>

          <h2 className="font-display text-2xl mt-10">2 · Configure</h2>
          <p className="text-muted-foreground">
            Each action has typed inputs. Pin static values, or expose them so the agent decides. Rill handles validation and
            transaction construction for Sui testnet automatically.
          </p>

          <h2 className="font-display text-2xl mt-10">3 · Export</h2>
          <p className="text-muted-foreground">
            Click <strong>Export</strong> and pick a target — MCP server, Claude/agent skill, or CLI. Drop the artifact next to your agent
            and you're done.
          </p>

          <h2 className="font-display text-2xl mt-10">Runtime</h2>
          <p className="text-muted-foreground">
            Rill speaks the Sui TypeScript SDK under the hood and uses the standard Sui wallet kit for signing. Testnet is enabled by
            default; mainnet ships post-hackathon.
          </p>
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}
