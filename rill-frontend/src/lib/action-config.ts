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

/** Convert human-readable token amount to mist string. */
export function toMist(amount: string, fallbackMist: string): string {
  const n = parseFloat(amount);
  if (!Number.isFinite(n) || n <= 0) return fallbackMist;
  return String(Math.round(n * 1e9));
}

export function otherSwapToken(symbol: SwapTokenSymbol): SwapTokenSymbol {
  return symbol === "SUI" ? "USDC" : "SUI";
}

/** Build backend flow node config — FE owns protocol addresses, BE compiles from this payload. */
export function buildCetusSwapFlowConfig(cfg: ActionConfig) {
  const tokenIn = (cfg.tokenIn as SwapTokenSymbol) || "SUI";
  const m = TESTNET_MANIFEST.cetus_swap;
  return {
    integratePackageId: m.integratePackageId,
    globalConfigId: m.globalConfigId,
    pool: m.defaultPoolId,
    inputCoinType: TOKEN_COIN_TYPE[tokenIn] ?? TOKEN_COIN_TYPE.SUI,
    outputCoinType: TOKEN_COIN_TYPE[otherSwapToken(tokenIn)],
    amount_in: toMist(String(cfg.amount ?? "0.1"), "100000000"),
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
    amount: toMist(String(cfg.amount ?? "1"), m.minStakeMist),
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
