/**
 * Reads the enforced bounds of an on-chain `AgentWallet` and maps them to display rows.
 *
 * The point of this module is that every row says *what actually enforces it*. The source of
 * truth is neither the frontend nor the signer's local run-set JSON — it is the AgentWallet
 * shared object. `move/agent_wallet/sources/agent_wallet.move` is the only authority here, and
 * these mappings are pinned to it:
 *
 *   spend() asserts, in this order:
 *     cap.wallet == object::id(wallet)          E_BAD_CAP      = 6
 *     !wallet.revoked                           E_REVOKED      = 2
 *     clock.timestamp_ms() < expires_at_ms      E_EXPIRED      = 3
 *     amount > 0                                E_ZERO_AMOUNT  = 7
 *     amount <= wallet.per_tx_max               E_OVER_PER_TX  = 4
 *     amount <= wallet.budget.value()           E_OVER_BUDGET  = 5
 *
 * `allowed_packages` is deliberately absent from that list. The module's own doc says why:
 * Move cannot intercept where a released coin is used, so protocol scope is recorded on-chain
 * and enforced by the compiler and the local signer. Every label below reflects that split.
 */

/** How a bound is actually enforced — not how the UI would like to describe it. */
export type Enforcement = "on-chain" | "off-chain" | "none";

export type BoundRow = {
  label: string;
  value: string;
  enforcement: Enforcement;
  /** The concrete mechanism, named. An unnamed mechanism is a claim, not evidence. */
  enforcedBy: string;
};

/** `content.fields` of an AgentWallet<T>, exactly as Sui JSON-RPC returns them. */
export type RawAgentWallet = {
  per_tx_max?: unknown;
  spent?: unknown;
  budget?: unknown;
  expires_at_ms?: unknown;
  revoked?: unknown;
  allowed_packages?: unknown;
};

export type WalletStatus = "ACTIVE" | "REVOKED" | "EXPIRED";

export type EnforcedBounds = {
  bound: boolean;
  status: WalletStatus | string;
  perTxMaxSui: string;
  remainingSui: string;
  spentSui: string;
  expiry: string;
  scope: string[];
  scopeValue: string;
  scopeEnforcement: string;
  rows: BoundRow[];
};

export const NO_WALLET_BOUND = "No agent wallet bound — nothing is enforced yet.";

/**
 * `allowed_packages` is on-chain data that the chain itself never checks in `spend()`.
 * Saying otherwise in a security panel is the exact failure this module exists to prevent.
 */
export const SCOPE_ENFORCEMENT =
  "Recorded on-chain, NOT enforced on-chain — the compiler and local signer enforce it";

const MIST_PER_SUI_DECIMALS = 9n;
const DISPLAY_DECIMALS = 3;

/**
 * Reads a u64 that Sui may hand back as a string, a number, or — for `Balance<T>` — a struct.
 * Mirrors `packages/rill-signer/src/policy.ts:readMoveU64`, which reads the same object.
 */
function readU64(value: unknown, name: string): bigint {
  if (typeof value === "string" || typeof value === "number") return BigInt(value);
  if (value && typeof value === "object") {
    const record = value as { value?: unknown; fields?: { value?: unknown } };
    const nested = record.value ?? record.fields?.value;
    if (typeof nested === "string" || typeof nested === "number") return BigInt(nested);
  }
  throw new Error(`AgentWallet ${name} is not a u64 field.`);
}

/**
 * MIST → SUI with exact integer arithmetic and truncation. Never a float: a float would
 * silently round a money value, and rounding *up* would overstate a remaining budget.
 */
export function formatMistAsSui(mist: bigint): string {
  const unit = 10n ** MIST_PER_SUI_DECIMALS;
  const whole = mist / unit;
  const frac = (mist % unit).toString().padStart(Number(MIST_PER_SUI_DECIMALS), "0");
  return `${whole}.${frac.slice(0, DISPLAY_DECIMALS)}`;
}

/** Pulls the AgentWallet fields out of a `getObject({ showContent: true })` response. */
export function extractWalletFields(response: unknown): RawAgentWallet | null {
  const content = (response as { data?: { content?: { dataType?: string; fields?: unknown } } })
    ?.data?.content;
  if (!content || content.dataType !== "moveObject") return null;
  const fields = content.fields;
  if (!fields || typeof fields !== "object") return null;
  return fields as RawAgentWallet;
}

