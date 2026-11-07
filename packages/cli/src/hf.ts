import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Shared delegate to the bundled `hyperframes` CLI (Apache-2.0). Framecraft
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
