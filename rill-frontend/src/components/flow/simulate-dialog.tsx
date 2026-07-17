import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { X, Loader2, Check, AlertTriangle, Activity, ShieldOff } from "lucide-react";
import type { Edge, Node } from "reactflow";
import type { ActionNodeData, GuardrailNodeData } from "./nodes";
import { buildFlowGraph } from "@/lib/flow-mapper";
import { rillApi, type SimulationResult } from "@/lib/rill-api";
import { CAPABILITY_COPY, guardrailGateReason, isGuardrailMinValueValid } from "@/lib/publish-gate";
import { FlowWarningsBanner } from "@/components/flow/flow-warnings";

function getSimulationPhase(simulation: SimulationResult): "ok" | "fail" | "unverified" {
  if (simulation.verification === "unverified") {
    return "unverified";
  }

  if (simulation.ok) {
    return "ok";
  }

  return "fail";
}

function coinSymbol(coinType?: string): string {
  if (!coinType) return "SUI";
  const parts = coinType.split("::");
  return parts[parts.length - 1] || coinType;
}

export function SimulateDialog({
  nodes,
  edges,
  onClose,
}: {
  nodes: Node[];
  edges: Edge[];
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<"idle" | "simulating" | "ok" | "fail" | "unverified">("idle");
  const [result, setResult] = useState<{
    unsignedPtb: string;
    preview: string;
    simulation: SimulationResult;
    warnings: string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actions = nodes.filter((n) => n.type === "action").map((n) => n.data as ActionNodeData);
  const guardrailNodes = nodes.filter((n) => n.type === "guardrail");

  const graph = useMemo(() => buildFlowGraph(nodes, edges), [nodes, edges]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setPhase("simulating");
      setError(null);
      setResult(null);

      // A guardrail with no real floor is a no-op — don't run a "simulation" that
      // implies protection which isn't actually there (R1).
      const blockedReason = guardrailGateReason(nodes);
      if (blockedReason) {
        setPhase("fail");
        setError(blockedReason);
        return;
      }

      if (graph.nodes.length === 0) {
        setPhase("fail");
        setError(
          graph.skipped.length > 0
            ? CAPABILITY_COPY.simulateSkipped(graph.skipped)
            : CAPABILITY_COPY.simulateEmpty,
        );
        return;
      }

      try {
        const data = await rillApi.simulate({ nodes: graph.nodes, edges: graph.edges });
        if (cancelled) return;
        setResult(data);
        setPhase(getSimulationPhase(data.simulation));
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
  }, [nodes, edges, graph]);

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
      className="fixed inset-0 z-50 cursor-pointer bg-foreground/30 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.98 }}
        transition={{ duration: 0.22 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl cursor-default rounded-2xl bg-card border border-border shadow-[var(--shadow-float)] overflow-hidden"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <div className="text-xs uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
              <Activity className="h-3 w-3" /> Live simulation · {rillApi.baseUrl}
            </div>
            <h3 className="font-display text-2xl tracking-tight">Dry-run & guardrails</h3>
          </div>
          <button onClick={onClose} className="cursor-pointer rounded-full p-1.5 hover:bg-secondary">
            <X className="h-4 w-4" />
          </button>
        </div>

        {(graph.skipped.length > 0 || graph.skippedEdges.length > 0) && (
          <div className="px-5 pt-4">
            <FlowWarningsBanner skippedNodes={graph.skipped} skippedEdges={graph.skippedEdges} />
          </div>
        )}

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
                  </span>
                </>
              )}
              {phase === "unverified" && (
                <>
                  <AlertTriangle className="h-4 w-4 text-peach-foreground" />
                  <span className="text-peach-foreground">
                    Simulation unverified: {result?.simulation.error ?? "No reason returned by backend"}. Signing is blocked.
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
            {result?.warnings && result.warnings.length > 0 && (
              <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-400">
                Backend warnings: {result.warnings.join(" · ")}
              </p>
            )}
          </div>

          <div className="p-5">
            <div className="text-xs uppercase tracking-widest text-muted-foreground">Enforced at execution</div>
            <p className="mt-1 text-xs text-muted-foreground">
              Read-only — what actually runs, not a toggle. Add or edit a guardrail node on the canvas to change it.
            </p>
            <div className="mt-3 space-y-1.5">
              {guardrailNodes.length === 0 && (
                <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                  No guardrails on this flow — actions execute without a minimum-output floor.
                </p>
              )}
              {guardrailNodes.map((n) => {
                const gData = n.data as GuardrailNodeData;
                const valid = isGuardrailMinValueValid(gData.minValue);
                return (
                  <div
                    key={n.id}
                    className={`rounded-lg border px-3 py-2 text-xs ${
                      valid ? "border-border bg-background/60" : "border-destructive/40 bg-destructive/5"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">Guardrail</span>
                      {!valid && (
                        <span className="inline-flex items-center gap-1 text-[10px] text-destructive">
                          <ShieldOff className="h-3 w-3" /> not enforced
                        </span>
                      )}
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                      min {gData.minValue?.trim() ? gData.minValue : "(unset)"} · {coinSymbol(gData.coinType)}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-4 rounded-xl bg-sky/30 text-sky-foreground p-3 text-[11px]">
              Rill returns an <strong>unsigned PTB</strong> — keyless backend. Thiny signs and submits;
              agent_wallet enforces budget on-chain.
            </div>
            <div className="mt-2 rounded-xl bg-amber-400/10 border border-amber-400/30 text-amber-800 dark:text-amber-300 p-3 text-[11px]">
              This flow runs without an agent-wallet budget binding — the builder can't attach an{" "}
              <code>agentWallet</code> id yet, so execution isn't capped by an on-chain spend policy beyond
              what's wired above.
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
