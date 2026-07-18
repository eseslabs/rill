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
  /** Minimum acceptable output, expressed in basis points (0..10000) of the quoted amount. */
  minBps: z.number().finite().min(0).max(10000),
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

// ---- Move module / witness naming ----------------------------------------------------------------
// One name per rule kind, reused by both `toOnChainRuleParams` (module for the `add_rule<Witness>`
// call target) and any future U1 Move source that needs to agree on naming with the SDK.

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

const RULE_WITNESS_BY_KIND: Record<RuleKind, string> = {
  budget: 'BudgetRule',
  per_tx: 'PerTxRule',
  rate_limit: 'RateLimitRule',
  protocol_scope: 'ProtocolScopeRule',
  slippage_floor: 'SlippageFloorRule',
  asset_scope: 'AssetScopeRule',
  recipient_allowlist: 'RecipientAllowlistRule',
  time_window: 'TimeWindowRule',
};

// ---- Projection 1: on-chain add_rule/prove params -------------------------------------------------

/** A single rule's config value, normalized to the shape a Move `tx.pure.*` argument expects:
 *  u64 fields become `bigint` (this SDK's single money path, see `./amounts.ts`), everything else
 *  passes through as the plain value already validated by the schema. */
export type OnChainRuleConfigValue = bigint | number | string | readonly string[] | readonly number[];

export interface OnChainRuleParams {
  /** The Move witness struct name identifying this rule (combines with the deployed package +
   *  `module` to form the full `add_rule<Witness>` type argument once U1 ships the Move source). */
  ruleWitness: string;
  /** The Move module this rule's `prove`/config-attach functions live in. */
  module: string;
  /** Normalized constructor args for that module's rule config, keyed by field name. */
  config: Record<string, OnChainRuleConfigValue>;
}

/**
 * Projects a validated `CapabilityManifest` to the `add_rule`/`prove` argument shapes U5's
 * compiler assembles into a PTB — one entry per rule, in manifest order. u64-string fields are
 * parsed to `bigint` via `parseU64String` (never floating point); everything else is the
 * schema-validated value unchanged.
 */
export function toOnChainRuleParams(manifest: CapabilityManifest): OnChainRuleParams[] {
  return manifest.rules.map((rule): OnChainRuleParams => {
    const ruleWitness = RULE_WITNESS_BY_KIND[rule.kind];
    const module = RULE_MODULE_BY_KIND[rule.kind];
    switch (rule.kind) {
      case 'budget':
        return { ruleWitness, module, config: { totalMist: parseU64String(rule.totalMist, 'totalMist') } };
      case 'per_tx':
        return { ruleWitness, module, config: { maxMist: parseU64String(rule.maxMist, 'maxMist') } };
      case 'rate_limit':
        return {
          ruleWitness,
          module,
          config: {
            windowMs: parseU64String(rule.windowMs, 'windowMs'),
            maxMist: parseU64String(rule.maxMist, 'maxMist'),
          },
        };
      case 'protocol_scope':
        return { ruleWitness, module, config: { allowedPackages: rule.allowedPackages } };
      case 'slippage_floor':
        return { ruleWitness, module, config: { minBps: rule.minBps } };
      case 'asset_scope':
        return { ruleWitness, module, config: { allowedCoinTypes: rule.allowedCoinTypes } };
      case 'recipient_allowlist':
        return { ruleWitness, module, config: { addresses: rule.addresses } };
      case 'time_window':
        // Move `time_window::add(not_before_ms, not_after_ms)` — both required.
        return {
          ruleWitness,
          module,
          config: {
            notBeforeMs: parseU64String(rule.notBeforeMs, 'notBeforeMs'),
            notAfterMs: parseU64String(rule.notAfterMs, 'notAfterMs'),
          },
        };
    }
  });
}

// ---- Projection 2: signer pre-flight policy (SHAPE ONLY, U6 contract) -----------------------------

export interface SignerPolicy {
  maxAmountMist?: string;
  perTxMaxMist?: string;
  window?: { windowMs: string; maxMist: string };
  allowedPackages?: string[];
  minSlippageBps?: number;
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
        policy.minSlippageBps = rule.minBps;
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

/** Formats a `time_window` rule as a `"not before <ISO>; not after <ISO>"` clause. Both bounds are
 *  always present (schema-required, mirroring Move `time_window::add`), so there is no vacuous case. */
function describeTimeWindow(rule: TimeWindowRule): string {
  const before = new Date(Number(rule.notBeforeMs)).toISOString();
  const after = new Date(Number(rule.notAfterMs)).toISOString();
  return `not before ${before}; not after ${after}`;
}

/** Renders one rule to a `{summaryLine, cap}` pair of plain-language text (KTD-6: declares exactly
 *  the active rule, no aspirational claims). */
function describeRule(rule: CapabilityRule, walletCoinType: string): { summaryLine: string; cap: CapabilityDeclarationCap } {
  switch (rule.kind) {
    case 'budget': {
      const value = formatAmount(rule.totalMist, walletCoinType);
      return { summaryLine: `Budget ≤ ${value} total`, cap: { label: 'Budget', value } };
    }
    case 'per_tx': {
      const value = formatAmount(rule.maxMist, walletCoinType);
      return { summaryLine: `Per-transaction ≤ ${value}`, cap: { label: 'Per-tx max', value } };
    }
    case 'rate_limit': {
      const amount = formatAmount(rule.maxMist, walletCoinType);
      const window = formatWindow(rule.windowMs);
      return {
        summaryLine: `≤ ${amount} per ${window} window`,
        cap: { label: 'Rate limit', value: `${amount} / ${window}` },
      };
    }
    case 'protocol_scope': {
      const value = rule.allowedPackages.join(', ');
      return { summaryLine: `Only protocols: ${value}`, cap: { label: 'Allowed protocols', value } };
    }
    case 'slippage_floor': {
      const value = `${rule.minBps} bps`;
      return { summaryLine: `Slippage floor ${value}`, cap: { label: 'Slippage floor', value } };
    }
    case 'asset_scope': {
      const value = rule.allowedCoinTypes.join(', ');
      return { summaryLine: `Only coins: ${value}`, cap: { label: 'Allowed coins', value } };
    }
    case 'recipient_allowlist': {
      const value = rule.addresses.join(', ');
      return { summaryLine: `Only recipients: ${value}`, cap: { label: 'Allowed recipients', value } };
    }
    case 'time_window': {
      const value = describeTimeWindow(rule);
      return { summaryLine: `Time window: ${value}`, cap: { label: 'Time window', value } };
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
