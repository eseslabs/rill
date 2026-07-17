import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  X,
  Loader2,
  Check,
  AlertTriangle,
  Activity,
  Link2,
  RefreshCw,
  ShieldOff,
} from "lucide-react";
import type { Edge, Node } from "reactflow";
import { useSuiClient } from "@mysten/dapp-kit";
import type { ActionNodeData, GuardrailNodeData, WalletNodeData } from "./nodes";
import { buildFlowGraph } from "@/lib/flow-mapper";
import { rillApi, type SimulationResult } from "@/lib/rill-api";
import {
  extractWalletFields,
  toEnforcedBounds,
  toSlippageFloorRow,
  type BoundRow,
  type RawAgentWallet,
} from "@/lib/agent-wallet-read";

function getEmptyFlowError(skipped: string[]): string {
  if (skipped.length > 0) {
    return `Backend supports Cetus swap + Haedal stake only. Skipped: ${skipped.join(", ")}`;
  }

  return "Add a Cetus swap or Haedal stake node to simulate.";
}

function getSimulationPhase(simulation: SimulationResult): "ok" | "fail" | "unverified" {
  if (simulation.verification === "unverified") {
    return "unverified";
  }

  if (simulation.ok) {
    return "ok";
  }

  return "fail";
}

/** The wallet the flow is actually bound to — the same field flow-mapper compiles into the PTB. */
function boundWalletIdFromFlow(nodes: Node[]): string | null {
  for (const node of nodes) {
    if (node.type !== "wallet") continue;
    const walletId = (node.data as WalletNodeData)?.walletId?.trim();
    if (walletId) return walletId;
  }
  return null;
}

/** The floor the compiler will inject as rill_guard::assert_min_value, read off the guardrail node. */
function slippageMinValueFromFlow(nodes: Node[]): string | null {
  for (const node of nodes) {
    if (node.type !== "guardrail") continue;
    const minValue = (node.data as GuardrailNodeData)?.minValue?.trim();
    if (minValue) return minValue;
  }
  return null;
}

const ENFORCEMENT_BADGE: Record<BoundRow["enforcement"], { text: string; className: string }> = {
  "on-chain": {
    text: "Enforced on-chain",
    className: "border-mint/40 bg-mint/15 text-mint-foreground",
  },
  "off-chain": {
    text: "Not enforced on-chain",
    className: "border-amber-400/40 bg-amber-400/10 text-amber-700 dark:text-amber-400",
  },
  none: {
    text: "Enforces nothing",
    className: "border-peach/50 bg-peach/20 text-peach-foreground",
  },
};

