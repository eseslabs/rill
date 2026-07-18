import { describe, expect, it } from "vitest";
import { toDeclaration, type CapabilityManifest } from "../../../packages/rill-sdk/src";
import {
  RULE_KINDS,
  RULE_KIND_META,
  assetScopeRule,
  baseUnitsToDecimal,
  boundedByCaps,
  budgetRule,
  emptyManifest,
  listToText,
  msToDatetimeLocal,
  parseListInput,
  perTxRule,
  protocolScopeRule,
  rateLimitRule,
  recipientAllowlistRule,
  slippageFloorRule,
  timeWindowRule,
  validateManifest,
} from "@/lib/capabilities";

describe("amount builders route every SUI amount through decimalToBaseUnits", () => {
  it("budgetRule: 1.5 SUI -> 1500000000 mist", () => {
    expect(budgetRule("1.5")).toEqual({ kind: "budget", totalMist: "1500000000" });
  });

  it("perTxRule: 10 SUI -> 10000000000 mist", () => {
    expect(perTxRule("10")).toEqual({ kind: "per_tx", maxMist: "10000000000" });
  });

  it("slippageFloorRule: 0.99 SUI -> 990000000 mist", () => {
    expect(slippageFloorRule("0.99")).toEqual({ kind: "slippage_floor", minOutMist: "990000000" });
  });

  it("rateLimitRule: amount converts, windowMs passes through as a decimal ms string", () => {
    expect(rateLimitRule("2", "3600000")).toEqual({
      kind: "rate_limit",
      windowMs: "3600000",
      maxMist: "2000000000",
    });
  });

  it("rateLimitRule rejects a non-integer windowMs instead of silently truncating", () => {
    expect(() => rateLimitRule("1", "1.5")).toThrow();
  });

  it("amount builders reject invalid decimal input the same way decimalToBaseUnits does", () => {
    expect(() => budgetRule("")).toThrow();
    expect(() => budgetRule("-1")).toThrow();
    expect(() => budgetRule("1e10")).toThrow();
  });

  it("baseUnitsToDecimal is the exact inverse of the decimal->mist conversion", () => {
    expect(baseUnitsToDecimal("1500000000")).toBe("1.5");
    expect(baseUnitsToDecimal("10000000000")).toBe("10");
    expect(baseUnitsToDecimal(budgetRule("3.141592653").totalMist)).toBe("3.141592653");
  });
});

describe("list-based builders", () => {
  it("protocolScopeRule splits on commas and newlines and trims/drops empties", () => {
    const addr1 = `0x${"a".repeat(64)}`;
    const addr2 = `0x${"b".repeat(64)}`;
    expect(protocolScopeRule(`${addr1}, \n${addr2}\n\n`)).toEqual({
      kind: "protocol_scope",
      allowedPackages: [addr1, addr2],
    });
  });

  it("assetScopeRule and recipientAllowlistRule use the same list parser", () => {
    expect(assetScopeRule("0x2::sui::SUI,0x2::usdc::USDC")).toEqual({
      kind: "asset_scope",
      allowedCoinTypes: ["0x2::sui::SUI", "0x2::usdc::USDC"],
    });
    const addr = `0x${"c".repeat(64)}`;
    expect(recipientAllowlistRule(addr)).toEqual({
      kind: "recipient_allowlist",
      addresses: [addr],
    });
  });

  it("parseListInput / listToText round-trip a list", () => {
    const items = ["a", "b", "c"];
    expect(parseListInput(listToText(items))).toEqual(items);
  });

  it("an empty list produces an empty array (schema-invalid, not fabricated placeholders)", () => {
    expect(protocolScopeRule("   \n  ")).toEqual({ kind: "protocol_scope", allowedPackages: [] });
  });
});

describe("timeWindowRule", () => {
  it("converts two datetime-local strings to ms strings with notBefore < notAfter", () => {
    const rule = timeWindowRule("2026-01-01T00:00", "2026-01-02T00:00");
    expect(rule.kind).toBe("time_window");
    expect(BigInt(rule.notBeforeMs)).toBeLessThan(BigInt(rule.notAfterMs));
  });

  it("msToDatetimeLocal round-trips through timeWindowRule's own conversion", () => {
    const ms = "1735689600000"; // 2025-01-01T00:00:00Z
    const local = msToDatetimeLocal(ms);
    const rule = timeWindowRule(local, local);
    // Round-tripping through the browser's local timezone can shift by whole minutes only if the
    // input itself carries no seconds — same ms in, same ms out, since both conversions use the
    // same local-time interpretation.
    expect(rule.notBeforeMs).toBe(rule.notAfterMs);
  });

  it("rejects an empty or unparseable date string", () => {
    expect(() => timeWindowRule("", "2026-01-01T00:00")).toThrow();
    expect(() => timeWindowRule("not-a-date", "2026-01-01T00:00")).toThrow();
  });
});

describe("emptyManifest", () => {
  it("defaults walletCoinType to native SUI with zero rules", () => {
    expect(emptyManifest()).toEqual({ walletCoinType: "0x2::sui::SUI", rules: [] });
  });

  it("accepts a custom walletCoinType", () => {
    expect(emptyManifest("0x2::usdc::USDC").walletCoinType).toBe("0x2::usdc::USDC");
  });
});

