import { execSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { get } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Annotation sidecar — receives "draw on the frame" marks from the Studio
 * overlay and writes them into the project for the agent to consume, and
 * bridges Studio chat to a locally configured agent CLI.
 *
 * `donova studio` launches hyperframes' own preview server, whose routes we can't
 * extend, so this runs as a tiny detached server on studioPort+1000 bound to
 * localhost.
 *
 * Routes:
 *   GET  /health                    sidecar liveness + projectDir
 *   POST /annotate                  persist annotations/*.json + *.png
 *   GET  /agent/health              { agent: bool, name, cmd } — bridge configured?
 *   GET  /agent/list                known agents + detected/setup state (chat picker)
 *   POST /agent/select {name}       switch the active agent (persists to donova.json)
 *   POST /agent/setup {name,key?,url?,model?}  configure an API provider (~/.donova/agents.json)
 *   POST /agent/chat {message, annotation?} → { jobId } (503 when no bridge)
 *   GET  /agent/jobs/:id/stream     SSE of the agent run
 *   POST /stop                      shutdown
 *
 * Agent resolution (first hit wins):
 *   1. POST /agent/select session override
 *   2. donova.json "agent":  "auto" | "<preset>" | { cmd } | { url, model }
 *   3. env: DONOVA_AGENT (preset name or raw cmd) → DONOVA_AGENT_CMD (raw cmd)
 *      — legacy FC_* env vars still honored
 *   4. first preset whose binary is on PATH (claude, codex, gemini, …)
 *
 * `{prompt}` in a cmd substitutes the prompt as an arg; otherwise the prompt is
 * written to the process's stdin. `{ url, model }` (or an API preset selected in
 * the chat picker) targets any OpenAI-compatible /chat/completions endpoint —
 * Ollama, LM Studio, OpenRouter, OpenAI, … — and runs a tool-call loop so it can
 * edit files like a CLI agent. Contract: plan/19-ANNOTATE.md.
 */

const SIDECAR_PORT_OFFSET = 1000;
const SIDECAR_VERSION = 5;

/**
 * Cloud mode (hosted Studio): DONOVA_CLOUD=1 pins the agent to the
 * service-configured endpoint — donova.json's `agent`, /agent/setup and
 * /agent/select are ignored so no user input can point the bridge at an
 * arbitrary cmd (shell exec in a shared container) or a stored key shared
 * across instances. /auto and /stop are disabled too.
 */
const CLOUD = Boolean(process.env.DONOVA_CLOUD ?? process.env.EDITNCE_CLOUD ?? process.env.FC_CLOUD);

export function annotatePort(studioPort: number): number {
  return studioPort + SIDECAR_PORT_OFFSET;
}

interface AnnotationBody {
  t?: number | null;
  comp?: { w: number; h: number };
  marks?: unknown[];
  note?: string;
  png?: string; // dataURL
}

interface ChatBody {
  message?: string;
  annotation?: string; // annotations/xxx.json filename
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "note"
  );
}

// --- agent bridge -----------------------------------------------------------

export interface AgentSpec {
  name: string; // preset key, "custom", or "endpoint"
  label: string;
  kind: "cli" | "http";
  cmd?: string; // cli — {prompt} substitutes as arg, else stdin
  url?: string; // http — OpenAI-compatible /chat/completions endpoint
  model?: string;
  key?: string; // resolved bearer token (never returned to clients)
  keyEnv?: string; // env var holding a bearer key (never stored)
  edits: boolean; // can it modify project files?
}

/** Headless commands for known agent CLIs. Each takes the prompt via stdin or a {prompt} arg. */
const AGENT_PRESETS: { name: string; label: string; bin: string; cmd: string; install?: string }[] = [
  {
    name: "claude",
    label: "Claude Code",
    bin: "claude",
    cmd: "claude -p --dangerously-skip-permissions",
    install: "npm i -g @anthropic-ai/claude-code",
  },
  {
    name: "codex",
    label: "Codex (OpenAI)",
    bin: "codex",
    cmd: 'codex exec --dangerously-bypass-approvals-and-sandbox "{prompt}"',
    install: "npm i -g @openai/codex",
  },
  {
    name: "gemini",
    label: "Gemini CLI",
    bin: "gemini",
    cmd: 'gemini --yolo -p "{prompt}"',
    install: "npm i -g @google/gemini-cli",
  },
  {
    name: "opencode",
    label: "OpenCode",
    bin: "opencode",
    cmd: 'opencode run "{prompt}"',
    install: "npm i -g opencode-ai",
  },
  {
    name: "aider",
    label: "Aider",
    bin: "aider",
    cmd: 'aider --yes-always --message "{prompt}"',
    install: "pip install aider-chat",
  },
];

/**
 * API providers — any OpenAI-compatible /chat/completions endpoint. Configured
 * through the chat picker's setup form (POST /agent/setup); key/model/url live
 * in ~/.donova/agents.json, never in the project. Runs the tool-call loop
 * so these agents can edit files, not just chat.
 */
