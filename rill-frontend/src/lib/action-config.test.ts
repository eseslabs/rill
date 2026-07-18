import { describe, expect, it } from "vitest";
import {
  actionAmountError,
  buildCetusSwapFlowConfig,
  buildHaedalStakeFlowConfig,
  isValidActionAmount,
  parseActionAmount,
  TOKEN_COIN_TYPE,
} from "@/lib/action-config";

const USDC = TOKEN_COIN_TYPE.USDC; // Cetus testnet USDC — 6 decimals in the SDK token registry.
const SUI = TOKEN_COIN_TYPE.SUI; // 9 decimals.

describe("decimal -> base-units conversion, using each coin's real decimals (R5 headline fix)", () => {
  it("Cetus swap's fixed 0.1 preview amount converts in the input token's own decimals", () => {
    // 0.1 USDC @ 6 decimals -> 100000 base units, not the old 9-decimal fallback.
    const usdcCfg = buildCetusSwapFlowConfig({ tokenIn: "USDC", tokenOut: "SUI" });
    expect(usdcCfg.amount_in).toBe("100000");

    // 0.1 SUI @ 9 decimals -> 100000000 base units.
    const suiCfg = buildCetusSwapFlowConfig({ tokenIn: "SUI", tokenOut: "USDC" });
    expect(suiCfg.amount_in).toBe("100000000");
  });

  it("Haedal stake's fixed 1 SUI preview amount -> 1000000000 base units", () => {
    const cfg = buildHaedalStakeFlowConfig({});
    expect(cfg.amount).toBe("1000000000");
  });

  it("SUI's 9-decimal path is unchanged for a fractional amount", () => {
    const result = parseActionAmount("1.123456789", SUI);
    expect(result).toEqual({ ok: true, baseUnits: 1123456789n });
  });
});

describe("Part B: build*FlowConfig ignore cfg.amount — the agent supplies the real amount at runtime", () => {
  it("buildCetusSwapFlowConfig always compiles the fixed 0.1 preview amount, regardless of cfg.amount", () => {
    const cfg = buildCetusSwapFlowConfig({ tokenIn: "USDC", tokenOut: "SUI", amount: "999" });
    expect(cfg.amount_in).toBe("100000"); // 0.1 USDC, not 999
  });

  it("buildHaedalStakeFlowConfig always compiles the fixed 1 SUI preview amount, regardless of cfg.amount", () => {
    const cfg = buildHaedalStakeFlowConfig({ amount: "999" });
    expect(cfg.amount).toBe("1000000000"); // 1 SUI, not 999
  });
});

describe("invalid amounts are rejected, never silently defaulted", () => {
  const cases: Array<[label: string, amount: string]> = [
    ["zero", "0"],
    ["non-numeric", "abc"],
    ["negative", "-1"],
    ["over-precision for a 6dp coin", "1.1234567"],
  ];

  for (const [label, amount] of cases) {
    it(`"${amount}" (${label}) is invalid`, () => {
      expect(isValidActionAmount(amount, USDC)).toBe(false);
      expect(actionAmountError(amount, USDC)).not.toBeNull();
      expect(parseActionAmount(amount, USDC).ok).toBe(false);
    });
  }

  it("empty string is invalid with a distinct required-field message", () => {
    expect(isValidActionAmount("", USDC)).toBe(false);
    expect(actionAmountError("", USDC)).toBe("Amount is required.");
  });
});
