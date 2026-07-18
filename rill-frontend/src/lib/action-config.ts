// Relative import into the workspace SDK source — matches the convention used by rill-backend and
// rill-signer. The package has no committed build output, so importing by the "@rill/sdk" name would
// only resolve where a local dist/ happens to exist (it fails in a clean CI install); importing the
// source directly always resolves and lets the bundler compile it.
import { decimalToBaseUnits, findToken } from "../../../packages/rill-sdk/src";

/** Testnet protocol manifest — passed in full to backend on every compile/simulate. */

export const TESTNET_MANIFEST = {
  cetus_swap: {
    integratePackageId: "0xab2d58dd28ff0dc19b18ab2c634397b785a38c342a8f5065ade5f53f9dbffa1c",
    globalConfigId: "0xc6273f844b4bc258952c4e477697aa12c918c8e08106fac6b934811298c9820a",
    defaultPoolId: "0x2603c08065a848b719f5f465e40dbef485ec4fd9c967ebe83a7565269a74a2b2",
    minSqrtPrice: "4295048016",
    maxSqrtPrice: "79226673515401279992447579055",
  },
  haedal_stake: {
    stakeTarget: "0x0a6ff2b974e08b65649d334c38db5ca046b78b4a5d892087740b9cdb3eb08e47::interface::request_stake",
    suiSystemStateId: "0x5",
    stakingObjectId: "0xb399662ac5d3973256a1e8629a913336449a2baa16847502ce6bdbf4a0003f07",
    minStakeMist: "1000000000",
  },
} as const;

export const SWAP_TOKENS = [
  { symbol: "SUI", coinType: "0x2::sui::SUI" },
  {
    symbol: "USDC",
    coinType:
      "0x14a71d857b34677a7d57e0feb303df1adb515a37780645ab763d42ce8d1a5e48::usdc::USDC",
  },
] as const;

export type SwapTokenSymbol = (typeof SWAP_TOKENS)[number]["symbol"];

export const TOKEN_LOGOS: Record<SwapTokenSymbol, string> = {
  SUI: "https://raw.githubusercontent.com/MystenLabs/sui/refs/heads/main/docs/site/static/img/logo.svg",
  USDC: "https://cryptologos.cc/logos/usd-coin-usdc-logo.svg",
};

export const TOKEN_COIN_TYPE: Record<SwapTokenSymbol, string> = Object.fromEntries(
  SWAP_TOKENS.map((t) => [t.symbol, t.coinType]),
) as Record<SwapTokenSymbol, string>;

export type ActionConfig = Record<string, string>;

export function defaultActionConfig(protocolId: string, actionId: string): ActionConfig {
  if (protocolId === "cetus" && actionId === "swap") {
    return { tokenIn: "SUI", tokenOut: "USDC", amount: "0.1" };
  }
  if (protocolId === "haedal" && actionId === "stake") {
    return { amount: "1" };
  }
  if (protocolId === "deepbook" && actionId === "limit_order") {
    return {
      poolKey: "SUI_DBUSDC",
      balanceManagerId: "",
      depositSui: "1.1",
      price: "1",
      quantity: "1",
      isBid: "false",
      payWithDeep: "false",
    };
  }
  return {};
}

/**
 * KTD-2 (docs/plans/2026-07-17-001-fix-audit-hardening-plan.md): the one money path. Every
 * token-amount field an action node renders (Cetus swap `amount`, Haedal stake `amount`) is
 * validated and converted through `@rill/sdk`'s `decimalToBaseUnits` with the *actual* decimals
 * of the selected coin — never a hardcoded 9. Fixes the bug where "1 USDC" (6 decimals) produced
 * `1000000000` base units instead of `1000000`.
 */
export type AmountParseResult = { ok: true; baseUnits: bigint } | { ok: false; error: string };

/** Pure validate+convert. Never throws — callers that only need a yes/no or an error string
 *  should use {@link isValidActionAmount} / {@link actionAmountError} below. Unknown coin types
 *  fall back to 9 decimals (SUI); the swap/stake tokens this builder offers are all registered in
 *  `@rill/sdk`'s token registry, so that fallback path should be rare in practice. */
export function parseActionAmount(amount: string | undefined, coinType: string): AmountParseResult {
  const raw = (amount ?? "").trim();
  const decimals = findToken(coinType)?.decimals ?? 9;
  if (raw === "") {
    return { ok: false, error: "Amount is required." };
  }
  let baseUnits: bigint;
  try {
    baseUnits = decimalToBaseUnits(raw, decimals);
  } catch {
    return {
      ok: false,
      error: `Enter a valid positive amount with up to ${decimals} decimal place${decimals === 1 ? "" : "s"}.`,
    };
  }
  if (baseUnits <= 0n) {
    return { ok: false, error: "Amount must be greater than 0." };
  }
  return { ok: true, baseUnits };
}

