import { createContext, useContext } from "react";
import { emptyManifest, type CapabilityManifest } from "@/lib/capabilities";

/**
 * Part B: React-Flow custom nodes (nodes.tsx) get no external props — ReactFlow only ever passes
 * `{ id, data, selected, ... }` down from its own internal node-rendering machinery, so there is no
 * prop path from `routes/builder.tsx`'s `manifest` state into an action node. This context is that
 * path: `Builder` provides the live `CapabilityManifest` once, wrapping `<ReactFlow>`; `ActionNode`
 * reads it via {@link useManifest} to render its read-only "Bounded by" panel (the on-chain spend
 * caps currently in force), without threading a `manifest` prop through ReactFlow itself.
 *
 * Defaults to `emptyManifest()` so a node rendered outside the provider (e.g. a future isolated
 * unit test) degrades to "no caps" rather than throwing.
 */
export const ManifestContext = createContext<CapabilityManifest>(emptyManifest());

export function useManifest(): CapabilityManifest {
  return useContext(ManifestContext);
}
