import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, X } from "lucide-react";
import type { SkippedEdge } from "@/lib/flow-mapper";

/**
 * Dismissible amber banner listing every skipped node and skipped edge by
 * name/reason. Rendered identically in the simulate and export/publish
 * dialogs so "what got dropped and why" is never a partial answer.
 */
export function FlowWarningsBanner({
  skippedNodes,
  skippedEdges,
}: {
  skippedNodes: string[];
  skippedEdges: SkippedEdge[];
}) {
  const [dismissed, setDismissed] = useState(false);
  const hasWarnings = skippedNodes.length > 0 || skippedEdges.length > 0;

  return (
    <AnimatePresence>
      {hasWarnings && !dismissed && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.2 }}
          className="overflow-hidden rounded-lg border border-amber-400/40 bg-amber-400/10 dark:bg-amber-400/[0.08]"
        >
          <div className="flex items-start gap-2 px-3 py-2.5">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0 flex-1 space-y-1.5 text-[11px] leading-relaxed text-amber-800 dark:text-amber-300">
              {skippedNodes.length > 0 && (
                <p>
                  <strong>Skipped {skippedNodes.length === 1 ? "node" : "nodes"}:</strong>{" "}
                  {skippedNodes.join(", ")}
                </p>
              )}
              {skippedEdges.length > 0 && (
                <ul className="space-y-1">
                  {skippedEdges.map((e, i) => (
                    <li key={`${e.source}->${e.target}-${i}`}>
                      <strong>
                        {e.source} → {e.target}:
                      </strong>{" "}
                      {e.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              aria-label="Dismiss warning"
              className="shrink-0 cursor-pointer rounded-full p-1 text-amber-700/70 hover:bg-amber-400/20 hover:text-amber-800 dark:text-amber-400/70 dark:hover:text-amber-300"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
