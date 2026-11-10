import { execSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { get } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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

interface AgentSpec {
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

/** Resolve the configured agent, honoring presets, custom cmds, HTTP endpoints. */
function resolveAgent(projectDir: string): AgentSpec | null {
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
  const envUrl = agentEnv("AGENT_URL");
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
    "The user just sent this request from the Studio dashboard:",
    "",
    body.message ?? "",
  ].join("\n");
  if (body.annotation) {
    const safe = body.annotation.replace(/[^a-zA-Z0-9._/-]/g, "");
    const path = join(projectDir, safe);
    if (safe.startsWith("annotations/") && existsSync(path)) {
      prompt += `\n\nIt comes with a drawn-on-frame annotation (${safe}) — marks are normalized comp coords (multiply by comp w/h for pixels); ${safe.replace(/\.json$/, ".png")} shows the frame with the drawing baked in:\n\n${readFileSync(path, "utf8")}`;
    }
  }
  return `${prompt}\n\nApply the edit, then report concisely what you changed.`;
}

function startJob(projectDir: string, spec: AgentSpec, prompt: string): string {
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
    runHttpJob(projectDir, spec, prompt, broadcast, finish);
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
      description: "Run a shell command in the project dir (e.g. npx donova check, ffmpeg probes)",
      parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
    },
  },
];

function safePath(projectDir: string, p: string): string | null {
  const full = resolve(projectDir, p);
  return full.startsWith(resolve(projectDir)) ? full : null;
}

function runTool(projectDir: string, name: string, args: Record<string, unknown>): string {
  try {
    if (name === "read_file") {
      const full = safePath(projectDir, String(args.path ?? ""));
      if (!full || !existsSync(full)) return "error: no such file";
      return readFileSync(full, "utf8").slice(0, 12000);
    }
    if (name === "write_file") {
      const full = safePath(projectDir, String(args.path ?? ""));
      if (!full) return "error: path outside project";
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, String(args.content ?? ""));
      return "ok";
    }
    if (name === "list_files") {
      const full = safePath(projectDir, String(args.path ?? "."));
      if (!full) return "error: path outside project";
      return execSync(`ls -la ${JSON.stringify(full)}`, { encoding: "utf8" }).slice(0, 6000);
    }
    if (name === "run_command") {
      return execSync(String(args.cmd ?? ""), {
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

interface ChatMessage {
  role: string;
  content?: string | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/**
 * Agent over any OpenAI-compatible /chat/completions endpoint, with a
 * read/write/list/run tool loop so it can actually edit the composition —
 * not just reply. Streams progress lines ("› write_file index.html").
 */
async function runHttpJob(
  projectDir: string,
  spec: AgentSpec,
  prompt: string,
  broadcast: (chunk: string) => void,
  finish: (code: number | null) => void,
): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (spec.key) headers.authorization = `Bearer ${spec.key}`;
  const messages: ChatMessage[] = [{ role: "user", content: prompt }];
  for (let round = 0; round < 15; round++) {
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
        error?: { message?: string };
      };
      if (!r.ok) {
        broadcast(`error ${r.status}: ${j.error?.message ?? JSON.stringify(j).slice(0, 400)}`);
        finish(1);
        return;
      }
      msg = j.choices?.[0]?.message;
    } catch (err) {
      broadcast(`endpoint unreachable: ${String(err)}`);
      finish(1);
      return;
    }
    if (!msg) {
      broadcast("(empty reply)");
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
        broadcast(`› ${call.function.name} ${String(args.path ?? args.cmd ?? "").slice(0, 80)}\n`);
        const result = runTool(projectDir, call.function.name, args);
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
      continue;
    }
    broadcast(msg.content ?? "(done)");
    finish(0);
    return;
  }
  broadcast("(stopped: tool-call limit reached)");
  finish(1);
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
        const jobId = startJob(projectDir, spec, buildPrompt(projectDir, body));
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
