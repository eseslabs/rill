// Relative import into the workspace SDK source — matches the convention used elsewhere in the FE
// (see `./action-config.ts`). The package has no committed build output, so importing by the
// "@rill/sdk" name would only resolve where a local dist/ happens to exist; importing the source
// directly always resolves and lets the bundler compile it.
import {
  CapabilityManifestSchema,
  RULE_KINDS,
  toDeclaration,
  type AssetScopeRule,
  type BudgetRule,
  type CapabilityDeclarationCap,
  type CapabilityManifest,
  type CapabilityRule,
  type PerTxRule,
  type ProtocolScopeRule,
  type RateLimitRule,
  type RecipientAllowlistRule,
  type RuleKind,
  type SlippageFloorRule,
  type TimeWindowRule,
  decimalToBaseUnits,
} from "../../../packages/rill-sdk/src";

/**
 * FE-only helpers around the SDK's `CapabilityManifest` (see
 * `packages/rill-sdk/src/capability-manifest.ts`, the single source of truth for rule shapes,
 * validation, and the on-chain/pre-flight enforcement split). This module never re-implements
 * that logic — it only adapts human form input into schema-valid `CapabilityRule`s (and back, for
 * pre-filling an edit form) so `components/flow/capabilities-dialog.tsx` can stay thin.
 */

/** Native SUI's base-unit exponent (`1 SUI == 10^9 mist`) — the default decimals for every amount
 *  field in the composer today, since `emptyManifest()` seeds `walletCoinType` to SUI and this
 *  phase doesn't yet offer a coin-type switcher. */
const SUI_DECIMALS = 9;

// ---- Rule-kind metadata, for the "+ Add restriction" picker and per-cap enforcement badges ------

export type RuleKindMeta = {
  kind: RuleKind;
  label: string;
  blurb: string;
  /** Mirrors `CAP_ENFORCEMENT_BY_KIND` in `capability-manifest.ts` exactly (asserted by
   *  `capabilities.test.ts` against the SDK's own `toDeclaration` output) — this is the honesty
   *  surface the composer's preview badges are built on, so it must never drift from the SDK. */
  enforcement: "on-chain" | "pre-flight";
};

/** One entry per `RULE_KINDS` member, keyed by kind for O(1) lookup from the dialog. */
export const RULE_KIND_META: Record<RuleKind, RuleKindMeta> = {
  budget: {
    kind: "budget",
    label: "Budget",
    blurb: "Lifetime spend ceiling for the wallet.",
    enforcement: "on-chain",
  },
  per_tx: {
    kind: "per_tx",
    label: "Per-tx max",
    blurb: "Per-transaction spend ceiling.",
    enforcement: "on-chain",
  },
  rate_limit: {
    kind: "rate_limit",
    label: "Rate limit",
    blurb: "Max spend within a rolling time window.",
    enforcement: "on-chain",
  },
  time_window: {
    kind: "time_window",
    label: "Time window",
    blurb: "Only allow spends between two timestamps.",
    enforcement: "on-chain",
  },
  protocol_scope: {
    kind: "protocol_scope",
    label: "Allowed protocols",
    blurb: "Only PTB calls targeting these package ids are permitted.",
    enforcement: "pre-flight",
  },
  asset_scope: {
    kind: "asset_scope",
    label: "Allowed coins",
    blurb: "Only these coin types may move through the wallet.",
    enforcement: "pre-flight",
  },
  recipient_allowlist: {
    kind: "recipient_allowlist",
    label: "Allowed recipients",
    blurb: "Only these addresses may receive funds/objects from the wallet.",
    enforcement: "pre-flight",
  },
  slippage_floor: {
    kind: "slippage_floor",
    label: "Min swap output",
    blurb:
      "Minimum acceptable swap output — enforced pre-flight, never on-chain (the real output doesn't exist yet at prove time).",
    enforcement: "pre-flight",
  },
};

