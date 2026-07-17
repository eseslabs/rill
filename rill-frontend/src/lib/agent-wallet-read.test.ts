import { expect, test } from "bun:test";
import {
  extractWalletFields,
  toEnforcedBounds,
  toSlippageFloorRow,
  type RawAgentWallet,
} from "./agent-wallet-read";

// A wallet that is live: expiry well in the future, budget left, not revoked.
const raw: RawAgentWallet = {
  per_tx_max: "50000000000",
  spent: "1100000000",
  budget: "3900000000",
  expires_at_ms: "4102444800000", // 2100-01-01
  revoked: false,
  allowed_packages: ["0xdeadbeef"],
};

const NOW = 1_752_710_400_000; // 2026-07-17T00:00:00Z

// ── amounts ──

test("per-tx ceiling and remaining budget are reported in SUI from MIST", () => {
  const b = toEnforcedBounds(raw, NOW);
  expect(b.perTxMaxSui).toBe("50.000");
  expect(b.remainingSui).toBe("3.900");
});

test("remaining comes from the budget balance, not from per_tx_max - spent", () => {
  // per_tx_max - spent would be 48.900 SUI, which is not what agent_wallet::spend checks.
  // spend() asserts amount <= budget.value(), so budget is the only honest remaining.
  const b = toEnforcedBounds({ ...raw, budget: "250000000" }, NOW);
  expect(b.remainingSui).toBe("0.250");
});

test("a Balance field that arrives as a nested struct is read, not rejected", () => {
  // Sui flattens 0x2::balance::Balance to its u64, but older/other RPC shapes nest it.
  expect(toEnforcedBounds({ ...raw, budget: { value: "3900000000" } }, NOW).remainingSui).toBe(
    "3.900",
  );
  expect(
    toEnforcedBounds({ ...raw, budget: { fields: { value: "700000000" } } }, NOW).remainingSui,
  ).toBe("0.700");
});

test("MIST is never rendered through a float — a sub-MIST remainder truncates, never rounds up", () => {
  expect(toEnforcedBounds({ ...raw, budget: "1999999999" }, NOW).remainingSui).toBe("1.999");
});

// ── expiry: agent_wallet.move asserts `clock.timestamp_ms() < expires_at_ms` ──

test("a zero expiry reads as expired — the Move asserts now < expires_at_ms, so 0 aborts every spend", () => {
  const b = toEnforcedBounds({ ...raw, expires_at_ms: "0" }, NOW);
  expect(b.status).toBe("EXPIRED");
  expect(b.expiry).toMatch(/expired/i);
  expect(b.expiry).not.toMatch(/no expiry/i);
});

test("a past expiry is expired", () => {
  expect(toEnforcedBounds({ ...raw, expires_at_ms: String(NOW - 1) }, NOW).status).toBe("EXPIRED");
});

test("a future expiry is active and shows the timestamp", () => {
  const b = toEnforcedBounds(raw, NOW);
  expect(b.status).toBe("ACTIVE");
  expect(b.expiry).toMatch(/2100/);
});

// ── revocation ──

test("a revoked wallet is reported as revoked", () => {
  expect(toEnforcedBounds({ ...raw, revoked: true }, NOW).status).toBe("REVOKED");
});

test("revocation outranks expiry — spend checks revoked first (code 2 before code 3)", () => {
  expect(toEnforcedBounds({ ...raw, revoked: true, expires_at_ms: "0" }, NOW).status).toBe(
    "REVOKED",
  );
});

// ── protocol scope: the honesty requirement ──

test("protocol scope is labelled as recorded, not enforced", () => {
  // agent_wallet.move records allowed_packages but Move cannot intercept a released
  // coin's destination — the panel must not claim otherwise.
  expect(toEnforcedBounds(raw, NOW).scopeEnforcement).toMatch(/not enforced on-chain/i);
});

test("the protocol scope row is the only row not enforced on-chain", () => {
  const b = toEnforcedBounds(raw, NOW);
  const offChain = b.rows.filter((r) => r.enforcement === "off-chain");
  expect(offChain).toHaveLength(1);
  expect(offChain[0]!.label).toMatch(/protocol scope/i);
});

test("every on-chain row names the abort code agent_wallet::spend raises", () => {
  const codes = Object.fromEntries(
    toEnforcedBounds(raw, NOW)
      .rows.filter((r) => r.enforcement === "on-chain")
      .map((r) => [r.label, r.enforcedBy]),
  );
  expect(codes["Per-transaction ceiling"]).toMatch(/code 4/); // E_OVER_PER_TX
  expect(codes["Budget remaining"]).toMatch(/code 5/); // E_OVER_BUDGET
  expect(codes["Expiry"]).toMatch(/code 3/); // E_EXPIRED
  expect(codes["Status"]).toMatch(/code 2/); // E_REVOKED
});

test("an empty allowed_packages vector is reported as recording no restriction at all", () => {
  const b = toEnforcedBounds({ ...raw, allowed_packages: [] }, NOW);
  expect(b.scope).toEqual([]);
  expect(b.scopeValue).toMatch(/no packages recorded/i);
});

// ── empty state ──

test("an unbound wallet reports that nothing is enforced", () => {
  expect(toEnforcedBounds(null, NOW).status).toMatch(/no agent wallet bound/i);
});

test("an unbound wallet has no rows to claim anything with", () => {
  const b = toEnforcedBounds(null, NOW);
  expect(b.bound).toBe(false);
  expect(b.rows).toEqual([]);
});

// ── slippage floor (flow-derived, not wallet-derived) ──

test("a configured slippage floor is enforced on-chain by rill_guard", () => {
  const row = toSlippageFloorRow("990000000");
  expect(row.value).toBe("0.990 SUI");
  expect(row.enforcement).toBe("on-chain");
  expect(row.enforcedBy).toMatch(/assert_min_value/);
});

test("no floor configured is reported as enforcing nothing, not as safe", () => {
  const row = toSlippageFloorRow(null);
  expect(row.enforcement).toBe("none");
  expect(row.value).toMatch(/no floor/i);
});

test("a zero floor enforces nothing — a guard asserting >= 0 is not a guard", () => {
  expect(toSlippageFloorRow("0").enforcement).toBe("none");
});

// ── object extraction ──

test("a live AgentWallet object yields its fields", () => {
  const fields = extractWalletFields({
    data: { content: { dataType: "moveObject", fields: raw } },
  });
  expect(fields?.per_tx_max).toBe("50000000000");
});

test("a missing or non-Move object yields null rather than a fabricated wallet", () => {
  expect(extractWalletFields(null)).toBeNull();
  expect(extractWalletFields({ error: { code: "notExists" } })).toBeNull();
  expect(extractWalletFields({ data: { content: { dataType: "package" } } })).toBeNull();
});
