import type { BackendFunction } from "@/lib/rill-api";

/** Semantic role of a port, used for the node badge colors. */
export type PortRole =
  | "amount_in"
  | "amount_out"
  | "token_in"
  | "token_out"
  | "recipient"
  | "min_out"
  | "deadline"
  | "event"
  | "id";

export type Port = {
  key: string;
  label: string;
  /** Move type (e.g. `u64`, `address`, `0x2::coin::Coin<...>`) shown on the handle. */
  type: string;
  role?: PortRole;
};

export type DiscoveredFunction = {
  id: string;
  module: string;
  name: string;
  description: string;
  inputs: Port[];
  outputs: Port[];
  events: string[];
  color: "mint" | "peach" | "sky" | "lilac";
};

export type IntrospectionResult = {
  source: { kind: "package" | "tx" | "protocol"; value: string };
  protocol: string;
  packageId: string;
  functions: DiscoveredFunction[];
  /** 1 for real on-chain introspection (the backend reads the actual ABI). */
  confidence: number;
};

const COLORS = ["mint", "peach", "sky", "lilac"] as const;

function colorFor(key: string): DiscoveredFunction["color"] {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

/** Shorten a Move type for display: `0x…::coin::Coin<0x…::usdc::USDC>` → `Coin<USDC>`, `u64` → `u64`. */
function shortType(moveType: string): string {
  return moveType
    .replace(/0x[a-f0-9]+::/gi, "")
    .replace(/\s+/g, "")
    .slice(0, 48);
}

/**
 * Map the backend's real ABI introspection (`POST /introspect`) into the canvas display model.
 * The backend returns typed params (names are recovered where the ABI exposes them); outputs/events
 * aren't part of the normalized ABI, so they're left empty (no mock data).
 */
export function backendFunctionsToDiscovered(
  packageId: string,
  fns: BackendFunction[],
): IntrospectionResult {
  const functions: DiscoveredFunction[] = fns.map((f) => ({
    id: `${f.module}::${f.name}`,
    module: f.module,
    name: f.name,
    description: `${f.parameters.length} param${f.parameters.length === 1 ? "" : "s"}${f.isEntry ? " · entry" : ""}`,
    color: colorFor(`${f.module}::${f.name}`),
    inputs: f.parameters.map((p) => ({
      key: String(p.index),
      label: p.name ?? `arg${p.index}`,
      type: shortType(p.moveType),
    })),
    outputs: [],
    events: [],
  }));

  return {
    source: { kind: "package", value: packageId },
    protocol: `${packageId.slice(0, 6)}…${packageId.slice(-4)}`,
    packageId,
    functions,
    confidence: 1,
  };
}
