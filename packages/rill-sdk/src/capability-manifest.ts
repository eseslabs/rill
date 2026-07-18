import { z } from 'zod';
import { findToken } from './tokens';
import { parseU64String } from './amounts';

/**
 * `CapabilityManifest` (KTD-3, R5, R6): the ONE typed source of truth for a wallet's restriction
 * rules. It is a composable list of independent rules — the SDK-level mirror of the on-chain
 * Rule + Hot Potato pattern (KTD-1) attached as dynamic fields on `SpendPolicy` (KTD-2). Owner
 * edits the manifest once; three projections stay in sync:
 *   - `toOnChainRuleParams` — the `add_rule`/`prove` argument shapes U5's compiler assembles into
 *     the PTB (hard enforcement).
 *   - `toSignerPolicy` — the flat pre-flight shape Fajar's signer mirror consumes (fail-fast,
 *     SHAPE ONLY per the U6 coordination contract — the signer owns its own re-derivation).
 *   - `toDeclaration` — a structured, human/agent-readable rendering U3 turns into skill.md /
 *     agent-instructions markdown.
 *
 * This is the WALLET-LEVEL manifest (persistent, owner-set at onboarding, changeable only by the
 * owner). It is deliberately distinct from the per-transaction `steps[]` array on
 * `ExecutionEnvelopeSchema` (`./envelope.schema.ts`, Fajar's territory) — `steps[]` describes what
 * ONE compiled transaction does; `CapabilityManifest` describes what the wallet will EVER allow.
 * The signer validates each transaction's `steps[]` against the manifest's projected policy; this
 * module does not touch `envelope.schema.ts` and is not itself validated against it.
 *
 * KTD-6 (honest-behavior default): a manifest with zero rules is rejected outright — "no
 * restrictions" is unlimited agent spend, which is unsafe, not a lenient default. Every rule kind
 * may be attached at most once (last-writer-wins/duplicate rules would just be confusing — reject
 * rather than silently merge or shadow).
 */

// ---- Shared field validators, reusing the SDK's single money-path / address conventions --------

/**
 * A Sui address/object id: `0x` + 1-64 hex chars — the same pattern used by
 * `rill-backend/src/http/schemas/api.schema.ts`'s `suiAddress` helper, duplicated here rather than
 * imported because the SDK package must not depend on the backend.
 */
const SUI_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{1,64}$/;

function suiAddress(label: string) {
  return z
    .string()
    .regex(SUI_ADDRESS_PATTERN, `${label} must be a 0x-prefixed hex Sui address (e.g. "0x2" or a 64-char object id).`);
}

/**
 * A decimal u64 string field, validated through `parseU64String` (this file's single money-path
 * dependency — see `./amounts.ts`) so a rule's amount/timestamp fields reject the exact same
 * inputs (empty, signed, decimal, scientific notation, over-u64) that every other u64 field in
 * Rill rejects, with no second implementation of that logic.
 */
function u64String(fieldName: string) {
  return z.string().min(1).refine(
    (value) => {
      try {
        parseU64String(value, fieldName);
        return true;
      } catch {
        return false;
      }
    },
    { message: `${fieldName} must be a decimal u64 string (no sign, decimal point, or scientific notation).` },
  );
}

// ---- Rule kinds ----------------------------------------------------------------------------------

export const RULE_KINDS = [
  'budget',
  'per_tx',
  'rate_limit',
  'protocol_scope',
  'slippage_floor',
  'asset_scope',
  'recipient_allowlist',
  'time_window',
] as const;

export type RuleKind = (typeof RULE_KINDS)[number];

const BudgetRuleSchema = z.object({
  kind: z.literal('budget'),
  /** Lifetime spend ceiling for the wallet, in base units (mist for SUI). */
  totalMist: u64String('rules[budget].totalMist'),
}).strict();

const PerTxRuleSchema = z.object({
  kind: z.literal('per_tx'),
  /** Per-transaction spend ceiling, in base units. */
  maxMist: u64String('rules[per_tx].maxMist'),
}).strict();