const API_PRESETS: { name: string; label: string; url: string; model: string; needsKey: boolean }[] = [
  {
    name: "openai",
    label: "OpenAI (API key)",
    url: "https://api.openai.com/v1/chat/completions",
    model: "gpt-5",
    needsKey: true,
  },
  {
    name: "gemini-api",
    label: "Gemini (API key)",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: "gemini-2.5-pro",
    needsKey: true,
  },
  {
    name: "openrouter",
    label: "OpenRouter",
    url: "https://openrouter.ai/api/v1/chat/completions",
    model: "",
    needsKey: true,
  },
  {
    name: "ollama",
    label: "Ollama (local)",
    url: "http://localhost:11434/v1/chat/completions",
    model: "",
    needsKey: false,
  },
  {
    name: "lmstudio",
    label: "LM Studio (local)",
    url: "http://localhost:1234/v1/chat/completions",
    model: "",
    needsKey: false,
  },
  { name: "custom-api", label: "Custom endpoint…", url: "", model: "", needsKey: false },
];

/** User-level agent secrets/config — outside the project so keys never get committed. */
function agentStorePath(): string {
  return join(homedir(), ".donova", "agents.json");
}
function readAgentStore(): Record<string, { key?: string; url?: string; model?: string }> {
  try {
    return JSON.parse(readFileSync(agentStorePath(), "utf8"));
  } catch {}
  // older-branding stores — read once, migrated on next write
  for (const dir of [".editnce", ".framecraft"]) {
    try {
      return JSON.parse(readFileSync(join(homedir(), dir, "agents.json"), "utf8"));
    } catch {}
  }
  return {};
}
function writeAgentStore(store: Record<string, { key?: string; url?: string; model?: string }>): void {
  mkdirSync(join(agentStorePath(), ".."), { recursive: true });
  writeFileSync(agentStorePath(), JSON.stringify(store, null, 2), { mode: 0o600 });
}

let sessionAgent: string | null = null;

/** DONOVA_* env vars preferred; EDITNCE_* and FC_* (earlier brands) still honored. */
function agentEnv(suffix: string): string | undefined {
  return (
    process.env[`DONOVA_${suffix}`] ??
    ["EDITNCE_", "FC_"].map((p) => process.env[`${p}${suffix}`]).find(Boolean)
  );
}
function agentKeyEnv(): string | undefined {
  return agentEnv("AGENT_KEY_ENV");
}

function whichBin(bin: string): boolean {
  try {
    execSync(`which ${bin}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

interface AgentConfig {
  agent?: string | { cmd?: string; url?: string; model?: string; keyEnv?: string };
}

function readAgentConfig(projectDir: string): AgentConfig["agent"] {
  for (const name of ["donova.json", "editnce.json", "framecraft.json"]) {
    try {
      const cfg = join(projectDir, name);
      if (existsSync(cfg)) return (JSON.parse(readFileSync(cfg, "utf8")) as AgentConfig).agent;
    } catch {}
  }
  return undefined;
}

function apiPreset(name: string): AgentSpec | null {
  const p = API_PRESETS.find((a) => a.name === name);
  if (!p) return null;
  const saved = readAgentStore()[name] ?? {};
  const url = saved.url ?? p.url;
  const model = saved.model ?? p.model;
  const key = saved.key ?? (agentKeyEnv() ? process.env[agentKeyEnv() as string] : undefined);
  if (!url || !model) return { name: p.name, label: p.label, kind: "http", url, model, key, edits: true };
  return { name: p.name, label: p.label, kind: "http", url, model, key, edits: true };
}

function preset(name: string): AgentSpec | null {
  const p = AGENT_PRESETS.find((a) => a.name === name);
  if (p) return { name: p.name, label: p.label, kind: "cli", cmd: p.cmd, edits: true };
  return apiPreset(name);
}

/** Public alias — the auto watcher resolves agents outside the sidecar. */
export function resolveAgentSpec(projectDir: string): AgentSpec | null {
  return resolveAgent(projectDir);
}

/**
 * Run an agent to completion outside the sidecar (auto watcher). Streams
 * lines via onLine; resolves with the exit code. PATH gets the CLI's own
 * bin dir prepended so agents can run `donova` even on user-prefix installs.
 */
export function runAgentJob(
  projectDir: string,
  spec: AgentSpec,
  prompt: string,
  onLine: (line: string) => void,
): Promise<number> {
  return new Promise((resolvePromise) => {
    const finish = (code: number | null) => resolvePromise(code ?? 1);
    if (spec.kind === "http" && spec.url) {
      void runHttpJob(projectDir, spec, prompt, onLine, finish);
      return;
    }
    const cmd = spec.cmd ?? "";
    const entry = process.argv[1];
    // launchd daemons run with a minimal PATH — pad with the bins where agent
    // CLIs and `donova` itself typically live so spawned agents can exec them.
    const extra = [
      entry ? dirname(entry) : "",
      join(homedir(), ".donova", "npm", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]
      .filter(Boolean)
      .join(":");
    const env = {
      ...process.env,
      PATH: `${extra}:${process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"}`,
    };
    if (cmd.includes("{prompt}")) {
      const full = cmd.replaceAll("{prompt}", `'${prompt.replaceAll("'", "'\\''")}'`);
      const proc = spawn(full, { cwd: projectDir, shell: true, stdio: ["ignore", "pipe", "pipe"], env });
      proc.stdout?.on("data", (d: Buffer) => onLine(d.toString()));
      proc.stderr?.on("data", (d: Buffer) => onLine(d.toString()));
      proc.on("close", finish);
    } else {
      const proc = spawn(cmd, { cwd: projectDir, shell: true, stdio: ["pipe", "pipe", "pipe"], env });
      proc.stdin.write(prompt);
      proc.stdin.end();
      proc.stdout?.on("data", (d: Buffer) => onLine(d.toString()));
      proc.stderr?.on("data", (d: Buffer) => onLine(d.toString()));
      proc.on("close", finish);
    }
  });
}

