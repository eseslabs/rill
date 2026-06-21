import type { Port } from "@/lib/rill-types";

/** Wire handles for curated library actions (matches backend edge targetHandle names). */
export function getActionPorts(
  protocolId: string,
  actionId: string,
): { inputs: Port[]; outputs: Port[] } | undefined {
  if (protocolId === "cetus" && actionId === "swap") {
    return {
      inputs: [{ key: "coin_inputs", label: "coin_in", type: "Coin", role: "token_in" }],
      outputs: [{ key: "coin_out", label: "coin_out", type: "Coin", role: "token_out" }],
    };
  }
  if (protocolId === "haedal" && actionId === "stake") {
    return {
      inputs: [{ key: "sui_coin", label: "sui_coin", type: "Coin", role: "token_in" }],
      outputs: [],
    };
  }
  if (protocolId === "deepbook" && actionId === "limit_order") {
    // Standalone — the order draws from the (pre-funded) BalanceManager, no coin wiring on canvas.
    return { inputs: [], outputs: [] };
  }
  return undefined;
}