function formatExpiry(expiresAtMs: bigint, now: number): { text: string; expired: boolean } {
  // agent_wallet::spend asserts `clock.timestamp_ms() < expires_at_ms`. There is no sentinel
  // for "never expires": 0 is simply a timestamp in 1970, so it aborts (code 3) every time.
  if (expiresAtMs <= BigInt(now)) {
    const when = expiresAtMs === 0n ? "never set" : new Date(Number(expiresAtMs)).toISOString();
    return { text: `Expired (${when}) — every spend aborts`, expired: true };
  }
  return { text: new Date(Number(expiresAtMs)).toISOString(), expired: false };
}

/**
 * Maps a raw AgentWallet to the bounds the chain enforces right now.
 * `null` means no wallet is bound — an honest empty state, not an error to hide.
 */
export function toEnforcedBounds(
  raw: RawAgentWallet | null,
  now: number = Date.now(),
): EnforcedBounds {
  if (!raw) {
    return {
      bound: false,
      status: NO_WALLET_BOUND,
      perTxMaxSui: "—",
      remainingSui: "—",
      spentSui: "—",
      expiry: "—",
      scope: [],
      scopeValue: "—",
      scopeEnforcement: SCOPE_ENFORCEMENT,
      rows: [],
    };
  }

  const perTxMax = readU64(raw.per_tx_max, "per_tx_max");
  // NOT per_tx_max - spent: spend() asserts `amount <= budget.value()`, so the Balance is the
  // only figure the chain will actually stop you at. `spent` is a counter, not a bound.
  const remaining = readU64(raw.budget, "budget");
  const spent = readU64(raw.spent, "spent");
  const expiresAtMs = readU64(raw.expires_at_ms, "expires_at_ms");
  const revoked = raw.revoked === true;
  const scope = Array.isArray(raw.allowed_packages) ? raw.allowed_packages.map(String) : [];

  const expiry = formatExpiry(expiresAtMs, now);
  // Ordered as spend() checks them: revoked (code 2) aborts before expiry (code 3).
  const status: WalletStatus = revoked ? "REVOKED" : expiry.expired ? "EXPIRED" : "ACTIVE";
  const scopeValue =
    scope.length === 0
      ? "No packages recorded — this wallet records no scope restriction"
      : scope.join(", ");

  const perTxMaxSui = formatMistAsSui(perTxMax);
  const remainingSui = formatMistAsSui(remaining);

  return {
    bound: true,
    status,
    perTxMaxSui,
    remainingSui,
    spentSui: formatMistAsSui(spent),
    expiry: expiry.text,
    scope,
    scopeValue,
    scopeEnforcement: SCOPE_ENFORCEMENT,
    rows: [
      {
        label: "Per-transaction ceiling",
        value: `${perTxMaxSui} SUI`,
        enforcement: "on-chain",
        enforcedBy: "agent_wallet::spend aborts (code 4, E_OVER_PER_TX)",
      },
      {
        label: "Budget remaining",
        value: `${remainingSui} SUI`,
        enforcement: "on-chain",
        enforcedBy: "agent_wallet::spend aborts (code 5, E_OVER_BUDGET)",
      },
      {
        label: "Expiry",
        value: expiry.text,
        enforcement: "on-chain",
        enforcedBy: "agent_wallet::spend aborts (code 3, E_EXPIRED)",
      },
      {
        label: "Status",
        value: status,
        enforcement: "on-chain",
        enforcedBy: "agent_wallet::spend aborts (code 2, E_REVOKED)",
      },
      {
        label: "Protocol scope",
        value: scopeValue,
        enforcement: "off-chain",
        enforcedBy: SCOPE_ENFORCEMENT,
      },
    ],
  };
}

/**
 * The slippage floor row. Unlike every other row it comes from the flow, not the wallet —
 * the compiler injects `rill_guard::assert_min_value(coin, minValue)` from the guardrail node.
 * A missing or zero floor is reported as enforcing nothing, because that is what it does.
 */
export function toSlippageFloorRow(minValueMist: string | null | undefined): BoundRow {
  const parsed = minValueMist == null || minValueMist === "" ? 0n : BigInt(minValueMist);
  if (parsed <= 0n) {
    return {
      label: "Slippage floor",
      value: "No floor configured — nothing is asserted",
      enforcement: "none",
      enforcedBy: "Set a minimum on a Guardrail node to emit rill_guard::assert_min_value",
    };
  }
  return {
    label: "Slippage floor",
    value: `${formatMistAsSui(parsed)} SUI`,
    enforcement: "on-chain",
    enforcedBy: "rill_guard::assert_min_value aborts below this amount",
  };
}