/** Resolve the configured agent, honoring presets, custom cmds, HTTP endpoints. */
function resolveAgent(projectDir: string): AgentSpec | null {
  const envUrl = agentEnv("AGENT_URL");
  if (CLOUD) {
    // hosted: only the service-configured endpoint may answer — no user-
    // supplied cmd (would be shell exec in a shared container) or stored keys
    if (!envUrl) return null;
    const keyEnv = agentKeyEnv();
    return {
      name: "endpoint",
      label: `${agentEnv("AGENT_MODEL") ?? "model"} @ ${envUrl}`,
      kind: "http",
      url: envUrl,
      model: agentEnv("AGENT_MODEL"),
      key: keyEnv ? process.env[keyEnv] : undefined,
      keyEnv,
      edits: true,
    };
  }
  const pick = (sel: string): AgentSpec | null =>
    preset(sel) ?? (sel.trim() ? { name: "custom", label: sel, kind: "cli", cmd: sel, edits: true } : null);
  if (sessionAgent) return pick(sessionAgent);
  const cfg = readAgentConfig(projectDir);
  if (typeof cfg === "string" && cfg !== "auto") return pick(cfg);
  if (cfg && typeof cfg === "object") {
    if (cfg.cmd) return { name: "custom", label: cfg.cmd, kind: "cli", cmd: cfg.cmd, edits: true };
    if (cfg.url) {
      const key = cfg.keyEnv ? process.env[cfg.keyEnv] : undefined;
      return {
        name: "endpoint",
        label: `${cfg.model ?? "model"} @ ${cfg.url}`,
        kind: "http",
        url: cfg.url,
        model: cfg.model,
        key,
        keyEnv: cfg.keyEnv,
        edits: true,
      };
    }
  }
  const env = agentEnv("AGENT") ?? agentEnv("AGENT_CMD");
  if (env) return pick(env);
  if (envUrl) {
    const keyEnv = agentKeyEnv();
    return {
      name: "endpoint",
      label: `${agentEnv("AGENT_MODEL") ?? "model"} @ ${envUrl}`,
      kind: "http",
      url: envUrl,
      model: agentEnv("AGENT_MODEL"),
      key: keyEnv ? process.env[keyEnv] : undefined,
      keyEnv,
      edits: true,
    };
  }
  if (cfg !== "auto") {
    for (const p of AGENT_PRESETS) {
      if (whichBin(p.bin)) return preset(p.name);
    }
    const store = readAgentStore();
    for (const p of API_PRESETS) {
      const saved = store[p.name];
      if (saved && (saved.url ?? p.url) && (saved.model ?? p.model)) return apiPreset(p.name);
    }
  }
  return null;
}

/** What the picker needs to render per entry: install/config state + which setup fields apply. */
interface ListedAgent {
  name: string;
  label: string;
  kind: "cli" | "api";
  detected: boolean;
  active: boolean;
  needsKey?: boolean;
  needsModel?: boolean;
  needsUrl?: boolean;
  install?: string;
}

function apiConfigured(name: string): {
  configured: boolean;
  needsKey: boolean;
  needsModel: boolean;
  needsUrl: boolean;
} {
  const p = API_PRESETS.find((a) => a.name === name);
  if (!p) return { configured: false, needsKey: false, needsModel: false, needsUrl: false };
  const saved = readAgentStore()[name] ?? {};
  const hasUrl = Boolean(saved.url ?? p.url);
  const hasModel = Boolean(saved.model ?? p.model);
  const hasKey = Boolean(saved.key);
  return {
    configured: hasUrl && hasModel && (!p.needsKey || hasKey),
    needsKey: p.needsKey && !hasKey,
    needsModel: !hasModel,
    needsUrl: !hasUrl,
  };
}

