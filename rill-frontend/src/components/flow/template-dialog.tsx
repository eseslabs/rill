import { motion } from "framer-motion";
import { ArrowRight, Eye, LayoutTemplate, Lock } from "lucide-react";
import { DialogShell } from "@/components/flow/dialog-shell";
import { ProtocolLogo } from "@/components/flow/protocol-logo";
import { manifestCaps } from "@/lib/capabilities";
import { FLOW_TEMPLATES, type FlowTemplate } from "@/lib/flow-templates";
import { PROTOCOLS } from "@/lib/protocols";

const easeOut = [0.22, 1, 0.36, 1] as const;

/** Ordered row of protocol icons/labels a template's action nodes touch (`template.steps`) —
 *  reuses the same `ProtocolLogo` the library sidebar renders (routes/builder.tsx's
 *  `ProtocolGroup`) so a template card and the sidebar entry for the same protocol always look
 *  like the same thing. */
function StepPreview({ steps }: { steps: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {steps.map((protocolId, i) => {
        const protocol = PROTOCOLS.find((p) => p.id === protocolId);
        return (
          <span key={`${protocolId}-${i}`} className="flex items-center gap-1">
            {i > 0 && <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />}
            <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background px-1.5 py-0.5 text-[10px] font-medium text-foreground/80">
              <ProtocolLogo
                protocolId={protocolId}
                name={protocol?.name ?? protocolId}
                className="h-3.5 w-3.5"
              />
              {protocol?.name ?? protocolId}
            </span>
          </span>
        );
      })}
    </div>
  );
}

/** One capability chip per rule in the template's suggested manifest, showing the label AND its
 *  configured value (e.g. "Budget · 5 SUI") via the SDK's own `toDeclaration` projection, tinted by
 *  the same on-chain/pre-flight split the composer uses — a template card advertises exactly what
 *  onboarding with it would declare, values and all. Long list values (allowed coins/recipients) are
 *  truncated in the chip but shown in full on hover. */
function CapChips({ manifest }: { manifest: FlowTemplate["manifest"] }) {
  if (!manifest || manifest.rules.length === 0) return null;
  const caps = manifestCaps(manifest);
  return (
    <div className="flex flex-wrap gap-1">
      {caps.map((cap, i) => {
        const isOnChain = cap.enforcement === "on-chain";
        const value = cap.value.length > 22 ? `${cap.value.slice(0, 21)}…` : cap.value;
        return (
          <span
            key={`${cap.label}-${i}`}
            title={`${cap.label}: ${cap.value}`}
            className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] ${
              isOnChain
                ? "bg-mint/50 text-mint-foreground"
                : "bg-amber-400/15 text-amber-800 dark:text-amber-300"
            }`}
          >
            {isOnChain ? <Lock className="h-2.5 w-2.5" /> : <Eye className="h-2.5 w-2.5" />}
            <span className="font-medium">{cap.label}</span>
            <span className="opacity-70">{value}</span>
          </span>
        );
      })}
    </div>
  );
}

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
      description="Drop a ready-wired preset onto the canvas, with a suggested capability set — tune both, then compile & export."
      contentClassName="max-w-3xl"
    >
      <div className="p-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {FLOW_TEMPLATES.map((t, i) => {
            const Icon = t.icon;
            return (
              <motion.button
                key={t.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04, duration: 0.25, ease: easeOut }}
                whileHover={{ y: -2 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => pick(t.id)}
                className="group flex flex-col items-start gap-2.5 rounded-xl border border-border bg-card px-4 py-3.5 text-left cursor-pointer transition hover:border-primary/50 hover:bg-secondary/40 hover:shadow-[var(--shadow-soft)]"
              >
                <div className="flex w-full items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="truncate text-sm font-semibold text-foreground">{t.name}</span>
                  </div>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 -translate-x-1 text-muted-foreground opacity-0 transition group-hover:translate-x-0 group-hover:opacity-100" />
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">{t.description}</p>
                <StepPreview steps={t.steps} />
                <CapChips manifest={t.manifest} />
              </motion.button>
            );
          })}
        </div>
      </div>
    </DialogShell>
  );
}