/** R5: no silent fallback — the node's inline error and the flow-level simulate/publish gate
 *  (`publish-gate.ts`) both read this same predicate, mirroring `isGuardrailMinValueValid`. */
export function isValidActionAmount(amount: string | undefined, coinType: string): boolean {
  return parseActionAmount(amount, coinType).ok;
}

/** `null` when valid, else a user-facing message for the node's inline field error. */
export function actionAmountError(amount: string | undefined, coinType: string): string | null {
  const result = parseActionAmount(amount, coinType);
  return result.ok ? null : result.error;
}

/** Base-units string for a backend config payload. Returns `"0"` on invalid input instead of
 *  throwing — this runs on every render (via `buildFlowGraph`, including dialogs that are mounted
 *  but not open), so it must never crash the canvas. The actual safety backstop is the gate: an
 *  invalid amount blocks simulate/publish (see `publish-gate.ts`) before this payload is ever sent
 *  to the backend, so "0" here is inert, not a silently-accepted amount. */
function toBaseUnitsString(amount: string | undefined, coinType: string): string {
  const result = parseActionAmount(amount, coinType);
  return result.ok ? result.baseUnits.toString() : "0";
}

/** Convert human-readable token amount to mist (9-decimal SUI base units) string. Used for
 *  UI-only, non-final-path conversions (wire-constraint capping between Cetus swap and Haedal
 *  stake, guardrail `minValue`, both denominated in SUI on this canvas) where a malformed
 *  in-progress keystroke should fall back rather than throw. The security-critical amount path
 *  (`amount_in`/`amount` sent to the backend) goes through {@link parseActionAmount} above instead,
 *  which is gated — never silently defaulted — at the flow level. */
export function toMist(amount: string, fallbackMist: string): string {
  const raw = (amount ?? "").trim();
  try {
    const n = decimalToBaseUnits(raw, 9);
    if (n <= 0n) return fallbackMist;
    return n.toString();
  } catch {
    return fallbackMist;
  }
}

export function otherSwapToken(symbol: SwapTokenSymbol): SwapTokenSymbol {
  return symbol === "SUI" ? "USDC" : "SUI";
}

/** Build backend flow node config — FE owns protocol addresses, BE compiles from this payload. */
export function buildCetusSwapFlowConfig(cfg: ActionConfig) {
  const tokenIn = (cfg.tokenIn as SwapTokenSymbol) || "SUI";
  const m = TESTNET_MANIFEST.cetus_swap;
  const inputCoinType = TOKEN_COIN_TYPE[tokenIn] ?? TOKEN_COIN_TYPE.SUI;
  return {
    integratePackageId: m.integratePackageId,
    globalConfigId: m.globalConfigId,
    pool: m.defaultPoolId,
    inputCoinType,
    outputCoinType: TOKEN_COIN_TYPE[otherSwapToken(tokenIn)],
    amount_in: toBaseUnitsString(cfg.amount ?? "0.1", inputCoinType),
    min_amount_out: "1",
    minSqrtPrice: m.minSqrtPrice,
    maxSqrtPrice: m.maxSqrtPrice,
  };
}

export function buildHaedalStakeFlowConfig(cfg: ActionConfig) {
  const m = TESTNET_MANIFEST.haedal_stake;
  return {
    stakeTarget: m.stakeTarget,
    suiSystemStateId: m.suiSystemStateId,
    stakingObjectId: m.stakingObjectId,
    minStakeMist: m.minStakeMist,
    amount: toBaseUnitsString(cfg.amount ?? "1", TOKEN_COIN_TYPE.SUI),
  };
}

/** Build backend config for a DeepBook limit order. BalanceManager must be funded (onboarding). */
export function buildDeepbookOrderFlowConfig(cfg: ActionConfig) {
  return {
    poolKey: cfg.poolKey || "SUI_DBUSDC",
    balanceManagerId: cfg.balanceManagerId || "",
    depositSui: cfg.depositSui || "0",
    price: cfg.price || "1",
    quantity: cfg.quantity || "1",
    isBid: cfg.isBid === "true" ? "true" : "false",
    payWithDeep: cfg.payWithDeep === "true" ? "true" : "false",
    clientOrderId: "1",
  };
}

/** Merge server registry from GET /api/protocols (optional bootstrap). */
export function applyProtocolRegistry(registry: {
  cetus_swap?: Partial<(typeof TESTNET_MANIFEST)["cetus_swap"]> & { defaultPoolId?: string };
  haedal_stake?: Partial<(typeof TESTNET_MANIFEST)["haedal_stake"]>;
}) {
  if (registry.cetus_swap) {
    const { defaultPoolId, ...rest } = registry.cetus_swap;
    Object.assign(TESTNET_MANIFEST.cetus_swap, rest);
    if (defaultPoolId) TESTNET_MANIFEST.cetus_swap.defaultPoolId = defaultPoolId;
  }
  if (registry.haedal_stake) {
    Object.assign(TESTNET_MANIFEST.haedal_stake, registry.haedal_stake);
  }
}