/** Everything the chat picker needs: presets w/ install/setup state, configured entries, active. */
function listAgents(projectDir: string): ListedAgent[] {
  const active = resolveAgent(projectDir);
  if (CLOUD) {
    return active
      ? [
          {
            name: "endpoint",
            label: "Donova agent",
            kind: "api",
            detected: true,
            active: true,
          },
        ]
      : [];
  }
  const out: ListedAgent[] = AGENT_PRESETS.map((p) => ({
    name: p.name,
    label: p.label,
    kind: "cli",
    detected: whichBin(p.bin),
    active: active?.name === p.name,
    install: p.install,
  }));
  for (const p of API_PRESETS) {
    const c = apiConfigured(p.name);
    out.push({
      name: p.name,
      label: p.label,
      kind: "api",
      detected: c.configured,
      active: active?.name === p.name,
      needsKey: c.needsKey,
      needsModel: c.needsModel,
      needsUrl: c.needsUrl,
    });
  }
  const cfg = readAgentConfig(projectDir);
  if (cfg && typeof cfg === "object" && cfg.url) {
    out.push({
      name: "endpoint",
      label: `${cfg.model ?? "model"} @ ${cfg.url}`,
      kind: "api",
      detected: true,
      active: active?.name === "endpoint",
    });
  }
  if (active?.name === "custom") {
    out.push({ name: "custom", label: active.label, kind: "cli", detected: true, active: true });
  }
  return out;
}

const jobs = new Map<
  string,
  { lines: string[]; done: boolean; code: number | null; listeners: ServerResponse[] }
>();

function buildPrompt(projectDir: string, body: ChatBody): string {
  let prompt = [
    `You are editing the video composition in the current directory (${projectDir}).`,
    `It is a HyperFrames/Donova HTML composition: timed elements carry data-start/data-duration, visuals carry class="clip", motion lives in a paused GSAP root timeline on window.__timelines. Only deterministic edits.`,
  ].join("\n");
  // The user's style bible is the durable preference store — inline it every
  // turn (8KB cap, same as the cloud agent) so edits reflect their style and
  // write_file updates carry the existing content forward instead of
  // clobbering it. This is what "the agent pulls from my style library"
  // actually means on the wire.
  try {
    const stylePath = join(projectDir, "style.md");
    if (existsSync(stylePath)) {
      const style = readFileSync(stylePath, "utf8").slice(0, 8192);
      prompt += `\n\nThe user's style bible (style.md) — follow it for every visual/caption/sound choice, and preserve its content if you update it:\n\n${style}`;
    }
  } catch {}
  prompt += `\n\nRules for this kind of edit: if the request references media that exists in the project but isn't in the composition yet, wire it in first (a timed element like <video src="..." data-start="0" data-duration="N"> — check the file's real duration with donova probe or ffprobe, don't guess). For anything that needs to see footage — locating a moment, tracking an object, reading on-screen text — use view_frame to sample the video rather than inventing timecodes or positions.\n\nThe user just sent this request from the Studio dashboard:\n\n${body.message ?? ""}`;
  if (body.annotation) {
    const safe = body.annotation.replace(/[^a-zA-Z0-9._/-]/g, "");
    const path = join(projectDir, safe);
    if (safe.startsWith("annotations/") && existsSync(path)) {
      prompt += `\n\nIt comes with a drawn-on-frame annotation (${safe}) — marks are normalized comp coords (multiply by comp w/h for pixels); ${safe.replace(/\.json$/, ".png")} shows the frame with the drawing baked in:\n\n${readFileSync(path, "utf8")}`;
    }
  }
  return `${prompt}\n\nApply the edit, then report concisely what you changed.`;
}

function startJob(projectDir: string, spec: AgentSpec, prompt: string, userMessage?: string): string {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    lines: [] as string[],
    done: false,
    code: null as number | null,
    listeners: [] as ServerResponse[],
  };
  jobs.set(id, job);
  if (jobs.size > 50) {
    const oldest = jobs.keys().next().value;
    if (oldest) jobs.delete(oldest);
  }
  const broadcast = (chunk: string) => {
    job.lines.push(chunk);
    for (const l of job.listeners) l.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };
  const finish = (code: number | null) => {
    job.done = true;
    job.code = code;
    for (const l of job.listeners) {
      l.write(`event: done\ndata: ${JSON.stringify({ code })}\n\n`);
      l.end();
    }
    job.listeners = [];
  };
  if (spec.kind === "http" && spec.url) {
    runHttpJob(projectDir, spec, prompt, broadcast, finish, userMessage);
    return id;
  }
  const cmd = spec.cmd ?? "";
  if (cmd.includes("{prompt}")) {
    const full = cmd.replaceAll("{prompt}", `'${prompt.replaceAll("'", "'\\''")}'`);
    const proc = spawn(full, { cwd: projectDir, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    wire(proc);
  } else {
    const proc = spawn(cmd, { cwd: projectDir, shell: true, stdio: ["pipe", "pipe", "pipe"] });
    proc.stdin.write(prompt);
    proc.stdin.end();
    wire(proc);
  }
  function wire(proc: ReturnType<typeof spawn>): void {
    proc.stdout?.on("data", (d: Buffer) => broadcast(d.toString()));
    proc.stderr?.on("data", (d: Buffer) => broadcast(d.toString()));
    proc.on("close", finish);
  }
  return id;
}

// --- API agent: OpenAI-compatible endpoint + tool-call loop ------------------

const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file inside the project directory",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "project-relative path" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write/overwrite a file inside the project directory",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string", description: "full new file contents" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files in a project directory (default: project root)",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: CLOUD
        ? `Run the donova CLI in the project dir, e.g. 'node ${process.env.DONOVA_BIN || "donova"} check' or 'node ${process.env.DONOVA_BIN || "donova"} captions'. Only donova commands are allowed — no shell, pipes, redirects, or other binaries.`
        : "Run a shell command in the project dir (e.g. npx donova check, ffmpeg probes)",
      parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
    },
  },
  {
    type: "function",
    function: {
      name: "view_frame",
      description:
        "See frame(s) of a video/image — returns visual descriptions (objects, positions as 0-1 fractions, visible text/brand names, what's happening). To locate a moment, pass times as an ARRAY to sweep in one call (e.g. times:[1,3,5,7] then refine with a tighter sweep — 8-16 samples is usually plenty; don't sample one frame at a time).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "project-relative media path" },
          time: { type: "number", description: "seconds into the media (single frame)" },
          times: {
            type: "array",
            items: { type: "number" },
            description: "batch: up to 8 timecodes in one call",
          },
          note: { type: "string", description: "optional: what to look for" },
        },
        required: ["path"],
      },
    },
  },
];