function BoundRowView({ row }: { row: BoundRow }) {
  const badge = ENFORCEMENT_BADGE[row.enforcement];
  return (
    <div className="rounded-lg border border-border bg-background/60 px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm">{row.label}</span>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${badge.className}`}
        >
          {badge.text}
        </span>
      </div>
      <div className="mt-0.5 break-all font-mono text-[11px] text-foreground/80">{row.value}</div>
      <div className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{row.enforcedBy}</div>
    </div>
  );
}

/**
 * Reads the bound AgentWallet object live and renders only what the chain actually enforces.
 *
 * This panel used to be five hardcoded booleans under the claim "Enforced at sign time". They
 * touched no config and enforced nothing. Truth is not in the frontend, and not in the signer's
 * run-set (a local JSON file the browser cannot read) — it is in the AgentWallet shared object,
 * so that is what this reads, on every open.
 */
function EnforcedBoundsPanel({ nodes }: { nodes: Node[] }) {
  const suiClient = useSuiClient();
  const flowWalletId = boundWalletIdFromFlow(nodes);
  const [pastedWalletId, setPastedWalletId] = useState("");
  const [nonce, setNonce] = useState(0);
  const [raw, setRaw] = useState<RawAgentWallet | null>(null);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  const walletId = flowWalletId ?? (pastedWalletId.trim() || null);
  const slippageMinValue = useMemo(() => slippageMinValueFromFlow(nodes), [nodes]);

  useEffect(() => {
    if (!walletId) {
      setRaw(null);
      setReadError(null);
      return;
    }

    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setReadError(null);
      try {
        const response = await suiClient.getObject({
          id: walletId,
          options: { showContent: true },
        });
        if (cancelled) return;
        const fields = extractWalletFields(response);
        if (!fields) {
          // Never fall back to a fabricated wallet — an unreadable object enforces nothing knowable.
          setRaw(null);
          setReadError(`No AgentWallet object found at ${walletId} on this network.`);
          return;
        }
        setRaw(fields);
      } catch (err) {
        if (cancelled) return;
        setRaw(null);
        setReadError(err instanceof Error ? err.message : "Failed to read the wallet from chain");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [suiClient, walletId, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // toEnforcedBounds(null) is the honest empty state, not an error path.
  const bounds = useMemo(() => toEnforcedBounds(raw), [raw]);
  const rows = bounds.bound ? [...bounds.rows, toSlippageFloorRow(slippageMinValue)] : [];

  return (
    <div className="p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs uppercase tracking-widest text-muted-foreground">
          Enforced bounds
        </div>
        {walletId && (
          <button
            onClick={refresh}
            className="cursor-pointer inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-secondary"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Re-read
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Read live from the on-chain <span className="font-mono">AgentWallet</span> object. Each row
        says what actually enforces it.
      </p>

      {walletId ? (
        <div className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Link2 className="h-3 w-3 shrink-0" />
          <span className="truncate font-mono">{walletId}</span>
        </div>
      ) : null}

      {!walletId && (
        <div className="mt-3 rounded-xl border border-amber-400/40 bg-amber-400/10 p-3">
          <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
            <ShieldOff className="h-3.5 w-3.5 shrink-0" />
            {bounds.status}
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            Wire a Wallet node with an AgentWallet ID, or paste one to read its bounds.
          </p>
          <input
            value={pastedWalletId}
            onChange={(e) => setPastedWalletId(e.target.value)}
            placeholder="0x… AgentWallet object ID"
            className="mt-2 w-full rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-[11px] outline-none focus:border-primary"
          />
        </div>
      )}

      {readError && (
        <div className="mt-3 flex items-start gap-1.5 rounded-lg border border-peach/50 bg-peach/20 px-3 py-2 text-[11px] text-peach-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{readError}</span>
        </div>
      )}

      {walletId && loading && !raw && (
        <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Reading AgentWallet from chain…
        </div>
      )}

      {bounds.bound && (
        <>
          <div
            className={`mt-3 rounded-lg border px-3 py-2 text-xs font-medium ${
              bounds.status === "ACTIVE"
                ? "border-mint/40 bg-mint/15 text-mint-foreground"
                : "border-peach/50 bg-peach/20 text-peach-foreground"
            }`}
          >
            {bounds.status === "ACTIVE"
              ? "Wallet active — the bounds below are live"
              : `Wallet ${bounds.status.toLowerCase()} — every spend aborts`}
          </div>
          <div className="mt-2 max-h-[300px] space-y-1.5 overflow-auto">
            {rows.map((row) => (
              <BoundRowView key={row.label} row={row} />
            ))}
          </div>
        </>
      )}

      <div className="mt-4 rounded-xl bg-sky/30 p-3 text-[11px] text-sky-foreground">
        Rill returns an <strong>unsigned PTB</strong> — keyless backend.{" "}
        <span className="font-mono">@rill/signer</span> validates and signs locally;{" "}
        <span className="font-mono">agent_wallet</span> enforces the caps above on-chain.
      </div>
    </div>
  );
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

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setPhase("simulating");
      setError(null);
      setResult(null);

      const { nodes: flowNodes, edges: flowEdges, skipped } = buildFlowGraph(nodes, edges);

      if (flowNodes.length === 0) {
        setPhase("fail");
        setError(getEmptyFlowError(skipped));
        return;
      }

      try {
        const data = await rillApi.simulate({ nodes: flowNodes, edges: flowEdges });
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
  }, [nodes, edges]);

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
            <h3 className="font-display text-2xl tracking-tight">Dry-run & enforced bounds</h3>
          </div>
          <button
            onClick={onClose}
            className="cursor-pointer rounded-full p-1.5 hover:bg-secondary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid md:grid-cols-2 gap-0">
          <div className="p-5 border-r border-border">
            <div className="text-xs uppercase tracking-widest text-muted-foreground">
              PTB preview
            </div>
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
                    {result?.simulation.error ?? "No reason returned by backend"}. Signing is
                    blocked.
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

          <EnforcedBoundsPanel nodes={nodes} />
        </div>
      </motion.div>
    </motion.div>
  );
}
