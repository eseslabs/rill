import { useState } from "react";
import { motion } from "framer-motion";
import { X, Package, Sparkles, Loader2, ChevronRight, AlertCircle } from "lucide-react";
import { rillApi } from "@/lib/rill-api";
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
  onClose,
  onImport,
}: {
  onClose: () => void;
  onImport: (fns: DiscoveredFunction[], meta: IntrospectionResult) => void;
}) {
  const [pkg, setPkg] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IntrospectionResult | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const run = async () => {
    const packageId = pkg.trim();
    if (!packageId) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setPicked(new Set());
    try {
      const fns = await rillApi.introspect(packageId);
      const r = backendFunctionsToDiscovered(packageId, fns);
      setResult(r);
      setPicked(new Set(r.functions.map((f) => f.id)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Introspection failed");
    } finally {
      setLoading(false);
    }
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
    onClose();
  };

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
              <Sparkles className="h-3 w-3" /> On-chain introspection
            </div>
            <h3 className="font-display text-2xl tracking-tight">Discover a Sui protocol</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Paste a package ID — Rill reads the real ABI on-chain and labels every entry function and parameter.
            </p>
          </div>
          <button onClick={onClose} className="rounded-full p-1.5 hover:bg-secondary">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5">
          <label className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Package className="h-3.5 w-3.5" /> Sui package ID
          </label>
          <div className="mt-1 flex gap-2">
            <input
              value={pkg}
              onChange={(e) => setPkg(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && run()}
              placeholder="0x… (the protocol's published package id)"
              className="flex-1 rounded-lg bg-background border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <button
              onClick={run}
              disabled={loading || !pkg.trim()}
              className="inline-flex items-center gap-2 rounded-full bg-foreground text-background px-4 py-2 text-sm font-medium hover:opacity-90 transition disabled:opacity-60 whitespace-nowrap"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
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
                  onClick={onClose}
                  className="rounded-full border border-border bg-background px-3.5 py-1.5 text-sm hover:bg-secondary transition"
                >
                  Cancel
                </button>
                <button
                  onClick={importPicked}
                  disabled={picked.size === 0}
                  className="rounded-full bg-foreground text-background px-3.5 py-1.5 text-sm hover:opacity-90 transition disabled:opacity-50"
                >
                  Import {picked.size} {picked.size === 1 ? "node" : "nodes"} to canvas
                </button>
              </div>
            </motion.div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