function safePath(projectDir: string, p: string): string | null {
  const full = resolve(projectDir, p);
  return full.startsWith(resolve(projectDir)) ? full : null;
}

interface ToolCtx {
  changes: { file: string; before: string | null; after: string | null }[];
}

/** Imported footage and rendered binaries are read-only to the agent —
 * same guard the cloud Agent applies (assets/, media/, media extensions). */
const MEDIA_EXT = /\.(mov|mp4|webm|mkv|avi|mp3|wav|m4a|ogg|png|jpe?g|webp|heic|aiff?|flac)$/i;

function runTool(projectDir: string, name: string, args: Record<string, unknown>, ctx?: ToolCtx): string {
  try {
    if (name === "read_file") {
      const full = safePath(projectDir, String(args.path ?? ""));
      if (!full || !existsSync(full)) return "error: no such file";
      return readFileSync(full, "utf8").slice(0, 12000);
    }
    if (name === "write_file") {
      const rel = String(args.path ?? "");
      const full = safePath(projectDir, rel);
      if (!full) return "error: path outside project";
      if (rel.startsWith("assets/") || rel.startsWith("media/") || MEDIA_EXT.test(rel)) {
        return `error: write_file to ${rel} refused — media/asset files are read-only`;
      }
      const before = existsSync(full) ? readFileSync(full, "utf8") : null;
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, String(args.content ?? ""));
      ctx?.changes.push({ file: rel, before, after: String(args.content ?? "") });
      return "ok";
    }
    if (name === "list_files") {
      const full = safePath(projectDir, String(args.path ?? "."));
      if (!full) return "error: path outside project";
      return execSync(`ls -la ${JSON.stringify(full)}`, { encoding: "utf8" }).slice(0, 6000);
    }
    if (name === "run_command") {
      const cmd = String(args.cmd ?? "");
      if (CLOUD) {
        // Shared container: allow only the donova CLI (check/probe/captions
        // etc.) — a prompt-injected `npx evil-pkg` or `gcloud` would run with
        // the service account. File inspection is covered by the other tools.
        const bin = process.env.DONOVA_BIN || "donova";
        const launcher = new RegExp(
          `^(donova|npx donova|node ${bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\s`,
        );
        // Quotes allowed for paths with spaces — $ ` & | ; < > ( ) stay
        // banned, so quoting can't smuggle in substitution or chaining.
        const okCmd = launcher.test(cmd) && /^[a-zA-Z0-9 ._\-/:+*?,="']+$/.test(cmd) && !cmd.includes("..");
        if (!okCmd) return "error: command not allowed in cloud mode";
        const env = { ...process.env };
        for (const k of Object.keys(env)) {
          if (/key|secret|token|password/i.test(k)) delete env[k];
        }
        return execSync(cmd, {
          cwd: projectDir,
          encoding: "utf8",
          timeout: 60_000,
          stdio: ["ignore", "pipe", "pipe"],
          env,
        }).slice(0, 8000);
      }
      return execSync(cmd, {
        cwd: projectDir,
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
      }).slice(0, 8000);
    }
    return `error: unknown tool ${name}`;
  } catch (err) {
    return `error: ${String(err).slice(0, 2000)}`;
  }
}

/**
 * view_frame — extract one frame via ffmpeg and have a vision model describe
 * it. The chat model (deepseek-flash) is text-only, so frames go to a cheap
 * VLM and come back as words: objects, 0-1 frame positions, legible text,
 * what's happening. This is how the agent locates "the moment he hands it
 * over" instead of inventing a timecode.
 */
