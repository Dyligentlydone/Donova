import { defineConfig } from "vitest/config";

/**
 * Golden tests render real video through Chrome + FFmpeg (MV0.3).
 * Slower than unit tests — run via `pnpm test:golden`.
 */
export default defineConfig({
  test: {
    include: ["tests/golden/**/*.test.ts"],
    exclude: ["_analysis/**", "node_modules/**", "**/dist/**"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
