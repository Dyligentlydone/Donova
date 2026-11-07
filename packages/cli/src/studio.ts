import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * `framecraft studio` — boot the HyperFrames Studio editor against a Framecraft
 * project. Framecraft projects already satisfy the HyperFrames composition
 * contract (data-start/data-duration clips, sub-compositions, timed media), so
 * their studio-server edits our files natively.
 *
 * Telemetry is disabled for the child process; HeyGen-side features (desktop
 * handoff, cloud export, their agent) stay inert without HeyGen auth.
 */

export interface StudioLaunchOptions {
  port?: number;
  stop?: boolean;
  noOpen?: boolean;
}

function resolveHyperframesBin(): string {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req.resolve("hyperframes/package.json");
    return join(dirname(pkg), "bin", "hyperframes.mjs");
  } catch {
    return "hyperframes";
  }
}

export async function launchHyperframesStudio(
  projectDir: string,
  opts: StudioLaunchOptions = {},
): Promise<void> {
  const bin = resolveHyperframesBin();
  const viaNode = bin.endsWith(".mjs");
  const hfArgs = [...(viaNode ? [bin] : []), "preview", projectDir];
  if (opts.stop) {
    hfArgs.push("--stop");
  } else {
    hfArgs.push("--background");
    if (opts.noOpen) hfArgs.push("--no-open");
    if (opts.port) hfArgs.push("--port", String(opts.port));
  }
  const cmd = viaNode ? process.execPath : bin;
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(cmd, hfArgs, {
      stdio: "inherit",
      env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: "1", DO_NOT_TRACK: "1" },
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`hyperframes exited ${code}`)),
    );
  });
}
