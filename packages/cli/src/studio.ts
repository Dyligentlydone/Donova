import { runHyperframes } from "./hf.js";

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

export async function launchHyperframesStudio(
  projectDir: string,
  opts: StudioLaunchOptions = {},
): Promise<void> {
  const hfArgs = ["preview", projectDir];
  if (opts.stop) {
    hfArgs.push("--stop");
  } else {
    hfArgs.push("--background");
    if (opts.noOpen) hfArgs.push("--no-open");
    if (opts.port) hfArgs.push("--port", String(opts.port));
  }
  const code = await runHyperframes(hfArgs);
  if (code !== 0) throw new Error(`hyperframes exited ${code}`);
}
