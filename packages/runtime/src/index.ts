import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Source text of the browser runtime (IIFE), built to dist/runtime.global.js.
 * Engine injects this into composition pages before capture.
 */
export function getRuntimeSource(): string {
  return readFileSync(join(here, "runtime.global.js"), "utf8");
}

export const RUNTIME_FILENAME = "runtime.global.js";

/**
 * Vendored GSAP build served at /__fc-gsap.js. Sub-composition imports rewrite
 * CDN gsap script srcs to it so renders stay offline-deterministic.
 */
export function getGsapSource(): string {
  return readFileSync(join(here, "..", "vendor", "gsap.min.js"), "utf8");
}
