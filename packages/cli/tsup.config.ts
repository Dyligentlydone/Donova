import { defineConfig } from "tsup";

// The published `donova` package is self-contained: every @donova/*
// workspace package is inlined into dist so consumers only install real
// third-party npm dependencies (declared in package.json dependencies).
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  noExternal: [/^@donova\//],
});
