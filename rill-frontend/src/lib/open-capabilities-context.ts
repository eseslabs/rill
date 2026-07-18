import { createContext, useContext } from "react";

/**
 * Part A: on-chain agent_wallet caps (budget/per_tx/rate_limit/time_window/scope) are
 * WALLET-LEVEL, not per-action — so an action node no longer renders its own read-only cap list.
 * Instead it links straight to the Capabilities dialog ("bounded by your wallet Capabilities" on
 * the Cetus swap / Haedal stake node body, nodes.tsx). ReactFlow's custom nodes get no external
 * props (only `{ id, data, selected, ... }` from ReactFlow's own rendering machinery), so there is
 * no prop path from `routes/builder.tsx`'s `setCapabilitiesOpen` into an action node — this context
 * is that path, mirroring `manifest-context.ts`'s rationale exactly.
 *
 * Defaults to a no-op so a node rendered outside the provider (e.g. an isolated test) never throws.
 */
export const OpenCapabilitiesContext = createContext<() => void>(() => {});

export function useOpenCapabilities(): () => void {
  return useContext(OpenCapabilitiesContext);
}
