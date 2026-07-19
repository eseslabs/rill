import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  Loader2,
  Check,
  AlertTriangle,
  Activity,
  ShieldOff,
  ShieldCheck,
  KeyRound,
  type LucideIcon,
} from "lucide-react";
import type { Edge, Node } from "reactflow";
import type { ActionNodeData, GuardrailNodeData } from "./nodes";
import { buildFlowGraph } from "@/lib/flow-mapper";
import { rillApi, type SimulationResult } from "@/lib/rill-api";
import { CAPABILITY_COPY, guardrailGateReason, isGuardrailMinValueValid } from "@/lib/publish-gate";
import { FlowWarningsBanner } from "@/components/flow/flow-warnings";
import { DialogShell } from "@/components/flow/dialog-shell";
import { useFlowRequest } from "@/lib/use-flow-request";

type SimulateResponse = {
  unsignedPtb: string;
  preview: string;
  simulation: SimulationResult;
  warnings: string[];
};

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
  open,
  onOpenChange,
}: {
  nodes: Node[];
  edges: Edge[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const actions = nodes.filter((n) => n.type === "action").map((n) => n.data as ActionNodeData);
  const guardrailNodes = nodes.filter((n) => n.type === "guardrail");
  const graph = useMemo(() => buildFlowGraph(nodes, edges), [nodes, edges]);

  // A guardrail with no real floor (or an empty/unsupported flow) is checked
  // synchronously, BEFORE ever hitting the network — running a "simulation"
  // against a no-op guard would imply protection that isn't actually there
  // (R1). This is kept separate from useFlowRequest's own error state so a
  // gate failure never depends on (or races) a network round-trip.
  const [gateError, setGateError] = useState<string | null>(null);

  const {
    data: result,
    error: requestError,
    loading,
    run,
  } = useFlowRequest<SimulateResponse>((signal) =>
    rillApi.simulate({ nodes: graph.nodes, edges: graph.edges }, signal),
  );

  // Re-checks the gate and (re-)simulates every time the dialog opens, and
  // again whenever the flow changes while open — mirrors the old
  // fresh-mount-per-open behavior, now via an explicit `open` guard since the
  // dialog is mounted persistently (Radix controls its visibility).
  useEffect(() => {
    if (!open) return;

    const blockedReason = guardrailGateReason(nodes);
    if (blockedReason) {
      setGateError(blockedReason);
      return;
    }

    if (graph.nodes.length === 0) {
      setGateError(
        graph.skipped.length > 0
          ? CAPABILITY_COPY.simulateSkipped(graph.skipped)
          : CAPABILITY_COPY.simulateEmpty,
      );
      return;
    }

    setGateError(null);
    run();
  }, [open, nodes, graph, run]);

  const phase: "idle" | "simulating" | "ok" | "fail" | "unverified" = gateError
    ? "fail"
    : loading
      ? "simulating"
      : result
        ? getSimulationPhase(result.simulation)
        : requestError
          ? "fail"
          : "idle";

  const error =
    gateError ??
    requestError ??
    (result && !result.simulation.ok ? (result.simulation.error ?? "Simulation failed") : null);

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
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      eyebrow={
        <>
          <Activity className="h-3 w-3" /> Live simulation · {rillApi.baseUrl}
        </>
      }
      title="Dry-run & guardrails"
      contentClassName="max-w-3xl"
    >
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
                  Simulation unverified:{" "}
                  {result?.simulation.error ?? "No reason returned by backend"}. Signing is blocked.
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
          <div className="text-xs uppercase tracking-widest text-muted-foreground">
            Enforced at execution
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            What actually runs — read-only, not a toggle.
          </p>

          <div className="mt-3 space-y-2">
            <EnforceRow icon={KeyRound} tone="sky" title="Keyless & unsigned">
              Rill returns an <strong>unsigned PTB</strong>. Only your local signer signs and submits
              — the backend never holds keys.
            </EnforceRow>
            <EnforceRow icon={ShieldCheck} tone="mint" title="Wallet capabilities">
              Spend caps and the swap slippage floor are wallet-level, enforced by the Rill compiler
              and the on-chain agent_wallet. Tune them in <strong>Capabilities</strong>.
            </EnforceRow>
            <EnforceRow icon={AlertTriangle} tone="amber" title="No wallet bound in this dry-run">
              This preview isn't tied to an on-chain agent_wallet yet, so budget/rate caps aren't
              proven here — they're enforced by the signer and wallet at execution time.
            </EnforceRow>
          </div>

          {guardrailNodes.length > 0 && (
            <div className="mt-3 space-y-1.5">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Legacy guardrails
              </div>
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
                      min {gData.minValue?.trim() ? gData.minValue : "(unset)"} ·{" "}
                      {coinSymbol(gData.coinType)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </DialogShell>
  );
}

const ENFORCE_TONE: Record<"sky" | "mint" | "amber", string> = {
  sky: "bg-sky/30 text-sky-foreground",
  mint: "bg-mint/50 text-mint-foreground",
  amber: "bg-amber-400/20 text-amber-700 dark:text-amber-300",
};

/** One scannable "what's enforced" row: a tinted icon chip + a titled explanation. Replaces the
 *  old stack of full-width colored callout boxes that read as cluttered. */
function EnforceRow({
  icon: Icon,
  tone,
  title,
  children,
}: {
  icon: LucideIcon;
  tone: "sky" | "mint" | "amber";
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-2.5 rounded-xl border border-border/60 bg-background/40 p-3">
      <span
        className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${ENFORCE_TONE[tone]}`}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 text-[11px] leading-relaxed">
        <div className="font-medium text-foreground">{title}</div>
        <p className="text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}
