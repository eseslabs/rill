import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  server: {
    port: 5173,
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    server: { entry: "server" },
  },
  vite: {
    ssr: {
      // @lobehub/icons' ES build (and its transitive @lobehub/* deps, e.g.
      // fluent-emoji) re-export directories without an explicit index file —
      // Node's native ESM resolver used for externalized SSR deps can't resolve
      // that. Force Vite to bundle the whole scope through its own resolver instead.
      noExternal: [/^@lobehub\//],
    },
  },
  // Required for production deploy (Vercel). Lovable sandbox auto-enables nitro; local/Vercel need this.
  nitro: {
    preset: process.env.VERCEL ? "vercel" : "node-server",
  },
});
