import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Copies the browser runtime + vendored GSAP into public/ so they serve at
// /__fc-runtime.js and /__fc-gsap.js like the local Studio server. These are
// build artifacts — keeping them static avoids a route-handler round trip per
// preview reload. Run before `next build` / `next dev`.
const here = dirname(fileURLToPath(import.meta.url));
const runtimeDir = join(here, "..", "..", "..", "packages", "runtime");
const pub = join(here, "..", "public");
mkdirSync(pub, { recursive: true });
copyFileSync(join(runtimeDir, "dist", "runtime.global.js"), join(pub, "__fc-runtime.js"));
copyFileSync(join(runtimeDir, "vendor", "gsap.min.js"), join(pub, "__fc-gsap.js"));
console.log("synced __fc-runtime.js + __fc-gsap.js into public/");