async function viewFrameTool(
  projectDir: string,
  spec: AgentSpec,
  args: Record<string, unknown>,
): Promise<string> {
  const rel = String(args.path ?? "");
  const note = String(args.note ?? "").slice(0, 300);
  const full = safePath(projectDir, rel);
  if (!full || !existsSync(full)) return "error: no such file";
  if (!MEDIA_EXT.test(rel)) return "error: not a media file";
  // Batched timecodes (max 8) or a single `time` — one tool round covers a
  // whole sweep so the model doesn't burn a round per frame.
  const timesRaw = Array.isArray(args.times) ? args.times : [args.time ?? 0];
  const times = timesRaw.map((v) => Math.max(0, Number(v) || 0)).slice(0, 8);
  const describeOne = async (t: number): Promise<string> => {
    const tmp = join(tmpdir(), `fc-frame-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`);
    try {
      execSync(
        `ffmpeg -hide_banner -loglevel error -y -ss ${t} -i ${JSON.stringify(full)} -frames:v 1 -vf "scale='min(768,iw)':-2" -q:v 4 ${JSON.stringify(tmp)}`,
        { stdio: ["ignore", "ignore", "pipe"], timeout: 30_000 },
      );
      if (!existsSync(tmp)) return `frame@${t}s: error — no frame (past the end?)`;
      const b64 = readFileSync(tmp).toString("base64");
      const model = process.env.DONOVA_VISION_MODEL ?? "deepseek/deepseek-v4.1-flash-1017";
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (spec.key) headers.authorization = `Bearer ${spec.key}`;
      const r = await fetch(spec.url as string, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(60_000), // a hung VLM call must not wedge the job
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Describe this video frame precisely and compactly: people and what they're doing, objects (with position as 0-1 x/y fractions of the frame), and any legible text or brand names.${note ? ` The caller specifically wants: ${note}` : ""}`,
                },
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
              ],
            },
          ],
        }),
      });
      const j = (await r.json()) as {
        choices?: { message?: { content?: string } }[];
        error?: { message?: string };
      };
      if (!r.ok) return `frame@${t}s: error — vision endpoint ${r.status}: ${j.error?.message ?? "failed"}`;
      const text = j.choices?.[0]?.message?.content;
      return text ? `frame@${t}s: ${text.slice(0, 1200)}` : `frame@${t}s: error — empty vision response`;
    } catch (err) {
      return `frame@${t}s: error — ${String(err).slice(0, 200)}`;
    } finally {
      try {
        unlinkSync(tmp);
      } catch {}
    }
  };
  // Parallel — 8 sequential VLM calls made a sweep take minutes; concurrent
  // keeps it ~30s. Promise.all preserves order. Tmp names are unique.
  const out = await Promise.all(times.map(describeOne));
  return out.join("\n");
}

interface ChatMessage {
  role: string;
  content?: string | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/** Turn history — same shape + location (.donova/turns.json) the cloud Agent
 * writes, so Studio chats and dashboard chats share one memory. */
interface SidecarTurn {
  id: string;
  at: string;
  message: string;
  reply: string;
  changes: { file: string; before: string | null; after: string | null }[];
  tools: string[];
  usage?: { inputTokens: number; outputTokens: number };
}

function readTurns(projectDir: string): SidecarTurn[] {
  try {
    const parsed = JSON.parse(readFileSync(join(projectDir, ".donova", "turns.json"), "utf8")) as unknown;
    // Both shapes exist: Agent writes Turn[], studio-service seeds {turns:[]}.
    if (Array.isArray(parsed)) return parsed as SidecarTurn[];
    return ((parsed as { turns?: SidecarTurn[] }).turns ?? []) as SidecarTurn[];
  } catch {
    return [];
  }
}

function appendTurn(projectDir: string, turn: SidecarTurn): void {
  try {
    const turns = readTurns(projectDir);
    turns.push(turn);
    mkdirSync(join(projectDir, ".donova"), { recursive: true });
    writeFileSync(join(projectDir, ".donova", "turns.json"), JSON.stringify(turns.slice(-50), null, 2));
  } catch {}
}

/**
 * Agent over any OpenAI-compatible /chat/completions endpoint, with a
 * read/write/list/run tool loop so it can actually edit the composition —
 * not just reply. Streams progress lines ("› write_file index.html").
 * Replays the last 10 turns so "make it bigger"-style follow-ups have a
 * referent, and appends the finished turn to .donova/turns.json.
 */
async function runHttpJob(
  projectDir: string,
  spec: AgentSpec,
  prompt: string,
  broadcast: (chunk: string) => void,
  finish: (code: number | null) => void,
  userMessage?: string,
): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (spec.key) headers.authorization = `Bearer ${spec.key}`;
  const prior: ChatMessage[] = readTurns(projectDir)
    .slice(-10)
    .flatMap((t) => [
      { role: "user", content: t.message },
      { role: "assistant", content: t.reply },
    ]);
  const messages: ChatMessage[] = [...prior, { role: "user", content: prompt }];
  const ctx: ToolCtx = { changes: [] };
  const tools: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let reply = "";
  let code = 1;
  const persist = () => {
    appendTurn(projectDir, {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      message: userMessage ?? prompt,
      reply,
      changes: ctx.changes,
      tools,
      usage:
        usage.inputTokens + usage.outputTokens > 0
          ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
          : undefined,
    });
  };
  // 24 rounds: vision tasks legitimately need ~4 read rounds + ~6 batched
  // frame sweeps + write + verify. Still bounded so a stuck loop can't
  // run the meter up — each round is one provider call.
  for (let round = 0; round < 24; round++) {
    let msg: ChatMessage | undefined;
    try {
      const r = await fetch(spec.url as string, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: spec.model ?? "default",
          messages,
          tools: AGENT_TOOLS,
          tool_choice: "auto",
        }),
      });
      const j = (await r.json()) as {
        choices?: { message?: ChatMessage }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        error?: { message?: string };
      };
      usage.inputTokens += j.usage?.prompt_tokens ?? 0;
      usage.outputTokens += j.usage?.completion_tokens ?? 0;
      if (!r.ok) {
        broadcast(`error ${r.status}: ${j.error?.message ?? JSON.stringify(j).slice(0, 400)}`);
        reply = `error ${r.status}: ${j.error?.message ?? "endpoint error"}`;
        persist();
        finish(1);
        return;
      }
      msg = j.choices?.[0]?.message;
    } catch (err) {
      broadcast(`endpoint unreachable: ${String(err)}`);
      reply = `endpoint unreachable: ${String(err)}`;
      persist();
      finish(1);
      return;
    }
    if (!msg) {
      broadcast("(empty reply)");
      code = 0;
      persist();
      finish(0);
      return;
    }
    messages.push(msg);
    if (msg.tool_calls?.length) {
      for (const call of msg.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        } catch {}
        broadcast(
          `› ${call.function.name} ${String(args.path ?? args.cmd ?? "").slice(0, 80)}${call.function.name === "view_frame" ? `@${Array.isArray(args.times) ? `${args.times.length} frames` : `${args.time ?? 0}s`}` : ""}\n`,
        );
        tools.push(call.function.name);
        const result =
          call.function.name === "view_frame"
            ? await viewFrameTool(projectDir, spec, args)
            : runTool(projectDir, call.function.name, args, ctx);
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
      continue;
    }
    reply = msg.content ?? "";
    broadcast(reply || "(done)");
    persist();
    finish(0);
    return;
  }
  broadcast("(stopped: tool-call limit reached)");
  reply = "(stopped: tool-call limit reached)";
  persist();
  finish(code);
}

