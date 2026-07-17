import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Package, ScanSearch, Loader2, ChevronRight, AlertCircle } from "lucide-react";
import { rillApi } from "@/lib/rill-api";
import { useFlowRequest } from "@/lib/use-flow-request";
import { DialogShell } from "@/components/flow/dialog-shell";
import {
  backendFunctionsToDiscovered,
  type DiscoveredFunction,
  type IntrospectionResult,
} from "@/lib/rill-types";

/**
 * Discover a Sui protocol by reading its real on-chain ABI via the backend (`POST /introspect`).
 * No mock data — paste a package id and Rill returns the actual entry functions + typed params.
 */
export function DiscoverDialog({
  open,
  onOpenChange,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (fns: DiscoveredFunction[], meta: IntrospectionResult) => void;
}) {
  const [pkg, setPkg] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const {
    data: result,
    error,
    loading,
    run: runIntrospect,
    reset,
  } = useFlowRequest<IntrospectionResult>((signal) => {
    const packageId = pkg.trim();
    return rillApi.introspect(packageId, signal).then((fns) => backendFunctionsToDiscovered(packageId, fns));
  });

  // This dialog is now mounted persistently (Radix controls its visibility),
  // not remounted per open, so the form is reset explicitly every time it
  // opens — mirrors the old fresh-mount-per-open behavior.
  useEffect(() => {
    if (!open) return;
    setPkg("");
    setPicked(new Set());
    reset();
  }, [open, reset]);

  // A fresh result starts with every discovered function pre-selected —
  // mirrors the original's `setPicked(new Set(r.functions.map(f => f.id)))`.
  useEffect(() => {
    if (!result) return;
    setPicked(new Set(result.functions.map((f) => f.id)));
  }, [result]);

  const handleIntrospect = () => {
    if (!pkg.trim()) return;
    runIntrospect();
  };

  const toggle = (id: string) => {
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const importPicked = () => {
    if (!result) return;
    onImport(
      result.functions.filter((f) => picked.has(f.id)),
      result,
    );
    onOpenChange(false);
  };

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      eyebrow={
        <>
          <ScanSearch className="h-3 w-3" /> On-chain introspection
        </>
      }
      title="Discover a Sui protocol"
      description="Paste a package ID — Rill reads the real ABI on-chain and labels every entry function and parameter."
      contentClassName="max-w-3xl"
    >
      <div className="p-5">
        <label className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Package className="h-3.5 w-3.5" /> Sui package ID
        </label>
        <div className="mt-1 flex gap-2">
          <input
            value={pkg}
            onChange={(e) => setPkg(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleIntrospect()}
            placeholder="0x… (the protocol's published package id)"
            className="flex-1 rounded-lg bg-background border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          <button
            onClick={handleIntrospect}
            disabled={loading || !pkg.trim()}
            className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-foreground text-background px-4 py-2 text-sm font-medium hover:opacity-90 transition disabled:cursor-not-allowed disabled:opacity-60 whitespace-nowrap"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />}
            {loading ? "Reading ABI…" : "Introspect"}
          </button>
        </div>

        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {result && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-5 rounded-xl border border-border bg-background/60 overflow-hidden"
          >
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <div>
                <div className="font-display text-xl tracking-tight">{result.protocol}</div>
                <div className="text-[11px] font-mono text-muted-foreground truncate max-w-[420px]">
                  {result.packageId}
                </div>
              </div>
              <span className="text-[11px] rounded-full bg-mint/60 text-mint-foreground px-2 py-1">
                {result.functions.length} functions
              </span>
            </div>
            {result.functions.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted-foreground text-center">
                No public functions found for this package.
              </div>
            ) : (
              <div className="max-h-[260px] overflow-y-auto divide-y divide-border">
                {result.functions.map((f) => (
                  <label
                    key={f.id}
                    className="flex items-start gap-3 px-4 py-3 hover:bg-secondary/60 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={picked.has(f.id)}
                      onChange={() => toggle(f.id)}
                      className="mt-1 accent-primary"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-mono text-foreground/80">
                          {f.module}::{f.name}
                        </span>
                        <ChevronRight className="h-3 w-3 text-muted-foreground" />
                        <span className="text-muted-foreground">{f.description}</span>
                      </div>
                      {f.inputs.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {f.inputs.map((p) => (
                            <span
                              key={"i" + p.key}
                              className="text-[10px] font-mono rounded bg-mint/40 text-mint-foreground px-1.5 py-0.5"
                            >
                              {p.label}: {p.type}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            )}
            <div className="px-4 py-3 border-t border-border flex justify-end gap-2">
              <button
                onClick={() => onOpenChange(false)}
                className="cursor-pointer rounded-full border border-border bg-background px-3.5 py-1.5 text-sm hover:bg-secondary transition"
              >
                Cancel
              </button>
              <button
                onClick={importPicked}
                disabled={picked.size === 0}
                className="cursor-pointer rounded-full bg-foreground text-background px-3.5 py-1.5 text-sm hover:opacity-90 transition disabled:cursor-not-allowed disabled:opacity-50"
              >
                Import {picked.size} {picked.size === 1 ? "node" : "nodes"} to canvas
              </button>
            </div>
          </motion.div>
        )}
      </div>
    </DialogShell>
  );
}
