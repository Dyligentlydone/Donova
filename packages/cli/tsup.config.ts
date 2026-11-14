import { defineConfig } from "tsup";

// The published `donova` package is self-contained: every @donova/*
// workspace package is inlined into dist so consumers only install real
// third-party npm dependencies (declared in package.json dependencies).
export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    noExternal: [/^@donova\//],
  },
  {
    // parakeet.ts spawns this file via `join(dirname(import.meta.url),
    // "sherpaWorker.js")` — with @donova/media inlined, that path lands in
    // THIS dist, so the worker must be emitted here too. Without it every
    // transcribe dies with a bare "Cannot find module" + Node banner.
    // Separate pass: no dts (cross-package entry can't emit declarations)
    // and no clean (must not wipe the first build's output).
    entry: { sherpaWorker: "../media/src/sherpaWorker.ts" },
    format: ["esm"],
    dts: false,
    clean: false,
    noExternal: [/^@donova\//],
  },
]);