// --- request handling -------------------------------------------------------

function handle(projectDir: string, req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "POST, GET, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, v: SIDECAR_VERSION, projectDir }));
    return;
  }
  if (req.method === "POST" && req.url === "/stop") {
    if (CLOUD) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "managed" }));
      return;
    }
    res.writeHead(200).end("bye");
    setTimeout(() => process.exit(0), 100);
    return;
  }
  const fileMatch = req.url?.match(/^\/file\?p=(.+)$/);
  if (req.method === "GET" && fileMatch) {
    const rel = decodeURIComponent(fileMatch[1] ?? "").replace(/[^a-zA-Z0-9._/-]/g, "");
    const full = join(projectDir, rel);
    if (rel.startsWith("annotations/") && existsSync(full) && !full.includes("..")) {
      const ext = rel.endsWith(".png")
        ? "image/png"
        : rel.endsWith(".json")
          ? "application/json"
          : "application/octet-stream";
      res.writeHead(200, { "content-type": ext });
      res.end(readFileSync(full));
      return;
    }
    res.writeHead(404).end("not found");
    return;
  }
  if (req.method === "GET" && req.url === "/agent/health") {
    const spec = resolveAgent(projectDir);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        agent: Boolean(spec),
        name: spec?.name ?? null,
        cmd: spec?.cmd ?? spec?.url ?? null,
        edits: spec?.edits ?? false,
      }),
    );
    return;
  }
  if (req.method === "GET" && req.url === "/agent/list") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, agents: listAgents(projectDir) }));
    return;
  }
  if (req.method === "POST" && req.url === "/agent/setup") {
    if (CLOUD) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "managed" }));
      return;
    }
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      try {
        const body = JSON.parse(raw) as { name?: string; key?: string; url?: string; model?: string };
        const p = API_PRESETS.find((a) => a.name === body.name);
        if (!p) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "unknown api provider" }));
          return;
        }
        const store = readAgentStore();
        const prev = store[p.name] ?? {};
        store[p.name] = {
          key: body.key !== undefined ? body.key : prev.key,
          url: body.url !== undefined ? body.url : prev.url,
          model: body.model !== undefined ? body.model : prev.model,
        };
        writeAgentStore(store);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, configured: apiConfigured(p.name).configured }));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    });
    return;
  }
  if (req.method === "POST" && req.url === "/agent/select") {
    if (CLOUD) {
      const sel = resolveAgent(projectDir);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, agent: sel?.name ?? null, cmd: sel?.cmd ?? sel?.url ?? null }));
      return;
    }
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      try {
        const { name } = JSON.parse(raw) as { name?: string };
        const spec = name ? preset(name) : null;
        sessionAgent = spec ? (spec.name as string) : null;
        // persist so the choice survives studio restarts
        const cfgPath = join(projectDir, "donova.json");
        let cfg: Record<string, unknown> = {};
        try {
          if (existsSync(cfgPath)) cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
        } catch {}
        cfg.agent = spec ? spec.name : undefined;
        writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
        const sel = resolveAgent(projectDir);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, agent: sel?.name ?? null, cmd: sel?.cmd ?? sel?.url ?? null }));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    });
    return;
  }
  const streamMatch = req.url?.match(/^\/agent\/jobs\/([a-z0-9-]+)\/stream$/)?.[1];
  if (req.method === "GET" && streamMatch) {
    const job = jobs.get(streamMatch);
    if (!job) {
      res.writeHead(404).end("no such job");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    for (const line of job.lines) res.write(`data: ${JSON.stringify(line)}\n\n`);
    if (job.done) {
      res.write(`event: done\ndata: ${JSON.stringify({ code: job.code })}\n\n`);
      res.end();
      return;
    }
    job.listeners.push(res);
    req.on("close", () => {
      job.listeners = job.listeners.filter((l) => l !== res);
    });
    return;
  }
  if (req.method === "GET" && req.url === "/auto") {
    if (CLOUD) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, enabled: false, running: false }));
      return;
    }
    void (async () => {
      const { autoStatus, findWorkspace } = await import("./watch.js");
      const st = await autoStatus(projectDir);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          enabled: st.enabled,
          running: st.running,
          workspace: findWorkspace(projectDir) ?? st.workspace,
          agent: st.agent,
          processed: Object.keys(st.processed).length,
        }),
      );
    })().catch((e) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    });
    return;
  }
  if (req.method === "POST" && req.url === "/auto") {
    if (CLOUD) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "auto is desktop-only for now" }));
      return;
    }
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      void (async () => {
        const { setAutoEnabled, findWorkspace } = await import("./watch.js");
        const body = JSON.parse(raw) as { enabled?: boolean };
        const ws = findWorkspace(projectDir);
        const st = setAutoEnabled(Boolean(body.enabled), ws ?? undefined, "studio");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ ok: true, enabled: st.enabled, running: st.running, workspace: st.workspace }),
        );
      })().catch((e) => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      });
    });
    return;
  }
  if (req.method === "POST" && req.url === "/agent/chat") {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      try {
        const body = JSON.parse(raw) as ChatBody;
        const spec = resolveAgent(projectDir);
        if (!spec) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "no-agent" }));
          return;
        }
        const jobId = startJob(projectDir, spec, buildPrompt(projectDir, body), body.message);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ ok: true, jobId, cmd: spec.cmd ?? spec.url, name: spec.name, edits: spec.edits }),
        );
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    });
    return;
  }
  if (req.method === "POST" && req.url === "/annotate") {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      try {
        const body = JSON.parse(raw) as AnnotationBody;
        const dir = join(projectDir, "annotations");
        mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const base = `${stamp}-${slug(body.note ?? "")}`;
        const spec = {
          v: 1,
          t: body.t ?? null,
          comp: body.comp ?? null,
          marks: body.marks ?? [],
          note: body.note ?? "",
          png: body.png ? `${base}.png` : null,
          createdAt: new Date().toISOString(),
        };
        writeFileSync(join(dir, `${base}.json`), JSON.stringify(spec, null, 2));
        // append-only ledger — intents survive even if the per-annotation
        // files are pruned/moved; agents can replay from here.
        appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify({ file: `${base}.json`, ...spec })}\n`);
        if (body.png) {
          const data = body.png.replace(/^data:image\/\w+;base64,/, "");
          writeFileSync(join(dir, `${base}.png`), Buffer.from(data, "base64"));
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, file: `annotations/${base}.json` }));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    });
    return;
  }
  res.writeHead(404).end("not found");
}

export function createAnnotateServer(projectDir: string): Server {
  return createServer((req, res) => handle(projectDir, req, res));
}

/** Standalone entry: `node annotate-server.mjs <projectDir> <port>` (spawned detached). */
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [, , dir, portStr] = process.argv;
  if (!dir || !portStr) process.exit(1);
  createAnnotateServer(dir).listen(Number(portStr), "127.0.0.1");
}

async function sidecarUp(port: number, projectDir: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = get({ host: "127.0.0.1", port, path: "/health", timeout: 1500 }, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () =>
        resolve(
          res.statusCode === 200 && body.includes(projectDir) && body.includes(`"v":${SIDECAR_VERSION}`),
        ),
      );
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Ensure the annotation sidecar runs for this project+studio port (idempotent). */
export async function ensureAnnotateServer(projectDir: string, studioPort: number): Promise<void> {
  const port = annotatePort(studioPort);
  if (await sidecarUp(port, projectDir)) return;
  // a stale sidecar may hold the port — ask it to stop before respawning
  await new Promise<void>((resolve) => {
    const req = get({ host: "127.0.0.1", port, path: "/stop", timeout: 800, method: "POST" }, () =>
      resolve(),
    );
    req.on("error", () => resolve());
    req.on("timeout", () => {
      req.destroy();
      resolve();
    });
    req.end();
  });
  await new Promise((r) => setTimeout(r, 300));
  const script = join(fileURLToPath(import.meta.url));
  const child = spawn(process.execPath, [script, projectDir, String(port)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