// ---- Human input -> CapabilityRule builders ------------------------------------------------------
// Every SUI amount goes through `decimalToBaseUnits` (the SDK's single money path) — never
// hand-multiplied — so a composer amount and a backend-computed amount can never diverge by a
// rounding bug. Each builder throws whatever `decimalToBaseUnits`/list-parsing throws on invalid
// input; callers that need a graceful "still typing" fallback (the dialog) catch it themselves.

export function budgetRule(totalSui: string, decimals: number = SUI_DECIMALS): BudgetRule {
  return { kind: "budget", totalMist: decimalToBaseUnits(totalSui, decimals).toString() };
}

export function perTxRule(maxSui: string, decimals: number = SUI_DECIMALS): PerTxRule {
  return { kind: "per_tx", maxMist: decimalToBaseUnits(maxSui, decimals).toString() };
}

/** `windowMs` is already a base-unit millisecond count (not a decimal amount), so it is validated
 *  but not routed through `decimalToBaseUnits` — only `maxSui` is a decimal SUI amount. */
export function rateLimitRule(
  maxSui: string,
  windowMs: string,
  decimals: number = SUI_DECIMALS,
): RateLimitRule {
  const trimmed = windowMs.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `rateLimitRule: windowMs must be a decimal integer millisecond count, got "${windowMs}".`,
    );
  }
  return {
    kind: "rate_limit",
    windowMs: trimmed,
    maxMist: decimalToBaseUnits(maxSui, decimals).toString(),
  };
}

export function slippageFloorRule(
  minOutSui: string,
  decimals: number = SUI_DECIMALS,
): SlippageFloorRule {
  return { kind: "slippage_floor", minOutMist: decimalToBaseUnits(minOutSui, decimals).toString() };
}

/** Splits a comma- and/or newline-separated textarea value into a trimmed, non-empty string list —
 *  the shared parsing behind every list-shaped rule kind (protocol_scope/asset_scope/recipient_allowlist). */
export function parseListInput(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function protocolScopeRule(rawList: string): ProtocolScopeRule {
  return { kind: "protocol_scope", allowedPackages: parseListInput(rawList) };
}

export function assetScopeRule(rawList: string): AssetScopeRule {
  return { kind: "asset_scope", allowedCoinTypes: parseListInput(rawList) };
}

export function recipientAllowlistRule(rawList: string): RecipientAllowlistRule {
  return { kind: "recipient_allowlist", addresses: parseListInput(rawList) };
}

/** `notBefore`/`notAfter` are `<input type="datetime-local">` values (local time, no offset) —
 *  converted via `Date`, which parses them in the browser's local timezone, matching what the
 *  input visually showed the owner. */
export function timeWindowRule(notBefore: string, notAfter: string): TimeWindowRule {
  return {
    kind: "time_window",
    notBeforeMs: dateStringToMsString(notBefore, "notBeforeMs"),
    notAfterMs: dateStringToMsString(notAfter, "notAfterMs"),
  };
}

function dateStringToMsString(value: string, fieldName: string): string {
  if (!value) {
    throw new Error(`${fieldName} is required.`);
  }
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`${fieldName}: "${value}" is not a valid date/time.`);
  }
  return Math.max(0, Math.trunc(ms)).toString();
}

// ---- Reverse (rule -> human text) helpers, for pre-filling an edit form -------------------------

/** Reverse of `decimalToBaseUnits`: a base-unit string -> a human decimal string. Pure bigint
 *  arithmetic (never floating point), mirroring `decimalToBaseUnits`'s own no-float guarantee —
 *  used only to pre-fill the composer's edit form from an already-composed rule, never to compute
 *  an amount that gets sent anywhere. */
