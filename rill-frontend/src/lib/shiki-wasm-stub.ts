// Stub for `shiki/wasm` — @lobehub/icons transitively pulls shiki, but the pitch
// page only renders brand icons and never highlights code, so the oniguruma WASM
// engine is never instantiated. Aliasing the dynamic `import("shiki/wasm")` here
// keeps rolldown from trying to bundle shiki's onig.wasm (which breaks the SSR
// build / Vercel deploy). If shiki ever DID run, this would throw loudly rather
// than silently mis-highlight.
export default function () {
  throw new Error("shiki/wasm is stubbed out in this build (highlighter unused).");
}
