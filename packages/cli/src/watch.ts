import { execSync, spawn } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { homedir, platform } from "node:os";
import { basename, extname, join, resolve } from "node:path";

/**
 * "auto donova" — watch <workspace>/02 Projects/raw footage/ and auto-edit
 * every new clip to the workspace style bible, landing the render in
 * donova videos/. Runs as a detached daemon (reboot-persistent via a
 * LaunchAgent on macOS), so it works without Studio open.
 *
 * Toggle: the Studio "auto" pill → POST /auto on the annotate sidecar →
 * setAutoEnabled() here. CLI: `donova watch [--stop|--status|--run]`.
 * State: ~/.donova/auto.json; log: ~/.donova/auto.log.
 */

const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".m4a", ".mp3", ".wav"]);
const PART_EXT = new Set([".part", ".crdownload", ".download", ".tmp"]);
const LAUNCHD_LABEL = "solutions.dyligent.donova-auto";

interface Processed {
  at: string;
  out?: string;
  error?: string;
}
interface AutoState {
  enabled?: boolean;
  seeded?: boolean;
  workspace?: string;
  pid?: number | null;
  processed?: Record<string, Processed>;
}

function stateDir(): string {
  const d = join(homedir(), ".donova");
  mkdirSync(d, { recursive: true });
  return d;
}
function statePath(): string {
  return join(stateDir(), "auto.json");
}
function logPath(): string {
  return join(stateDir(), "auto.log");
}
function readState(): AutoState {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8")) as AutoState;
  } catch {
    return {};
  }
}
function writeState(s: AutoState): void {
  writeFileSync(statePath(), `${JSON.stringify(s, null, 2)}\n`);
}
function log(msg: string): void {
  try {
    appendFileSync(logPath(), `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of the CLI entry (bin/donova.mjs) — used to respawn the daemon. */
function cliEntry(): string {
  const env = process.env.DONOVA_BIN;
  if (env) return env;
  const a = process.argv[1];
  return a && a.endsWith(".mjs") ? a : (a ?? "donova");
}

/** Find the "Donova Studio" workspace root by walking up from `from`. */
export function findWorkspace(from?: string): string | null {
  let d = resolve(from ?? process.cwd());
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(d, "01 Style Guide")) && existsSync(join(d, "02 Projects"))) return d;
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return readState().workspace ?? null;
}

export interface AutoStatus {
  enabled: boolean;
  running: boolean;
  workspace: string | null;
  pid: number | null;
  processed: Record<string, Processed>;
  agent: boolean;
}
export async function autoStatus(projectDir?: string): Promise<AutoStatus> {
  const s = readState();
  const running = Boolean(s.pid && alive(s.pid));
  let agent = false;
  if (projectDir) {
    try {
      const { resolveAgentSpec } = await import("./annotate.js");
      agent = Boolean(resolveAgentSpec(projectDir));
    } catch {}
  }
  return {
    enabled: Boolean(s.enabled),
    running,
    workspace: s.workspace ?? null,
    pid: s.pid ?? null,
    processed: s.processed ?? {},
    agent,
  };
}

function listClips(ws: string): string[] {
  const raw = join(ws, "02 Projects", "raw footage");
  try {
    return readdirSync(raw).filter(
      (f) =>
        !f.startsWith(".") &&
        VIDEO_EXT.has(extname(f).toLowerCase()) &&
        !PART_EXT.has(extname(f).toLowerCase()),
    );
  } catch {
    return [];
  }
}

// --- daemon lifecycle --------------------------------------------------------

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}
function installLaunchd(ws: string): void {
  if (platform() !== "darwin") return;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
 <key>Label</key><string>${LAUNCHD_LABEL}</string>
 <key>ProgramArguments</key><array>
  <string>${process.execPath}</string>
  <string>${cliEntry()}</string>
  <string>watch</string><string>--run</string>
  <string>--workspace</string><string>${ws}</string>
 </array>
 <key>RunAtLoad</key><true/>
 <key>KeepAlive</key><true/>
 <key>StandardOutPath</key><string>${logPath()}</string>
 <key>StandardErrorPath</key><string>${logPath()}</string>
</dict></plist>`;
  try {
    mkdirSync(dirname(plistPath()), { recursive: true });
    writeFileSync(plistPath(), plist);
    execSync(
      `launchctl bootstrap gui/$(id -u) ${JSON.stringify(plistPath())} 2>/dev/null || launchctl load ${JSON.stringify(plistPath())} 2>/dev/null || true`,
      { shell: "/bin/bash" },
    );
  } catch {}
}
function unloadLaunchd(): void {
  if (platform() !== "darwin") return;
  try {
    execSync(
      `launchctl bootout gui/$(id -u) ${JSON.stringify(plistPath())} 2>/dev/null || launchctl unload ${JSON.stringify(plistPath())} 2>/dev/null || true`,
      { shell: "/bin/bash" },
    );
  } catch {}
  try {
    unlinkSync(plistPath());
  } catch {}
}

function spawnDaemon(ws: string): void {
  const fd = openSync(logPath(), "a");
  const child = spawn(process.execPath, [cliEntry(), "watch", "--run", "--workspace", ws], {
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  const s = readState();
  s.pid = child.pid ?? null;
  writeState(s);
}

export function setAutoEnabled(on: boolean, workspace?: string, via = "cli"): AutoStatus {
  const s = readState();
  if (on) {
    const ws = workspace ?? findWorkspace();
    if (!ws)
      throw new Error(
        "no Donova Studio workspace found — run this inside it or pass --workspace",
      );
    s.enabled = true;
    s.workspace = ws;
    s.processed = s.processed ?? {};
    // first enable only: clips already in the pool are marked seen, not
    // batch-processed. Anything dropped after this point is processed.
    if (!s.seeded) {
      for (const f of listClips(ws)) {
        s.processed[f] = { at: new Date().toISOString(), out: "(present before auto)" };
      }
      s.seeded = true;
    }
    writeState(s);
    // On macOS, launchd owns the spawn (reboot persistence + KeepAlive revival).
    // Spawning a manual copy alongside would create a permanent dup→exit→
    // respawn loop, so the manual spawn is a deferred fallback only.
    if (platform() === "darwin") {
      installLaunchd(ws);
      setTimeout(() => {
        const c = readState();
        if (c.enabled && (!c.pid || !alive(c.pid))) spawnDaemon(ws);
      }, 1500).unref();
    } else if (!s.pid || !alive(s.pid)) {
      spawnDaemon(ws);
    }
    log(`auto enabled via ${via} — watching ${join(ws, "02 Projects", "raw footage")}`);
  } else {
    s.enabled = false;
    writeState(s);
    unloadLaunchd();
    if (s.pid && alive(s.pid)) {
      try {
        process.kill(s.pid);
      } catch {}
    }
    s.pid = null;
    writeState(s);
    log(`auto disabled via ${via}`);
  }
  const running = Boolean(s.pid && alive(s.pid));
  return {
    enabled: Boolean(s.enabled),
    running,
    workspace: s.workspace ?? null,
    pid: s.pid ?? null,
    processed: s.processed ?? {},
    agent: false,
  };
}

// --- the watcher loop (donova watch --run) ------------------------------------

function notify(title: string, msg: string): void {
  log(`notify: ${msg}`);
  if (platform() !== "darwin") return;
  try {
    execSync(
      `osascript -e ${JSON.stringify(`display notification ${JSON.stringify(msg)} with title ${JSON.stringify(title)}`)}`,
      { stdio: "ignore" },
    );
  } catch {}
}

function slugOf(file: string): string {
  return (
    basename(file, extname(file))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "clip"
  );
}

async function processClip(ws: string, file: string): Promise<void> {
  const projectsDir = join(ws, "02 Projects");
  const rawFile = join(projectsDir, "raw footage", file);
  const slug = slugOf(file);
  const projDir = join(projectsDir, slug);
  const st = readState();
  st.processed = st.processed ?? {};
  const mark = (p: Processed) => {
    const cur = readState();
    cur.processed = cur.processed ?? {};
    cur.processed[file] = p;
    writeState(cur);
  };
  notify("auto donova", `editing ${file}…`);

  if (!existsSync(projDir)) {
    const { initProject } = await import("./init.js");
    await initProject(projDir, { name: slug });
  }
  // Link the clip into the project — hardlink = real file, zero copies.
  const assetsDir = join(projDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  const linked = join(assetsDir, file);
  if (!existsSync(linked)) {
    try {
      linkSync(rawFile, linked);
    } catch {
      copyFileSync(rawFile, linked);
    }
  }
  // Neutral footage comp if the project doesn't have one yet.
  if (!existsSync(join(projDir, "index.html"))) {
    const { scaffoldCmd } = await import("./scaffold.js");
    await scaffoldCmd({ media: linked, dir: projDir, out: "index.html" });
  }

  const { resolveAgentSpec, runAgentJob } = await import("./annotate.js");
  const spec = resolveAgentSpec(projDir);
  if (!spec) {
    mark({ at: new Date().toISOString(), error: "no agent configured" });
    notify("auto donova", "no agent — connect one in Studio chat, then re-drop the clip");
    return;
  }
  const prompt = [
    `You are the auto-editor for the Donova Studio workspace. This project is ${projDir}.`,
    `A raw clip was dropped in the shared pool ("../raw footage/${file}") — it's linked into this project at "assets/${file}" and scaffolded into index.html.`,
    "",
    'Read the style bible at "../../01 Style Guide/style.md" first. If it is thin and',
    '"../../01 Style Guide/inspo/" has reference clips/screenshots, analyze those to',
    "refine the bible before editing.",
    "",
    "Edit the composition to the style — pacing, cuts, captions, color, motion,",
    "whatever the bible calls for. Then render the finished video into the shared pool:",
    `  donova render --out "../donova videos/${slug}.mp4"`,
    "",
    "Contract: timed elements carry data-start + data-duration (+ class=\"clip\");",
    'one paused GSAP root timeline on window.__timelines["main"]; deterministic only.',
    "Report concisely what you did.",
  ].join("\n");
  const code = await runAgentJob(projDir, spec, prompt, (line) => log(`[${slug}] ${line.trimEnd()}`));
  if (code === 0) {
    const out = join("..", "donova videos", `${slug}.mp4`);
    mark({ at: new Date().toISOString(), out });
    notify("auto donova", `${file} → donova videos/${slug}.mp4`);
  } else {
    mark({ at: new Date().toISOString(), error: `agent exited ${code}` });
    notify("auto donova", `${file} — edit failed (see ~/.donova/auto.log)`);
  }
}

/** The daemon loop. Single-instance-guarded; exits when disabled. */
export async function runWatch(workspaceArg?: string): Promise<void> {
  const ws = workspaceArg ? resolve(workspaceArg) : findWorkspace();
  if (!ws) {
    console.error("no Donova Studio workspace found");
    process.exit(1);
  }
  const st = readState();
  if (st.pid && st.pid !== process.pid && alive(st.pid)) {
    log(`already running (pid ${st.pid}) — exiting`);
    return;
  }
  st.pid = process.pid;
  writeState(st);
  const rawDir = join(ws, "02 Projects", "raw footage");
  log(`watching ${rawDir} (pid ${process.pid})`);
  const sizes = new Map<string, number[]>();
  const busy = new Set<string>();
  const queue: string[] = [];
  let draining = false;
  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const f = queue.shift() as string;
        try {
          await processClip(ws as string, f);
        } catch (e) {
          log(`process ${f} failed: ${String(e).slice(0, 400)}`);
        }
        busy.delete(f);
      }
    } finally {
      draining = false;
    }
  }
  setInterval(() => {
    const s = readState();
    if (!s.enabled) {
      log("disabled — exiting");
      process.exit(0);
    }
    for (const f of listClips(ws as string)) {
      if (busy.has(f)) continue;
      if (s.processed?.[f]) continue;
      let size = 0;
      try {
        size = statSync(join(rawDir, f)).size;
      } catch {
        continue;
      }
      const hist = sizes.get(f) ?? [];
      hist.push(size);
      if (hist.length > 2) hist.shift();
      sizes.set(f, hist);
      // settle: two identical non-zero size reads ~10s apart → copy finished
      if (hist.length < 2 || hist[0] !== hist[1] || size === 0) continue;
      busy.add(f);
      queue.push(f);
      log(`settled: ${f} (${(size / 1e6).toFixed(1)} MB)`);
      void drain();
    }
  }, 5000);
  await new Promise(() => {});
}
