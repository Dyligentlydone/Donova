import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    exclude: ["_analysis/**", "node_modules/**", "**/dist/**"],
  },
});
