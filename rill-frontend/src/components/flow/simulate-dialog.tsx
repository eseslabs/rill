import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { X, Loader2, Check, AlertTriangle, Activity } from "lucide-react";
import type { Edge, Node } from "reactflow";
import type { ActionNodeData } from "./nodes";
import { buildFlowGraph } from "@/lib/flow-mapper";
import { rillApi, type ExecuteResult } from "@/lib/rill-api";
import { useCurrentAccount } from "@mysten/dapp-kit";

export type Guardrail = { id: string; label: string; enabled: boolean };

export const DEFAULT_GUARDRAILS: Guardrail[] = [
  { id: "max_in", label: "Max amount_in ≤ 100 SUI", enabled: true },
  { id: "slippage", label: "Slippage ≤ 1.0%", enabled: true },
  { id: "allowlist", label: "Recipient must be on allowlist", enabled: false },
  { id: "ttl", label: "Deadline within 60s", enabled: true },
  { id: "dry_run", label: "Require successful dry-run", enabled: true },
];

export function SimulateDialog({
  nodes,
  edges,
  guardrails,
  onChange,
  onClose,
}: {
  nodes: Node[];
  edges: Edge[];
  guardrails: Guardrail[];
  onChange: (g: Guardrail[]) => void;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<"idle" | "simulating" | "ok" | "fail">("idle");
  const [result, setResult] = useState<ExecuteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actions = nodes.filter((n) => n.type === "action").map((n) => n.data as ActionNodeData);
  const account = useCurrentAccount();

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setPhase("simulating");
      setError(null);
      setResult(null);

      const { nodes: flowNodes, edges: flowEdges, skipped } = buildFlowGraph(nodes, edges);

      if (flowNodes.length === 0) {
        setPhase("fail");
        setError(
          skipped.length
            ? `Backend supports Cetus swap + Haedal stake only. Skipped: ${skipped.join(", ")}`
            : "Add a Cetus swap or Haedal stake node to simulate.",
        );
        return;
      }

      try {
        const data = await rillApi.execute({ nodes: flowNodes, edges: flowEdges }, false, account?.address);
        if (cancelled) return;
        setResult(data);
        setPhase(data.simulation.ok ? "ok" : "fail");
        if (!data.simulation.ok) {
          setError(data.simulation.error ?? "Simulation failed");
        }
      } catch (err) {
        if (cancelled) return;
        setPhase("fail");
        setError(err instanceof Error ? err.message : "Failed to reach Rill API");
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [nodes, edges, account?.address]);

  const toggle = (id: string) => onChange(guardrails.map((g) => (g.id === id ? { ...g, enabled: !g.enabled } : g)));

  const previewText =
    result?.preview ??
    actions
      .map(
        (a, i) =>
          `// step ${i + 1} · ${a.protocol}::${a.action}\n// (compile via Rill API for real PTB)`,
      )
      .join("\n");

  const gasSui = result?.simulation.gasEstimate
    ? (result.simulation.gasEstimate / 1e9).toFixed(4)
    : null;

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
        transition={{ duration: 0.22 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl rounded-2xl bg-card border border-border shadow-[var(--shadow-float)] overflow-hidden"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <div className="text-xs uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
              <Activity className="h-3 w-3" /> Live simulation · {rillApi.baseUrl}
            </div>
            <h3 className="font-display text-2xl tracking-tight">Dry-run & guardrails</h3>
          </div>
          <button onClick={onClose} className="rounded-full p-1.5 hover:bg-secondary">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid md:grid-cols-2 gap-0">
          <div className="p-5 border-r border-border">
            <div className="text-xs uppercase tracking-widest text-muted-foreground">PTB preview</div>
            <pre className="mt-2 rounded-xl bg-foreground/5 border border-border p-3 text-[11px] font-mono overflow-auto max-h-[320px] whitespace-pre-wrap">
              {previewText}
            </pre>
            {result?.unsignedPtb && (
              <div className="mt-2 text-[10px] text-muted-foreground font-mono truncate">
                unsignedPtb: {result.unsignedPtb.slice(0, 48)}…
              </div>
            )}
            <div className="mt-3 flex items-center gap-2 text-sm">
              {phase === "simulating" && (
                <>
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  <span className="text-muted-foreground">devInspect via Rill backend…</span>
                </>
              )}
              {phase === "ok" && (
                <>
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-mint text-mint-foreground">
                    <Check className="h-3 w-3" />
                  </span>
                  <span>
                    Dry-run OK · gas ≈ <span className="font-mono">{gasSui} SUI</span>
                    {result?.simulation.simulatedViaFallback && " (estimated)"}
                  </span>
                </>
              )}
              {phase === "fail" && (
                <>
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-peach text-peach-foreground">
                    <AlertTriangle className="h-3 w-3" />
                  </span>
                  <span className="text-peach-foreground">{error ?? "Simulation failed"}</span>
                </>
              )}
            </div>
          </div>

          <div className="p-5">
            <div className="text-xs uppercase tracking-widest text-muted-foreground">Guardrails</div>
            <p className="mt-1 text-xs text-muted-foreground">
              Enforced at sign time (Thiny policy + on-chain agent_wallet).
            </p>
            <div className="mt-3 space-y-1.5">
              {guardrails.map((g) => (
                <label
                  key={g.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/60 px-3 py-2 cursor-pointer hover:bg-secondary/60"
                >
                  <span className="text-sm">{g.label}</span>
                  <input
                    type="checkbox"
                    checked={g.enabled}
                    onChange={() => toggle(g.id)}
                    className="accent-primary"
                  />
                </label>
              ))}
            </div>
            <div className="mt-4 rounded-xl bg-sky/30 text-sky-foreground p-3 text-[11px]">
              Rill returns an <strong>unsigned PTB</strong> — keyless backend. Thiny signs and submits;
              agent_wallet enforces budget on-chain.
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