describe("validateManifest", () => {
  it("rejects an empty manifest with the SDK's honest 'no restrictions' message (KTD-6)", () => {
    const result = validateManifest(emptyManifest());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("unsafe");
      expect(result.error).toContain("rules must not be empty");
    }
  });

  it("rejects duplicate rule kinds", () => {
    const manifest: CapabilityManifest = {
      walletCoinType: "0x2::sui::SUI",
      rules: [budgetRule("1"), budgetRule("2")],
    };
    const result = validateManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Duplicate rule kind");
  });

  it("accepts a manifest with one valid rule", () => {
    const manifest: CapabilityManifest = {
      walletCoinType: "0x2::sui::SUI",
      rules: [budgetRule("5")],
    };
    expect(validateManifest(manifest)).toEqual({ ok: true });
  });

  it("accepts a manifest exercising every rule kind, matching the backend's own preview fixture", () => {
    const manifest: CapabilityManifest = {
      walletCoinType: "0x2::sui::SUI",
      rules: [
        budgetRule("5"),
        perTxRule("1"),
        rateLimitRule("2", "3600000"),
        protocolScopeRule(`0x${"a".repeat(64)}`),
        slippageFloorRule("0.99"),
        assetScopeRule("0x2::sui::SUI"),
        recipientAllowlistRule(`0x${"b".repeat(64)}`),
        timeWindowRule("2026-01-01T00:00", "2026-01-02T00:00"),
      ],
    };
    expect(validateManifest(manifest)).toEqual({ ok: true });
    expect(manifest.rules).toHaveLength(RULE_KINDS.length);
  });
});

describe("RULE_KIND_META enforcement matches the SDK's own toDeclaration split", () => {
  const manifest: CapabilityManifest = {
    walletCoinType: "0x2::sui::SUI",
    rules: [
      { kind: "budget", totalMist: "5000000000" },
      { kind: "per_tx", maxMist: "1000000000" },
      { kind: "rate_limit", windowMs: "3600000", maxMist: "2000000000" },
      { kind: "protocol_scope", allowedPackages: [`0x${"a".repeat(64)}`] },
      { kind: "slippage_floor", minOutMist: "990000000" },
      { kind: "asset_scope", allowedCoinTypes: ["0x2::sui::SUI"] },
      { kind: "recipient_allowlist", addresses: [`0x${"b".repeat(64)}`] },
      { kind: "time_window", notBeforeMs: "1000", notAfterMs: "2000" },
    ],
  };

  it("covers every RULE_KINDS member exactly once", () => {
    expect(Object.keys(RULE_KIND_META).sort()).toEqual([...RULE_KINDS].sort());
  });

  it("every cap's enforcement in toDeclaration's output matches RULE_KIND_META for that rule kind", () => {
    const declaration = toDeclaration(manifest);
    expect(declaration.caps).toHaveLength(manifest.rules.length);
    manifest.rules.forEach((rule, i) => {
      expect(declaration.caps[i].enforcement).toBe(RULE_KIND_META[rule.kind].enforcement);
    });
  });

  it("on-chain kinds are exactly budget/per_tx/rate_limit/time_window", () => {
    const onChain = RULE_KINDS.filter((k) => RULE_KIND_META[k].enforcement === "on-chain").sort();
    expect(onChain).toEqual(["budget", "per_tx", "rate_limit", "time_window"].sort());
  });

  it("pre-flight kinds are exactly protocol_scope/slippage_floor/asset_scope/recipient_allowlist", () => {
    const preFlight = RULE_KINDS.filter(
      (k) => RULE_KIND_META[k].enforcement === "pre-flight",
    ).sort();
    expect(preFlight).toEqual(
      ["protocol_scope", "slippage_floor", "asset_scope", "recipient_allowlist"].sort(),
    );
  });
});

describe("boundedByCaps (Part B: action node 'Bounded by' panel filter)", () => {
  const manifest: CapabilityManifest = {
    walletCoinType: "0x2::sui::SUI",
    rules: [
      budgetRule("5"),
      protocolScopeRule(`0x${"a".repeat(64)}`),
      perTxRule("1"),
      slippageFloorRule("0.99"),
      rateLimitRule("2", "3600000"),
    ],
  };

  it("keeps only the on-chain spend caps (budget/per_tx/rate_limit) by default, in manifest order", () => {
    const caps = boundedByCaps(manifest);
    expect(caps.map((c) => c.label)).toEqual(["Budget", "Per-tx max", "Rate limit"]);
    expect(caps.every((c) => c.enforcement === "on-chain")).toBe(true);
  });

  it("also includes the pre-flight slippage floor when includeSlippageFloor is set, in manifest order", () => {
    const caps = boundedByCaps(manifest, { includeSlippageFloor: true });
    expect(caps.map((c) => c.label)).toEqual([
      "Budget",
      "Per-tx max",
      "Min swap output",
      "Rate limit",
    ]);
  });

  it("never includes a pre-flight cap other than slippage_floor, even with includeSlippageFloor set", () => {
    const withScope: CapabilityManifest = {
      walletCoinType: "0x2::sui::SUI",
      rules: [budgetRule("5"), protocolScopeRule(`0x${"a".repeat(64)}`)],
    };
    const caps = boundedByCaps(withScope, { includeSlippageFloor: true });
    expect(caps.map((c) => c.label)).toEqual(["Budget"]);
  });

  it("returns an empty array for a manifest with no spend caps (the node's empty-state hint)", () => {
    const noSpendCaps: CapabilityManifest = {
      walletCoinType: "0x2::sui::SUI",
      rules: [protocolScopeRule(`0x${"a".repeat(64)}`)],
    };
    expect(boundedByCaps(noSpendCaps)).toEqual([]);
    expect(boundedByCaps(emptyManifest())).toEqual([]);
  });
});
