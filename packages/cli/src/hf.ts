import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Shared delegate to the bundled `hyperframes` CLI (Apache-2.0). Donova
 * projects satisfy the HyperFrames composition contract, so their local
 * tooling (check/timeline/beats/audio/capture/diff/measure/…) runs on our
 * projects natively. Telemetry is disabled for the child process; HeyGen
 * account/cloud surfaces stay inert without HeyGen auth.
 */

export function resolveHyperframesBin(): string {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req.resolve("hyperframes/package.json");
    return join(dirname(pkg), "bin", "hyperframes.mjs");
  } catch {
    return "hyperframes";
  }
}

/**
 * Run `hyperframes <args>` as a passthrough: stdio inherited, telemetry off,
 * and the child's exit code lands on `process.exitCode` so gates and usage
 * errors propagate (0 success / 1 failed / 2 bad args) instead of throwing.
 */
export function runHyperframes(args: string[], cwd?: string): Promise<number> {
  const bin = resolveHyperframesBin();
  const viaNode = bin.endsWith(".mjs");
  const cmd = viaNode ? process.execPath : bin;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, viaNode ? [bin, ...args] : args, {
      stdio: "inherit",
      cwd,
      env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: "1", DO_NOT_TRACK: "1" },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code != null && code !== 0) process.exitCode = code;
      resolvePromise(code ?? 1);
    });
  });
}

/**
 * Studio-launch variant: buffers the child's banner, rewrites user-facing
 * brand strings to Donova, then flushes. Real filesystem paths and URLs
 * (e.g. ~/.local/state/hyperframes/...) are left untouched — they are true
 * facts about where upstream keeps state, and faking them would break
 * anyone following the printed path.
 */
export function runHyperframesRebranded(args: string[], cwd?: string): Promise<number> {
  const bin = resolveHyperframesBin();
  const viaNode = bin.endsWith(".mjs");
  const cmd = viaNode ? process.execPath : bin;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, viaNode ? [bin, ...args] : args, {
      stdio: ["inherit", "pipe", "pipe"],
      cwd,
      env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: "1", DO_NOT_TRACK: "1" },
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => {
      out += d;
    });
    child.stderr?.on("data", (d) => {
      err += d;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      process.stdout.write(rebrandBanner(out));
      process.stderr.write(err);
      if (code != null && code !== 0) process.exitCode = code;
      resolvePromise(code ?? 1);
    });
  });
}

function rebrandBanner(s: string): string {
  return s
    .replace(/hyperframes preview/gi, "Donova Studio")
    .replace(/HyperFrames(?!\.|\/)/g, "Donova")
    .replace(/hyperframes(?!\.|\/)/g, "donova");
}