export function baseUnitsToDecimal(baseUnits: string, decimals: number = SUI_DECIMALS): string {
  const raw = BigInt(baseUnits);
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const remainder = raw % divisor;
  if (remainder === 0n) return whole.toString();
  const fraction = remainder.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fraction}`;
}

/** Reverse of `timeWindowRule`'s ms conversion, formatted for `<input type="datetime-local">`
 *  (`yyyy-MM-ddTHH:mm`, local time, no seconds/offset — matching what that input type accepts). */
export function msToDatetimeLocal(ms: string): string {
  const n = Number(ms);
  if (!Number.isFinite(n)) return "";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (x: number) => x.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Reverse of `parseListInput`: a string list -> one entry per line, for pre-filling a textarea. */
export function listToText(items: readonly string[]): string {
  return items.join("\n");
}

// ---- Manifest-level helpers -----------------------------------------------------------------

/** An empty manifest, ready for the composer to attach rules to. `walletCoinType` defaults to
 *  native SUI — the only coin this phase's composer targets (no coin-type switcher yet). Note this
 *  is intentionally NOT schema-valid on its own (KTD-6: zero rules means unlimited spend, which the
 *  SDK schema rejects) — it is a starting point for the composer, not a publishable manifest. */
export function emptyManifest(walletCoinType: string = "0x2::sui::SUI"): CapabilityManifest {
  return { walletCoinType, rules: [] };
}

export type ManifestValidation = { ok: true } | { ok: false; error: string };

/** Thin wrapper over `CapabilityManifestSchema.safeParse` — the same schema
 *  `POST /capabilities/preview` validates against, so a manifest this reports `ok: true` for is
 *  always accepted by the backend too. Joins every issue message (empty rules, duplicate kinds,
 *  malformed fields, inverted time windows, …) into one string for a single inline error line. */
export function validateManifest(manifest: CapabilityManifest): ManifestValidation {
  const result = CapabilityManifestSchema.safeParse(manifest);
  if (result.success) return { ok: true };
  return { ok: false, error: result.error.issues.map((issue) => issue.message).join("; ") };
}

// ---- Node-level cap filtering (Part B: action node "Bounded by" panel) -------------------------

/** Rule kinds that impose an on-chain spend limit — the caps an action node always shows in its
 *  read-only "Bounded by" panel, since these are the ones that actually shape the amount the agent
 *  may draw against (as opposed to e.g. `protocol_scope`, which restricts *where* funds can go, not
 *  *how much*). */
const SPEND_CAP_KINDS: readonly RuleKind[] = ["budget", "per_tx", "rate_limit"];

/**
 * Projects a manifest to the small subset of caps an action node's "Bounded by" panel (nodes.tsx)
 * renders: the on-chain spend caps (Budget / Per-tx max / Rate limit) always, plus the pre-flight
 * slippage floor when `includeSlippageFloor` is set (Cetus swap only) and the manifest declares
 * one. Zips `manifest.rules` against `toDeclaration(manifest).caps` by index — the two arrays are
 * always the same length and order (see `toDeclaration`'s doc comment) — rather than re-deriving
 * cap text itself, so this can never drift from the SDK's own rendering.
 */
export function boundedByCaps(
  manifest: CapabilityManifest,
  options: { includeSlippageFloor?: boolean } = {},
): CapabilityDeclarationCap[] {
  const { includeSlippageFloor = false } = options;
  const caps = toDeclaration(manifest).caps;
  return manifest.rules
    .map((rule, i) => ({ kind: rule.kind, cap: caps[i] }))
    .filter(
      ({ kind }) =>
        SPEND_CAP_KINDS.includes(kind) || (includeSlippageFloor && kind === "slippage_floor"),
    )
    .map(({ cap }) => cap);
}

/** All declared caps (label + value + enforcement) for a manifest, in rule order — template cards
 *  render these so a preset advertises its FULL suggested capability set with values (e.g. "Budget
 *  5 SUI"), not just the rule names. Same SDK projection the composer preview uses. */
export function manifestCaps(manifest: CapabilityManifest): CapabilityDeclarationCap[] {
  return toDeclaration(manifest).caps;
}

export type { CapabilityDeclarationCap, CapabilityManifest, CapabilityRule, RuleKind };
export { RULE_KINDS };
