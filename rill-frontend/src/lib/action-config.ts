/** Testnet protocol manifest — passed in full to backend on every compile/simulate. */

export const TESTNET_MANIFEST = {
  cetus_swap: {
    integratePackageId: "0xab2d58dd28ff0dc19b18ab2c634397b785a38c342a8f5065ade5f53f9dbffa1c",
    globalConfigId: "0xc6273f844b4bc258952c4e477697aa12c918c8e08106fac6b934811298c9820a",
    defaultPoolId: "0x2603c08065a848b719f5f465e40dbef485ec4fd9c967ebe83a7565269a74a2b2",
    /** Coin A of the curated pool (Pool<USDC, SUI>) — decides swap direction. Mirrors the backend registry. */
    coinTypeA:
      "0x14a71d857b34677a7d57e0feb303df1adb515a37780645ab763d42ce8d1a5e48::usdc::USDC",
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

export const DEEPBOOK_PAIRS = [
  { key: "SUI_DBUSDC", label: "SUI / DBUSDC" },
  { key: "SUI_USDC", label: "SUI / USDC" },
] as const;

export type DeepbookPairKey = (typeof DEEPBOOK_PAIRS)[number]["key"];

export type SwapTokenSymbol = (typeof SWAP_TOKENS)[number]["symbol"];

export const TOKEN_LOGOS: Record<SwapTokenSymbol, string> = {
  SUI: "https://raw.githubusercontent.com/MystenLabs/sui/refs/heads/main/docs/site/static/img/logo.svg",
  USDC: "https://cryptologos.cc/logos/usd-coin-usdc-logo.svg",
};

export const TOKEN_COIN_TYPE: Record<SwapTokenSymbol, string> = Object.fromEntries(
  SWAP_TOKENS.map((t) => [t.symbol, t.coinType]),
) as Record<SwapTokenSymbol, string>;

/** Raw base units per whole token. Cetus quotes in raw units, so display needs these to be honest. */
export const TOKEN_DECIMALS: Record<SwapTokenSymbol, number> = { SUI: 9, USDC: 6 };

/** Format a raw base-unit amount for display. Trims trailing zeros; never rounds up. */
export function formatRawAmount(raw: string, symbol: SwapTokenSymbol): string {
  const decimals = TOKEN_DECIMALS[symbol] ?? 9;
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * True when `tokenIn` is the pool's coin A. The curated pool is Pool<USDC, SUI>, so SUI → USDC is
 * b2a. Getting this backwards inverts the quote, which would show a confidently wrong price.
 */
export function isA2B(tokenIn: SwapTokenSymbol): boolean {
  return TOKEN_COIN_TYPE[tokenIn] === TESTNET_MANIFEST.cetus_swap.coinTypeA;
}

export type ActionConfig = Record<string, string>;

/** Slippage tolerance the swap node ships with, in percent. */
export const DEFAULT_SLIPPAGE_PCT = "1.0";
/** Beyond this a "floor" stops being one; the backend rejects anything at or above 100%. */
export const MAX_SLIPPAGE_PCT = 50;

/**
 * Percent → basis points for the on-chain floor.
 *
 * Unparseable input falls back to the default tolerance rather than to no tolerance. That is not a
 * permissive default: a *tight* floor can only cause a revert, while a missing one is the
 * `min_amount_out: "1"` bug — a swap that accepts any fill at all.
 */
export function toSlippageBps(percent: string): number {
  const n = parseFloat(percent);
  const fallback = Math.round(parseFloat(DEFAULT_SLIPPAGE_PCT) * 100);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.round(n * 100), MAX_SLIPPAGE_PCT * 100);
}

export function defaultActionConfig(protocolId: string, actionId: string): ActionConfig {
  if (protocolId === "cetus" && actionId === "swap") {
    return { tokenIn: "SUI", tokenOut: "USDC", amount: "0.1", slippage: DEFAULT_SLIPPAGE_PCT };
  }
  if (protocolId === "haedal" && actionId === "stake") {
    return { amount: "1" };
  }
  if (protocolId === "deepbook" && actionId === "limit_order") {
    return {
      poolKey: "SUI_DBUSDC",
      depositSui: "1.1",
      price: "1",
      quantity: "1",
      isBid: "false",
      payWithDeep: "false",
      // BalanceManager + TradeCap come from a wired Wallet node or from the agent at execution time.
      balanceManagerId: "",
      tradeCapId: "",
    };
  }
  return {};
}

/**
 * Human-readable token amount → raw base units.
 *
 * `decimals` is a property of the coin, not a constant: SUI has 9 and USDC has 6. Scaling every
 * amount by 1e9 turns "1 USDC" into 1_000_000_000 base units — a swap of 1000 USDC. Callers must
 * pass `TOKEN_DECIMALS[symbol]` for anything whose coin type isn't fixed at SUI.
 *
 * Scales by digit concatenation rather than `n * 10 ** decimals`, because that multiply is float
 * math on a money value (0.07 * 1e9 is 70000000.00000001 in IEEE754). `toFixed` with a few digits
 * of headroom normalizes exponent notation and absorbs float representation error (0.29 is really
 * 0.28999999999999998); the surplus digits are then cut, not rounded, so excess precision can only
 * move the amount down — never above what the user typed.
 */
export function toBaseUnits(amount: string, fallbackRaw: string, decimals: number): string {
  const n = parseFloat(amount);
  if (!Number.isFinite(n) || n <= 0) return fallbackRaw;

  const [whole, frac = ""] = n.toFixed(Math.min(decimals + 6, 100)).split(".");
  const raw = `${whole}${frac.slice(0, decimals)}`.replace(/^0+(?=\d)/, "");
  // Below the coin's smallest unit: there is no amount to send, so fall back rather than invent one.
  return raw === "0" ? fallbackRaw : raw;
}

/** SUI amount → mist. Mist is SUI's base unit; use `toBaseUnits` for any other coin. */
export function toMist(amount: string, fallbackMist: string): string {
  return toBaseUnits(amount, fallbackMist, TOKEN_DECIMALS.SUI);
}

export function otherSwapToken(symbol: SwapTokenSymbol): SwapTokenSymbol {
  return symbol === "SUI" ? "USDC" : "SUI";
}

/**
 * Build backend flow node config — FE owns protocol addresses, BE compiles from this payload.
 *
 * Carries `slippageBps` (the user's tolerance) and *not* `min_amount_out` (the floor). The backend
 * derives the floor from live pool state at compile time, so a flow published today still gets a
 * floor priced against today's pool when an agent runs it next week. A floor computed here would be
 * frozen at build time — stale, and stale in the unsafe direction once the price rises.
 */
export function buildCetusSwapFlowConfig(cfg: ActionConfig) {
  const tokenIn = (cfg.tokenIn as SwapTokenSymbol) || "SUI";
  const m = TESTNET_MANIFEST.cetus_swap;
  return {
    integratePackageId: m.integratePackageId,
    globalConfigId: m.globalConfigId,
    pool: m.defaultPoolId,
    inputCoinType: TOKEN_COIN_TYPE[tokenIn] ?? TOKEN_COIN_TYPE.SUI,
    outputCoinType: TOKEN_COIN_TYPE[otherSwapToken(tokenIn)],
    // Scaled by the *input* coin's decimals — a USDC-in swap is 1e6, not mist.
    amount_in: toBaseUnits(
      String(cfg.amount ?? "0.1"),
      "100000000",
      TOKEN_DECIMALS[tokenIn] ?? TOKEN_DECIMALS.SUI,
    ),
    slippageBps: String(toSlippageBps(String(cfg.slippage ?? DEFAULT_SLIPPAGE_PCT))),
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
    amount: toMist(String(cfg.amount ?? "1"), m.minStakeMist),
  };
}

/** Build backend config for a DeepBook limit order. BalanceManager must be funded (onboarding). */
export function buildDeepbookOrderFlowConfig(cfg: ActionConfig) {
  return {
    poolKey: cfg.poolKey || "SUI_DBUSDC",
    balanceManagerId: cfg.balanceManagerId || "",
    tradeCapId: cfg.tradeCapId || "",
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
