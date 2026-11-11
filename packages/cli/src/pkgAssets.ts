import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Resolve a shipped asset directory. Packaged layout puts assets at the
 * package root (<pkg>/registry); in the monorepo they live at repo root.
 * scripts/copy-assets.mjs also materializes the packaged layout in-repo,
 * so the packaged candidate wins in both cases once assets are copied.
 */
export function pkgAsset(rel: string): string {
  const candidates = [
    fileURLToPath(new URL(`../${rel}`, import.meta.url)), // packaged: <pkg>/<rel>
    fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), // repo: dist -> repo root
    fileURLToPath(new URL(`../../../../${rel}`, import.meta.url)), // repo from src/
  ];
  const found = candidates.find((p) => existsSync(p));
  if (found) return found;
  return fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
}