const RateLimitRuleSchema = z.object({
  kind: z.literal('rate_limit'),
  /** Rolling window length in milliseconds. */
  windowMs: u64String('rules[rate_limit].windowMs'),
  /** Max spend, in base units, within any one window. */
  maxMist: u64String('rules[rate_limit].maxMist'),
}).strict();

const ProtocolScopeRuleSchema = z.object({
  kind: z.literal('protocol_scope'),
  /** Only PTB calls targeting one of these package ids are permitted. */
  allowedPackages: z.array(suiAddress('rules[protocol_scope].allowedPackages[]'))
    .min(1, 'rules[protocol_scope].allowedPackages must not be empty (empty scope means no protocol is reachable — declare at least one, or omit the rule).'),
}).strict();

const SlippageFloorRuleSchema = z.object({
  kind: z.literal('slippage_floor'),
  /** Minimum acceptable swap output, in base units (absolute, not basis points) — mirrors the
   *  on-chain guard `rill_guard::guard::assert_min_value(coin, min)`, which only ever compares
   *  against an absolute floor. Enforced PRE-FLIGHT, never on-chain: at PTB rule-prove time the
   *  swap's real output does not exist yet (it is the value being computed), so there is nothing
   *  on-chain to compare against. The floor is enforced twice, earlier in the pipeline — the
   *  compiler's min-out guardrail refuses to build a PTB whose quoted output undercuts it, and the
   *  signer independently re-checks the actual swap output before countersigning. */
  minOutMist: u64String('rules[slippage_floor].minOutMist'),
}).strict();

const AssetScopeRuleSchema = z.object({
  kind: z.literal('asset_scope'),
  /** Only these coin types may move through the wallet. */
  allowedCoinTypes: z.array(z.string().min(1))
    .min(1, 'rules[asset_scope].allowedCoinTypes must not be empty (empty scope means no coin is spendable — declare at least one, or omit the rule).'),
}).strict();

const RecipientAllowlistRuleSchema = z.object({
  kind: z.literal('recipient_allowlist'),
  /** Only these addresses may receive funds/objects from the wallet. */
  addresses: z.array(suiAddress('rules[recipient_allowlist].addresses[]'))
    .min(1, 'rules[recipient_allowlist].addresses must not be empty (empty allowlist means no recipient is reachable — declare at least one, or omit the rule).'),
}).strict();

// Mirrors the on-chain rule (agent_wallet::time_window): both bounds are required, there is no
// hour-of-day concept, and notBeforeMs must be strictly less than notAfterMs (a zero-width or
// inverted window can never be satisfied). The strict-ordering check lives in the manifest-level
// refine below, because a discriminated-union member must stay a plain ZodObject.
const TimeWindowRuleSchema = z.object({
  kind: z.literal('time_window'),
  /** Unix ms at/after which spends are allowed (inclusive lower bound). */
  notBeforeMs: u64String('rules[time_window].notBeforeMs'),
  /** Unix ms before which spends are allowed (exclusive upper bound). */
  notAfterMs: u64String('rules[time_window].notAfterMs'),
}).strict();

const RuleSchema = z.discriminatedUnion('kind', [
  BudgetRuleSchema,
  PerTxRuleSchema,
  RateLimitRuleSchema,
  ProtocolScopeRuleSchema,
  SlippageFloorRuleSchema,
  AssetScopeRuleSchema,
  RecipientAllowlistRuleSchema,
  TimeWindowRuleSchema,
]);

export type CapabilityRule = z.infer<typeof RuleSchema>;
export type BudgetRule = z.infer<typeof BudgetRuleSchema>;
export type PerTxRule = z.infer<typeof PerTxRuleSchema>;
export type RateLimitRule = z.infer<typeof RateLimitRuleSchema>;
export type ProtocolScopeRule = z.infer<typeof ProtocolScopeRuleSchema>;
export type SlippageFloorRule = z.infer<typeof SlippageFloorRuleSchema>;
export type AssetScopeRule = z.infer<typeof AssetScopeRuleSchema>;
export type RecipientAllowlistRule = z.infer<typeof RecipientAllowlistRuleSchema>;
export type TimeWindowRule = z.infer<typeof TimeWindowRuleSchema>;

