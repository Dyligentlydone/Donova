// Copies runtime assets into packages/cli so the published tarball is
// self-contained. Everything here is generated — nothing in this list is
// committed to git (see .gitignore).
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(pkgRoot, "..", "..");

const copies = [
  // src -> dest (relative to repo root / package root)
  ["skills", "skills"],
  ["registry", "registry"],
  ["packages/studio-server/src/ui", "ui"],
  ["packages/runtime/vendor", "vendor"],
  ["LICENSE-hyperframes", "LICENSE-hyperframes"],
];

for (const [from, to] of copies) {
  cpSync(join(repoRoot, from), join(pkgRoot, to), { recursive: true });
}

// runtime.global.js is read via import.meta.url at runtime — it must sit
// next to the bundled output in dist/.
mkdirSync(join(pkgRoot, "dist"), { recursive: true });
cpSync(
  join(repoRoot, "packages/runtime/dist/runtime.global.js"),
  join(pkgRoot, "dist/runtime.global.js"),
);

console.log(`copied ${copies.length + 1} asset sets into packages/cli`);
