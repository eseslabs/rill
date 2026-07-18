import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Eye, Loader2, Lock, Plus, ShieldCheck, X } from "lucide-react";
import { DialogShell } from "@/components/flow/dialog-shell";
import { useFlowRequest } from "@/lib/use-flow-request";
import { rillApi, type CapabilityPreviewResult } from "@/lib/rill-api";
import {
  RULE_KINDS,
  RULE_KIND_META,
  assetScopeRule,
  baseUnitsToDecimal,
  budgetRule,
  listToText,
  msToDatetimeLocal,
  perTxRule,
  protocolScopeRule,
  rateLimitRule,
  recipientAllowlistRule,
  slippageFloorRule,
  timeWindowRule,
  validateManifest,
  type CapabilityManifest,
  type CapabilityRule,
  type RuleKind,
} from "@/lib/capabilities";

/**
 * Wallet-level capability composer (U7): compose a `CapabilityManifest` rule-by-rule and see an
 * honest live preview of what the SDK's `toDeclaration` projection would actually tell the agent —
 * each cap labeled `on-chain` (proved against the real PTB, cannot be bypassed) or `pre-flight`
 * (enforced by the trusted compiler + signer instead). This dialog only composes + previews the
 * manifest; wiring it into the compile/publish payload is a later phase (builder.tsx does not send
 * `manifest` anywhere yet).
 */

const RATE_LIMIT_WINDOW_PRESETS: { label: string; ms: string }[] = [
  { label: "1 minute", ms: "60000" },
  { label: "1 hour", ms: "3600000" },
  { label: "1 day", ms: "86400000" },
  { label: "1 week", ms: "604800000" },
];

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Seeds a freshly-added kind's form fields. Amount/list fields start empty (an honest "not yet
 *  set" rather than a fabricated placeholder); `rate_limit`'s window and `time_window`'s bounds get
 *  a usable default since those have no meaningful "empty" state to type into first. */
function defaultDraftForKind(kind: RuleKind): Record<string, string> {
  switch (kind) {
    case "budget":
    case "per_tx":
    case "slippage_floor":
      return { amount: "" };
    case "rate_limit":
      return { amount: "", windowMs: "3600000" };
    case "protocol_scope":
    case "asset_scope":
    case "recipient_allowlist":
      return { list: "" };
    case "time_window": {
      const now = Date.now();
      return {
        notBefore: msToDatetimeLocal(String(now)),
        notAfter: msToDatetimeLocal(String(now + ONE_DAY_MS)),
      };
    }
  }
}

/** Reverse-maps an already-composed rule back to editable form text — used to pre-fill a card when
 *  the dialog is reopened with an existing manifest. */
function seedDraftFromRule(rule: CapabilityRule): Record<string, string> {
  switch (rule.kind) {
    case "budget":
      return { amount: baseUnitsToDecimal(rule.totalMist) };
    case "per_tx":
      return { amount: baseUnitsToDecimal(rule.maxMist) };
    case "rate_limit":
      return { amount: baseUnitsToDecimal(rule.maxMist), windowMs: rule.windowMs };
    case "slippage_floor":
      return { amount: baseUnitsToDecimal(rule.minOutMist) };
    case "protocol_scope":
      return { list: listToText(rule.allowedPackages) };
    case "asset_scope":
      return { list: listToText(rule.allowedCoinTypes) };
    case "recipient_allowlist":
      return { list: listToText(rule.addresses) };
    case "time_window":
      return {
        notBefore: msToDatetimeLocal(rule.notBeforeMs),
        notAfter: msToDatetimeLocal(rule.notAfterMs),
      };
  }
}

/** Builds a `CapabilityRule` from a draft's raw text fields. Falls back to embedding the
 *  still-being-typed raw text directly when a field doesn't parse yet (e.g. an empty or partial
 *  amount) rather than dropping the rule from the manifest entirely — an incomplete card should
 *  read as an honest local-validation error (KTD-6), never silently vanish. */
function buildRuleFromDraft(kind: RuleKind, draft: Record<string, string>): CapabilityRule {
  const amount = draft.amount ?? "";
  switch (kind) {
    case "budget": {
      try {
        return budgetRule(amount);
      } catch {
        return { kind, totalMist: amount };
      }
    }
    case "per_tx": {
      try {
        return perTxRule(amount);
      } catch {
        return { kind, maxMist: amount };
      }
    }
    case "slippage_floor": {
      try {
        return slippageFloorRule(amount);
      } catch {
        return { kind, minOutMist: amount };
      }
    }
    case "rate_limit": {
      const windowMs = draft.windowMs ?? "";
      try {
        return rateLimitRule(amount, windowMs);
      } catch {
        return { kind, windowMs, maxMist: amount };
      }
    }
    case "protocol_scope":
      return protocolScopeRule(draft.list ?? "");
    case "asset_scope":
      return assetScopeRule(draft.list ?? "");
    case "recipient_allowlist":
      return recipientAllowlistRule(draft.list ?? "");
    case "time_window": {
      const notBefore = draft.notBefore ?? "";
      const notAfter = draft.notAfter ?? "";
      try {
        return timeWindowRule(notBefore, notAfter);
      } catch {
        return { kind, notBeforeMs: notBefore, notAfterMs: notAfter };
      }
    }
  }
}

