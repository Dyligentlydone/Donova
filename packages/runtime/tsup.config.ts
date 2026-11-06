import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    dts: true,
    clean: true,
  },
  {
    entry: { runtime: "src/browser.ts" },
    format: ["iife"],
    minify: false,
    dts: false,
    sourcemap: false,
  },
]);
