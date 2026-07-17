import { expect, test } from "bun:test";
import {
  TOKEN_DECIMALS,
  buildCetusSwapFlowConfig,
  buildHaedalStakeFlowConfig,
  toBaseUnits,
  toMist,
} from "./action-config";

// Base units are per coin, not universal. SUI has 9 decimals, USDC has 6. Scaling everything by
// 1e9 makes "1 USDC" compile to 1_000_000_000 base units — 1000 USDC. The swap is still floored
// (the backend derives min_amount_out from this same amount_in), so it is not unguarded; it is
// simply a swap of 1000x what the user asked for.

test("a SUI amount scales by 1e9", () => {
  expect(toBaseUnits("1", "0", TOKEN_DECIMALS.SUI)).toBe("1000000000");
});

test("a USDC amount scales by 1e6, not 1e9", () => {
  expect(toBaseUnits("1", "0", TOKEN_DECIMALS.USDC)).toBe("1000000");
});

test("toMist is SUI-only and stays 1e9", () => {
  expect(toMist("0.1", "0")).toBe("100000000");
  expect(toMist("1", "0")).toBe("1000000000");
});

test("an unparseable or non-positive amount falls back", () => {
  expect(toBaseUnits("", "42", 6)).toBe("42");
  expect(toBaseUnits("abc", "42", 6)).toBe("42");
  expect(toBaseUnits("0", "42", 6)).toBe("42");
  expect(toBaseUnits("-1", "42", 6)).toBe("42");
});

test("precision beyond the coin's decimals cannot inflate the amount", () => {
  // 6-decimal USDC cannot express 1.1234567; truncating is the only honest answer, and it can
  // only ever round the amount down.
  expect(toBaseUnits("1.1234567", "0", 6)).toBe("1123456");
});

test("an amount below the coin's smallest unit falls back rather than inventing one", () => {
  expect(toBaseUnits("0.0000001", "0", 6)).toBe("0");
});

test("scaling is exact integer math, not a float multiply", () => {
  // 0.07 * 1e9 is 70000000.00000001 in IEEE754. Anything that reaches a money value through a
  // float multiply is a rounding bug waiting for the right input.
  expect(toBaseUnits("0.07", "0", 9)).toBe("70000000");
  expect(toBaseUnits("4.35", "0", 9)).toBe("4350000000");
  expect(toBaseUnits("1.005", "0", 6)).toBe("1005000");
});

// --- The bug as it reaches the backend.

test("a USDC-in swap sends USDC base units, not mist", () => {
  const cfg = buildCetusSwapFlowConfig({
    tokenIn: "USDC",
    tokenOut: "SUI",
    amount: "1",
    slippage: "1.0",
  });
  expect(cfg.amount_in).toBe("1000000");
});

test("a SUI-in swap still sends mist", () => {
  const cfg = buildCetusSwapFlowConfig({
    tokenIn: "SUI",
    tokenOut: "USDC",
    amount: "1",
    slippage: "1.0",
  });
  expect(cfg.amount_in).toBe("1000000000");
});

test("the swap still carries owner policy and never a floor", () => {
  const cfg = buildCetusSwapFlowConfig({
    tokenIn: "USDC",
    tokenOut: "SUI",
    amount: "1",
    slippage: "1.0",
  });
  expect(cfg.slippageBps).toBe("100");
  expect(cfg).not.toHaveProperty("min_amount_out");
});

test("Haedal stakes SUI, so it keeps mist", () => {
  expect(buildHaedalStakeFlowConfig({ amount: "1" }).amount).toBe("1000000000");
});