function EnforcementBadge({ enforcement }: { enforcement: "on-chain" | "pre-flight" }) {
  const isOnChain = enforcement === "on-chain";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
        isOnChain
          ? "bg-mint/60 text-mint-foreground"
          : "bg-amber-400/20 text-amber-800 dark:text-amber-300"
      }`}
      title={
        isOnChain
          ? "Proved against the real transaction on-chain — cannot be bypassed."
          : "Enforced by the Rill compiler + signer before the transaction is ever built — not a hard on-chain guarantee."
      }
    >
      {isOnChain ? <Lock className="h-2.5 w-2.5" /> : <Eye className="h-2.5 w-2.5" />}
      {enforcement}
    </span>
  );
}

function RuleFields({
  kind,
  draft,
  onFieldChange,
}: {
  kind: RuleKind;
  draft: Record<string, string>;
  onFieldChange: (field: string, value: string) => void;
}) {
  const inputClass =
    "mt-1 w-full rounded-lg bg-background border border-border px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary/40";

  if (kind === "budget" || kind === "per_tx" || kind === "slippage_floor") {
    const label =
      kind === "budget"
        ? "Total budget (SUI)"
        : kind === "per_tx"
          ? "Max per transaction (SUI)"
          : "Minimum swap output (SUI)";
    return (
      <label className="block text-[11px] text-muted-foreground">
        {label}
        <input
          value={draft.amount ?? ""}
          onChange={(e) => onFieldChange("amount", e.target.value)}
          placeholder="e.g. 10"
          inputMode="decimal"
          className={inputClass}
        />
      </label>
    );
  }

  if (kind === "rate_limit") {
    return (
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-[11px] text-muted-foreground">
          Max amount (SUI)
          <input
            value={draft.amount ?? ""}
            onChange={(e) => onFieldChange("amount", e.target.value)}
            placeholder="e.g. 5"
            inputMode="decimal"
            className={inputClass}
          />
        </label>
        <label className="block text-[11px] text-muted-foreground">
          Per window
          <select
            value={draft.windowMs ?? ""}
            onChange={(e) => onFieldChange("windowMs", e.target.value)}
            className={inputClass}
          >
            {RATE_LIMIT_WINDOW_PRESETS.map((preset) => (
              <option key={preset.ms} value={preset.ms}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    );
  }

  if (kind === "protocol_scope" || kind === "asset_scope" || kind === "recipient_allowlist") {
    const label =
      kind === "protocol_scope"
        ? "Allowed package ids"
        : kind === "asset_scope"
          ? "Allowed coin types"
          : "Allowed recipient addresses";
    return (
      <label className="block text-[11px] text-muted-foreground">
        {label} (comma or newline separated)
        <textarea
          value={draft.list ?? ""}
          onChange={(e) => onFieldChange("list", e.target.value)}
          rows={3}
          placeholder="0x…"
          className={inputClass}
        />
      </label>
    );
  }

  // time_window
  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="block text-[11px] text-muted-foreground">
        Not before
        <input
          type="datetime-local"
          value={draft.notBefore ?? ""}
          onChange={(e) => onFieldChange("notBefore", e.target.value)}
          className={inputClass}
        />
      </label>
      <label className="block text-[11px] text-muted-foreground">
        Not after
        <input
          type="datetime-local"
          value={draft.notAfter ?? ""}
          onChange={(e) => onFieldChange("notAfter", e.target.value)}
          className={inputClass}
        />
      </label>
    </div>
  );
}

function RuleCard({
  kind,
  draft,
  onFieldChange,
  onRemove,
}: {
  kind: RuleKind;
  draft: Record<string, string>;
  onFieldChange: (field: string, value: string) => void;
  onRemove: () => void;
}) {
  const meta = RULE_KIND_META[kind];
  return (
    <div className="rounded-xl border border-border bg-background/60 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold">{meta.label}</span>
            <EnforcementBadge enforcement={meta.enforcement} />
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{meta.blurb}</p>
        </div>
        <button
          onClick={onRemove}
          aria-label={`Remove ${meta.label}`}
          className="shrink-0 cursor-pointer rounded-full p-1 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-2.5">
        <RuleFields kind={kind} draft={draft} onFieldChange={onFieldChange} />
      </div>
    </div>
  );
}

export function CapabilitiesDialog({
  open,
  onOpenChange,
  manifest,
  onChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  manifest: CapabilityManifest;
  onChange: (next: CapabilityManifest) => void;
}) {
  // Seeded once from the incoming manifest — this dialog is conditionally mounted (unmounts on
  // close), so a fresh mount always starts from whatever the caller's current manifest is; there is
  // no need to re-sync from props after that (every subsequent change flows the other direction,
  // draft state -> onChange -> caller).
  const [activeKinds, setActiveKinds] = useState<RuleKind[]>(() =>
    manifest.rules.map((r) => r.kind),
  );
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>(() => {
    const seeded: Record<string, Record<string, string>> = {};
    for (const rule of manifest.rules) seeded[rule.kind] = seedDraftFromRule(rule);
    return seeded;
  });

  const availableKinds = RULE_KINDS.filter((kind) => !activeKinds.includes(kind));

  const addKind = (kind: RuleKind) => {
    setActiveKinds((prev) => [...prev, kind]);
    setDrafts((prev) => ({ ...prev, [kind]: defaultDraftForKind(kind) }));
  };

  const removeKind = (kind: RuleKind) => {
    setActiveKinds((prev) => prev.filter((k) => k !== kind));
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[kind];
      return next;
    });
  };

  const updateField = (kind: RuleKind, field: string, value: string) => {
    setDrafts((prev) => ({ ...prev, [kind]: { ...prev[kind], [field]: value } }));
  };

  const composedManifest = useMemo<CapabilityManifest>(
    () => ({
      walletCoinType: manifest.walletCoinType,
      rules: activeKinds.map((kind) => buildRuleFromDraft(kind, drafts[kind] ?? {})),
    }),
    [activeKinds, drafts, manifest.walletCoinType],
  );

  useEffect(() => {
    onChange(composedManifest);
    // Only re-fires when the composed manifest actually changes (activeKinds/drafts) — `onChange`
    // itself is a stable setState setter from the caller, intentionally excluded so a caller that
    // re-creates the callback identity every render can't cause an extra push.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composedManifest]);

  const validation = useMemo(() => validateManifest(composedManifest), [composedManifest]);

  const {
    data: preview,
    error: previewError,
    loading: previewLoading,
    run: runPreview,
    reset: resetPreview,
  } = useFlowRequest<CapabilityPreviewResult>((signal) =>
    rillApi.previewCapabilities(composedManifest, signal),
  );

  // Debounced live preview (~300ms): only fires once the manifest has ≥1 rule and validates
  // locally against the same schema the backend uses — an incomplete card (still-being-typed
  // amount, empty address list) is surfaced as a local validation message instead of spamming the
  // backend with a request that's guaranteed to 422.
  useEffect(() => {
    if (composedManifest.rules.length === 0 || !validation.ok) {
      resetPreview();
      return;
    }
    const timer = setTimeout(() => {
      runPreview();
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composedManifest, validation.ok]);

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      eyebrow={
        <>
          <ShieldCheck className="h-3 w-3" /> Wallet-level capability manifest
        </>
      }
      title="Capabilities"
      description="Compose the agent's on-chain + pre-flight limits."
      contentClassName="max-w-3xl"
    >
      <div className="grid md:grid-cols-2 gap-0">
        <div className="p-5 border-r border-border max-h-[65vh] overflow-y-auto">
          <div className="text-xs uppercase tracking-widest text-muted-foreground">
            Restrictions
          </div>
          {activeKinds.length === 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              No restrictions yet — add one below.
            </p>
          )}
          <div className="mt-3 space-y-3">
            {activeKinds.map((kind) => (
              <RuleCard
                key={kind}
                kind={kind}
                draft={drafts[kind] ?? {}}
                onFieldChange={(field, value) => updateField(kind, field, value)}
                onRemove={() => removeKind(kind)}
              />
            ))}
          </div>

          {availableKinds.length > 0 && (
            <div className="mt-4">
              <div className="mb-2 text-xs uppercase tracking-widest text-muted-foreground">
                + Add restriction
              </div>
              <div className="flex flex-wrap gap-1.5">
                {availableKinds.map((kind) => (
                  <button
                    key={kind}
                    onClick={() => addKind(kind)}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 text-[11px] font-medium transition hover:bg-secondary"
                  >
                    <Plus className="h-3 w-3" /> {RULE_KIND_META[kind].label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="p-5 max-h-[65vh] overflow-y-auto">
          <div className="text-xs uppercase tracking-widest text-muted-foreground">
            Live preview
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            What the agent is actually told it can do. <strong>on-chain</strong> caps are proved
            against the real transaction; <strong>pre-flight</strong> caps are enforced by the Rill
            compiler + signer instead.
          </p>

          <div className="mt-3 space-y-2">
            {composedManifest.rules.length === 0 && (
              <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                Add at least one restriction — an empty manifest means unlimited agent spend.
              </p>
            )}

            {composedManifest.rules.length > 0 && !validation.ok && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>{validation.error}</span>
              </div>
            )}

            {composedManifest.rules.length > 0 && validation.ok && previewLoading && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking with Rill backend…
              </div>
            )}

            {composedManifest.rules.length > 0 &&
              validation.ok &&
              !previewLoading &&
              previewError && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>{previewError}</span>
                </div>
              )}

            {preview && validation.ok && (
              <ul className="space-y-1.5">
                {preview.declaration.caps.map((cap, i) => (
                  <li
                    key={`${cap.label}-${i}`}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background/60 px-3 py-2 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="font-medium">{cap.label}</div>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                        {cap.value}
                      </div>
                    </div>
                    <EnforcementBadge enforcement={cap.enforcement} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </DialogShell>
  );
}
