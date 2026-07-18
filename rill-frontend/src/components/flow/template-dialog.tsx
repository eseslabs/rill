import { motion } from "framer-motion";
import { ArrowRight, LayoutTemplate } from "lucide-react";
import { DialogShell } from "@/components/flow/dialog-shell";
import { FLOW_TEMPLATES } from "@/lib/flow-templates";

const easeOut = [0.22, 1, 0.36, 1] as const;

/**
 * "Start from a template" gallery — flow-only presets (lib/flow-templates.ts).
 * Picking a card hands the template id back to the builder via `onApply`,
 * which replaces the canvas (with a confirm if it isn't empty) and closes
 * this dialog. No network calls, no local state to reset on open — every
 * template is a pure, static preset.
 */
export function TemplateDialog({
  open,
  onOpenChange,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: (templateId: string) => void;
}) {
  const pick = (templateId: string) => {
    onApply(templateId);
    onOpenChange(false);
  };

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      eyebrow={
        <>
          <LayoutTemplate className="h-3 w-3" /> Flow presets
        </>
      }
      title="Start from a template"
      description="Drop a ready-wired preset onto the canvas, then tune it — nothing publishes until you compile & export."
      contentClassName="max-w-3xl"
    >
      <div className="p-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {FLOW_TEMPLATES.map((t, i) => (
            <motion.button
              key={t.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.04, duration: 0.25, ease: easeOut }}
              whileHover={{ y: -2 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => pick(t.id)}
              className="group flex flex-col items-start gap-2 rounded-xl border border-border bg-card px-4 py-3.5 text-left cursor-pointer transition hover:border-primary/50 hover:bg-secondary/40"
            >
              <div className="flex w-full items-center justify-between gap-2">
                <span className="text-sm font-semibold text-foreground">{t.name}</span>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 -translate-x-1 text-muted-foreground opacity-0 transition group-hover:translate-x-0 group-hover:opacity-100" />
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">{t.description}</p>
              {t.tags && t.tags.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {t.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded bg-mint/40 px-1.5 py-0.5 text-[10px] font-mono text-mint-foreground"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </motion.button>
          ))}
        </div>
      </div>
    </DialogShell>
  );
}
