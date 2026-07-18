import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * U12 (docs/plans/2026-07-17-001-fix-audit-hardening-plan.md): standalone Vitest config for the
 * pure-function test suite under `src/lib/`. Deliberately separate from `vite.config.ts` (which
 * wraps `@lovable.dev/vite-tanstack-config` and pulls in the full TanStack Start/SSR pipeline) —
 * the lib tests need only the `@/*` path alias, nothing else from that build.
 *
 * `environment: "node"` (not jsdom): every module under test in this suite is pure TypeScript with
 * no DOM dependency — `flow-mapper.ts`/`wire-inference.ts`/`action-config.ts`/`publish-gate.ts`/
 * `graph-hash.ts` only take type-only imports from React/ReactFlow/component files (erased at
 * build time), and `draft-storage.ts`'s `localStorage` calls are stubbed per-test instead of
 * pulling in jsdom for the whole run.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
