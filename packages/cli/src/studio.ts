import { resolve } from "node:path";
import { runHyperframesRebranded } from "./hf.js";

/**
 * `donova studio` — boot the HyperFrames Studio editor against an Donova
 * project. Donova projects already satisfy the HyperFrames composition
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

const DEFAULT_STUDIO_PORT = 3006;

export async function launchHyperframesStudio(
  projectDir: string,
  opts: StudioLaunchOptions = {},
): Promise<void> {
  const { rebrandStudioUi } = await import("./rebrand.js");
  rebrandStudioUi();
  // carry the CLI entry path into the detached sidecar so its children
  // (auto watcher, agent jobs) can respawn `donova` reliably.
  if (process.argv[1]) process.env.DONOVA_BIN = resolve(process.argv[1]);
  const port = opts.port || DEFAULT_STUDIO_PORT;
  const hfArgs = ["preview", projectDir];
  if (opts.stop) {
    hfArgs.push("--stop");
    const { annotatePort } = await import("./annotate.js");
    const { request } = await import("node:http");
    const r = request({
      host: "127.0.0.1",
      port: annotatePort(port),
      path: "/stop",
      method: "POST",
      timeout: 1500,
    });
    r.on("error", () => {});
    r.end();
  } else {
    hfArgs.push("--background", `--port=${port}`);
    if (opts.noOpen) hfArgs.push("--no-open");
  }
  const code = await runHyperframesRebranded(hfArgs);
  if (code !== 0) throw new Error(`hyperframes exited ${code}`);
  if (!opts.stop) {
    const { ensureAnnotateServer } = await import("./annotate.js");
    await ensureAnnotateServer(projectDir, port);
    // self-heal: auto was left on but the watcher died (sleep/reboot/kill)
    const { autoStatus, findWorkspace, setAutoEnabled } = await import("./watch.js");
    const st = await autoStatus();
    if (st.enabled && !st.running) {
      try {
        setAutoEnabled(true, st.workspace ?? findWorkspace(projectDir) ?? undefined, "studio-heal");
      } catch {}
    }
  }
}
