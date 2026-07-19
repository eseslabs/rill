import { fileURLToPath } from "node:url";
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
    resolve: {
      alias: {
        // @lobehub transitively pulls `shiki`, whose engine does a dynamic
        // `import("shiki/wasm")` → `onig.wasm`. rolldown's SSR build can't load
        // that binary (`builtin:vite-wasm-fallback` throws), which broke the
        // Vercel deploy. The pitch page only renders brand icons and never
        // highlights code, so alias that one wasm import to a stub — shiki's JS
        // still bundles normally; only the never-called wasm engine is stubbed.
        "shiki/wasm": fileURLToPath(new URL("./src/lib/shiki-wasm-stub.ts", import.meta.url)),
      },
    },
  },
  // Required for production deploy (Vercel). Lovable sandbox auto-enables nitro; local/Vercel need this.
  nitro: {
    preset: process.env.VERCEL ? "vercel" : "node-server",
  },
});