// ---- Manifest --------------------------------------------------------------------------------

export const CapabilityManifestSchema = z.object({
  /** The coin type this wallet spends (e.g. `0x2::sui::SUI`) — used to format amounts for display. */
  walletCoinType: z.string().min(1, 'walletCoinType is required.'),
  rules: z.array(RuleSchema),
}).strict().superRefine((manifest, ctx) => {
  if (manifest.rules.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'CapabilityManifest.rules must not be empty: a manifest with no restrictions grants '
        + 'the agent unlimited, unconditional spend, which is unsafe. Attach at least one rule '
        + '(e.g. "budget") before onboarding — there is no honest "no restrictions" default.',
      path: ['rules'],
    });
    return;
  }
  const seenKinds = new Set<RuleKind>();
  manifest.rules.forEach((rule, index) => {
    if (seenKinds.has(rule.kind)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate rule kind "${rule.kind}" at rules[${index}]: each rule kind may appear `
          + 'at most once in a CapabilityManifest. Remove the duplicate, or fold both into one rule '
          + 'if you intended two different limits of the same kind.',
        path: ['rules', index, 'kind'],
      });
    }
    seenKinds.add(rule.kind);
    if (rule.kind === 'time_window' && BigInt(rule.notBeforeMs) >= BigInt(rule.notAfterMs)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `rules[${index}] time_window: notBeforeMs must be strictly less than notAfterMs `
          + '(a zero-width or inverted window can never be satisfied — this mirrors the on-chain '
          + 'agent_wallet::time_window assertion).',
        path: ['rules', index, 'notBeforeMs'],
      });
    }
  });
});

export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;

// ---- Move module naming ---------------------------------------------------------------------------
// One name per rule kind, reused by both `toOnChainRuleParams` (module for the `add_rule` call
// target) and any future U1 Move source that needs to agree on naming with the SDK.
//
// There is deliberately no per-kind witness name here (removed post-review, M2): every Move rule
// module's witness struct is literally `Rule`, disambiguated by module path, not by a distinct
// per-kind type name — and the `add()` wrappers take no witness type argument. A prior version of
// this file fabricated names like `BudgetRule`/`PerTxRule` that matched nothing on-chain.

const RULE_MODULE_BY_KIND: Record<RuleKind, string> = {
  budget: 'budget',
  per_tx: 'per_tx',
  rate_limit: 'rate_limit',
  protocol_scope: 'protocol_scope',
  slippage_floor: 'slippage_floor',
  asset_scope: 'asset_scope',
  recipient_allowlist: 'recipient_allowlist',
  time_window: 'time_window',
};

// ---- Cap enforcement layer --------------------------------------------------------------------
// Which layer actually enforces each rule kind, exposed on `CapabilityDeclarationCap.enforcement`
// so downstream renderers can label caps honestly rather than implying every cap is an on-chain
// guarantee. `on-chain` rules are proved via `add_rule`/`prove` against the real PTB and cannot be
// bypassed by a misbehaving compiler or signer. `pre-flight` rules (review finding C2) are enforced
// by the trusted compiler + signer instead, because an on-chain rule can only see self-declared PTB
// metadata (e.g. a "protocol" argument the PTB itself asserts, not an independently observed fact) —
// it is not a weaker guarantee in practice (compiler + signer are both trusted), but it is a
// different one, and the declaration should say so.

const CAP_ENFORCEMENT_BY_KIND: Record<RuleKind, 'on-chain' | 'pre-flight'> = {
  budget: 'on-chain',
  per_tx: 'on-chain',
  rate_limit: 'on-chain',
  time_window: 'on-chain',
  protocol_scope: 'pre-flight',
  slippage_floor: 'pre-flight',
  asset_scope: 'pre-flight',
  recipient_allowlist: 'pre-flight',
};

// ---- Projection 1: on-chain add_rule/prove params -------------------------------------------------

/** A single rule's config value, normalized to the shape a Move `tx.pure.*` argument expects:
 *  u64 fields become `bigint` (this SDK's single money path, see `./amounts.ts`), everything else
 *  passes through as the plain value already validated by the schema. */
export type OnChainRuleConfigValue = bigint | number | string | readonly string[] | readonly number[];

export interface OnChainRuleParams {
  /** The Move module this rule's `add_rule`/`prove`/config-attach functions live in. */
  module: string;
  /** Normalized constructor args for that module's rule config, keyed by field name. */
  config: Record<string, OnChainRuleConfigValue>;
}

/**
 * Projects a validated `CapabilityManifest` to the `add_rule`/`prove` argument shapes U5's
 * compiler assembles into a PTB — one entry per rule that is actually enforced on-chain, in
 * manifest order. u64-string fields are parsed to `bigint` via `parseU64String` (never floating
 * point); everything else is the schema-validated value unchanged.
 *
 * NOT every rule kind projects here: `slippage_floor` is enforced PRE-FLIGHT (the compiler's
 * min-out guardrail + the signer), never on-chain, because at PTB rule-prove time the swap's real
 * output does not exist yet — see `SlippageFloorRuleSchema`'s doc comment. It is intentionally
 * absent from this projection's output; see `CAP_ENFORCEMENT_BY_KIND` / `toDeclaration` for the
 * honest per-cap enforcement label surfaced to owners/agents instead.
 */
export function toOnChainRuleParams(manifest: CapabilityManifest): OnChainRuleParams[] {
  const params: OnChainRuleParams[] = [];
  for (const rule of manifest.rules) {
    const module = RULE_MODULE_BY_KIND[rule.kind];
    switch (rule.kind) {
      case 'budget':
        params.push({ module, config: { totalMist: parseU64String(rule.totalMist, 'totalMist') } });
        break;
      case 'per_tx':
        params.push({ module, config: { maxMist: parseU64String(rule.maxMist, 'maxMist') } });
        break;
      case 'rate_limit':
        params.push({
          module,
          config: {
            windowMs: parseU64String(rule.windowMs, 'windowMs'),
            maxMist: parseU64String(rule.maxMist, 'maxMist'),
          },
        });
        break;
      case 'protocol_scope':
        params.push({ module, config: { allowedPackages: rule.allowedPackages } });
        break;
      case 'slippage_floor':
        // Pre-flight only (see doc comment above and on `SlippageFloorRuleSchema`) — no
        // add_rule/prove projection exists for this rule kind.
        break;
      case 'asset_scope':
        params.push({ module, config: { allowedCoinTypes: rule.allowedCoinTypes } });
        break;
      case 'recipient_allowlist':
        params.push({ module, config: { addresses: rule.addresses } });
        break;
      case 'time_window':
        // Move `time_window::add(not_before_ms, not_after_ms)` — both required.
        params.push({
          module,
          config: {
            notBeforeMs: parseU64String(rule.notBeforeMs, 'notBeforeMs'),
            notAfterMs: parseU64String(rule.notAfterMs, 'notAfterMs'),
          },
        });
        break;
    }
  }
  return params;
}

// ---- Projection 2: signer pre-flight policy (SHAPE ONLY, U6 contract) -----------------------------

export interface SignerPolicy {
  maxAmountMist?: string;
  perTxMaxMist?: string;
  window?: { windowMs: string; maxMist: string };
  allowedPackages?: string[];
  /** Absolute minimum acceptable swap output, in base units — the floor the signer checks against
   *  the real swap output before countersigning (see `SlippageFloorRuleSchema`'s doc comment). */
  minSlippageOutMist?: string;
  allowedCoinTypes?: string[];
  allowedRecipients?: string[];
  timeWindow?: { notBeforeMs: string; notAfterMs: string };
}

/**
 * Projects a validated `CapabilityManifest` to the flat pre-flight shape Fajar's signer mirror
 * consumes (U6 coordination contract). This is a SHAPE-ONLY projection — u64 amounts stay decimal
 * strings (the wire/JSON-safe representation used across the rest of Rill, e.g.
 * `ExecutionEnvelope.resolvedParams.spendAmountMist`), not `bigint`, and the signer independently
 * re-derives its own enforcement from this shape rather than trusting it blindly. Keys for rule
 * kinds absent from the manifest are simply omitted (not `undefined`-valued), so a consumer can use
 * `'maxAmountMist' in policy` / plain truthiness checks without extra care.
 */
export function toSignerPolicy(manifest: CapabilityManifest): SignerPolicy {
  const policy: SignerPolicy = {};
  for (const rule of manifest.rules) {
    switch (rule.kind) {
      case 'budget':
        policy.maxAmountMist = rule.totalMist;
        break;
      case 'per_tx':
        policy.perTxMaxMist = rule.maxMist;
        break;
      case 'rate_limit':
        policy.window = { windowMs: rule.windowMs, maxMist: rule.maxMist };
        break;
      case 'protocol_scope':
        policy.allowedPackages = rule.allowedPackages;
        break;
      case 'slippage_floor':
        policy.minSlippageOutMist = rule.minOutMist;
        break;
      case 'asset_scope':
        policy.allowedCoinTypes = rule.allowedCoinTypes;
        break;
      case 'recipient_allowlist':
        policy.allowedRecipients = rule.addresses;
        break;
      case 'time_window':
        // Both bounds are required by the schema (mirrors Move `time_window::add`), so the signer
        // mirror always receives a fully-specified window — no optional fields to guard.
        policy.timeWindow = { notBeforeMs: rule.notBeforeMs, notAfterMs: rule.notAfterMs };
        break;
    }
  }
  return policy;
}

// ---- Projection 3: human/agent-readable declaration -----------------------------------------------

export interface CapabilityDeclarationCap {
  label: string;
  value: string;
  /** Which layer actually enforces this cap — `'on-chain'` (proved against the real PTB via
   *  `add_rule`/`prove`) or `'pre-flight'` (enforced by the trusted compiler + signer instead,
   *  because an on-chain rule can only see self-declared PTB metadata — review finding C2). See
   *  `CAP_ENFORCEMENT_BY_KIND` for the per-kind assignment. */
  enforcement: 'on-chain' | 'pre-flight';
}

export interface CapabilityDeclaration {
  /** One plain-language sentence per active rule, in manifest order. */
  summaryLines: string[];
  /** One {label, value} pair per active rule, in manifest order — U3 renders these as a table/list. */
  caps: CapabilityDeclarationCap[];
}

/** Formats a u64 base-unit amount as a human-readable `"<amount> <SYMBOL>"` string using the token
 *  registry (`./tokens.ts`). Falls back to a labeled raw-base-units string for a coin type this
 *  registry does not know — declaration text degrades honestly rather than guessing decimals. */
function formatAmount(mist: string, coinType: string): string {
  const token = findToken(coinType);
  if (!token) {
    return `${mist} base units of ${coinType}`;
  }
  const raw = BigInt(mist);
  const divisor = 10n ** BigInt(token.decimals);
  const whole = raw / divisor;
  const remainder = raw % divisor;
  if (remainder === 0n) {
    return `${whole} ${token.symbol}`;
  }
  const fraction = remainder.toString().padStart(token.decimals, '0').replace(/0+$/, '');
  return `${whole}.${fraction} ${token.symbol}`;
}

/** Formats a millisecond duration as a compact human string, preferring the coarsest unit that
 *  divides it evenly (e.g. `"3600000"` -> `"1h"`), falling back to raw milliseconds otherwise. */
function formatWindow(windowMs: string): string {
  const ms = BigInt(windowMs);
  if (ms > 0n && ms % 3_600_000n === 0n) return `${ms / 3_600_000n}h`;
  if (ms > 0n && ms % 60_000n === 0n) return `${ms / 60_000n}m`;
  if (ms > 0n && ms % 1_000n === 0n) return `${ms / 1_000n}s`;
  return `${windowMs}ms`;
}

/** The largest millisecond offset JS `Date` can represent (`±8,640,000,000,000,000`, ECMA-262
 *  20.4.1.1) — a schema-valid u64 ms value can exceed this by a wide margin. */
const MAX_SAFE_DATE_MS = 8_640_000_000_000_000;

/** Formats a millisecond timestamp as an ISO string, or — if it falls outside JS `Date`'s
 *  representable range — the raw millisecond value with an explanatory suffix, rather than
 *  constructing an `Invalid Date` and letting `.toISOString()` throw `RangeError`. */
function formatDateMs(ms: string): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || Math.abs(n) > MAX_SAFE_DATE_MS) {
    return `${ms} ms (beyond representable date)`;
  }
  return new Date(n).toISOString();
}

/** Formats a `time_window` rule as a `"not before <ISO>; before <ISO> (exclusive)"` clause,
 *  matching Move's half-open `[notBefore, notAfter)` semantics — the upper bound is explicitly
 *  marked exclusive rather than phrased as a symmetric "not after". Both bounds are always present
 *  (schema-required, mirroring Move `time_window::add`), so there is no vacuous case. */
function describeTimeWindow(rule: TimeWindowRule): string {
  const before = formatDateMs(rule.notBeforeMs);
  const after = formatDateMs(rule.notAfterMs);
  return `not before ${before}; before ${after} (exclusive)`;
}

/** Renders one rule to a `{summaryLine, cap}` pair of plain-language text (KTD-6: declares exactly
 *  the active rule, no aspirational claims). */
function describeRule(rule: CapabilityRule, walletCoinType: string): { summaryLine: string; cap: CapabilityDeclarationCap } {
  const enforcement = CAP_ENFORCEMENT_BY_KIND[rule.kind];
  switch (rule.kind) {
    case 'budget': {
      const value = formatAmount(rule.totalMist, walletCoinType);
      return { summaryLine: `Budget ≤ ${value} total`, cap: { label: 'Budget', value, enforcement } };
    }
    case 'per_tx': {
      const value = formatAmount(rule.maxMist, walletCoinType);
      return { summaryLine: `Per-transaction ≤ ${value}`, cap: { label: 'Per-tx max', value, enforcement } };
    }
    case 'rate_limit': {
      const amount = formatAmount(rule.maxMist, walletCoinType);
      const window = formatWindow(rule.windowMs);
      return {
        summaryLine: `≤ ${amount} per ${window} window`,
        cap: { label: 'Rate limit', value: `${amount} / ${window}`, enforcement },
      };
    }
    case 'protocol_scope': {
      const value = rule.allowedPackages.join(', ');
      return { summaryLine: `Only protocols: ${value}`, cap: { label: 'Allowed protocols', value, enforcement } };
    }
    case 'slippage_floor': {
      const value = formatAmount(rule.minOutMist, walletCoinType);
      return {
        summaryLine: `Min swap output ≥ ${value}`,
        cap: { label: 'Min swap output', value, enforcement },
      };
    }
    case 'asset_scope': {
      const value = rule.allowedCoinTypes.join(', ');
      return { summaryLine: `Only coins: ${value}`, cap: { label: 'Allowed coins', value, enforcement } };
    }
    case 'recipient_allowlist': {
      const value = rule.addresses.join(', ');
      return { summaryLine: `Only recipients: ${value}`, cap: { label: 'Allowed recipients', value, enforcement } };
    }
    case 'time_window': {
      const value = describeTimeWindow(rule);
      return { summaryLine: `Time window: ${value}`, cap: { label: 'Time window', value, enforcement } };
    }
  }
}

/**
 * Projects a validated `CapabilityManifest` to a structured, human/agent-readable declaration:
 * one summary sentence and one `{label, value}` cap per active rule, in manifest order. `U3`
 * (agent-instructions template) renders `summaryLines`/`caps` into skill.md markdown; this
 * function only produces the structured data, not markdown formatting, so other consumers (a
 * studio UI capability-preview panel, U7) can render it their own way.
 */
export function toDeclaration(manifest: CapabilityManifest): CapabilityDeclaration {
  const rendered = manifest.rules.map((rule) => describeRule(rule, manifest.walletCoinType));
  return {
    summaryLines: rendered.map((r) => r.summaryLine),
    caps: rendered.map((r) => r.cap),
  };
}
