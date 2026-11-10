import { execSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { get } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Annotation sidecar — receives "draw on the frame" marks from the Studio
 * overlay and writes them into the project for the agent to consume, and
 * bridges Studio chat to a locally configured agent CLI.
 *
 * `fc studio` launches hyperframes' own preview server, whose routes we can't
 * extend, so this runs as a tiny detached server on studioPort+1000 bound to
 * localhost.
 *
 * Routes:
 *   GET  /health                    sidecar liveness + projectDir
 *   POST /annotate                  persist annotations/*.json + *.png
 *   GET  /agent/health              { agent: bool, name, cmd } — bridge configured?
 *   GET  /agent/list                known agents + detected/active state (chat picker)
 *   POST /agent/select {name}       switch the active agent (persists to framecraft.json)
 *   POST /agent/chat {message, annotation?} → { jobId } (503 when no bridge)
 *   GET  /agent/jobs/:id/stream     SSE of the agent run
 *   POST /stop                      shutdown
 *
 * Agent resolution (first hit wins):
 *   1. POST /agent/select session override
 *   2. framecraft.json "agent":  "auto" | "<preset>" | { cmd } | { url, model }
 *   3. env: FC_AGENT (preset name or raw cmd) → FC_AGENT_CMD (raw cmd)
 *   4. first preset whose binary is on PATH (claude, codex, gemini, …)
 *
 * `{prompt}` in a cmd substitutes the prompt as an arg; otherwise the prompt is
 * written to the process's stdin. `{ url, model }` targets any OpenAI-compatible
 * /chat/completions endpoint (Ollama, LM Studio, OpenRouter, …) — reply-only,
 * it can't edit files. Contract: plan/19-ANNOTATE.md.
 */

const SIDECAR_PORT_OFFSET = 1000;
const SIDECAR_VERSION = 4;

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
  keyEnv?: string; // env var holding a bearer key (never stored)
  edits: boolean; // can it modify project files?
}

/** Headless commands for known agent CLIs. Each takes the prompt via stdin or a {prompt} arg. */
const AGENT_PRESETS: { name: string; label: string; bin: string; cmd: string }[] = [
  { name: "claude", label: "Claude Code", bin: "claude", cmd: "claude -p --dangerously-skip-permissions" },
  {
    name: "codex",
    label: "Codex (OpenAI)",
    bin: "codex",
    cmd: 'codex exec --dangerously-bypass-approvals-and-sandbox "{prompt}"',
  },
  { name: "gemini", label: "Gemini CLI", bin: "gemini", cmd: 'gemini --yolo -p "{prompt}"' },
  { name: "opencode", label: "OpenCode", bin: "opencode", cmd: 'opencode run "{prompt}"' },
  { name: "aider", label: "Aider", bin: "aider", cmd: 'aider --yes-always --message "{prompt}"' },
];

let sessionAgent: string | null = null;

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
  try {
    const cfg = join(projectDir, "framecraft.json");
    if (existsSync(cfg)) return (JSON.parse(readFileSync(cfg, "utf8")) as AgentConfig).agent;
  } catch {}
  return undefined;
}

function preset(name: string): AgentSpec | null {
  const p = AGENT_PRESETS.find((a) => a.name === name);
  return p ? { name: p.name, label: p.label, kind: "cli", cmd: p.cmd, edits: true } : null;
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
      return {
        name: "endpoint",
        label: `${cfg.model ?? "model"} @ ${cfg.url}`,
        kind: "http",
        url: cfg.url,
        model: cfg.model,
        keyEnv: cfg.keyEnv,
        edits: false,
      };
    }
  }
  const env = process.env.FC_AGENT ?? process.env.FC_AGENT_CMD;
  if (env) return pick(env);
  if (process.env.FC_AGENT_URL) {
    return {
      name: "endpoint",
      label: `${process.env.FC_AGENT_MODEL ?? "model"} @ ${process.env.FC_AGENT_URL}`,
      kind: "http",
      url: process.env.FC_AGENT_URL,
      model: process.env.FC_AGENT_MODEL,
      keyEnv: process.env.FC_AGENT_KEY_ENV,
      edits: false,
    };
  }
  if (cfg !== "auto") {
    for (const p of AGENT_PRESETS) {
      if (whichBin(p.bin)) return preset(p.name);
    }
  }
  return null;
}

/** Everything the chat picker needs: presets w/ install state, configured entries, active. */
function listAgents(
  projectDir: string,
): { name: string; label: string; detected: boolean; active: boolean }[] {
  const active = resolveAgent(projectDir);
  const out = AGENT_PRESETS.map((p) => ({
    name: p.name,
    label: p.label,
    detected: whichBin(p.bin),
    active: active?.name === p.name,
  }));
  const cfg = readAgentConfig(projectDir);
  if (cfg && typeof cfg === "object" && cfg.url) {
    out.push({
      name: "endpoint",
      label: `${cfg.model ?? "model"} @ ${cfg.url}`,
      detected: true,
      active: active?.kind === "http",
    });
  }
  if (active?.name === "custom")
    out.push({ name: "custom", label: active.label, detected: true, active: true });
  return out;
}

const jobs = new Map<
  string,
  { lines: string[]; done: boolean; code: number | null; listeners: ServerResponse[] }
>();

function buildPrompt(projectDir: string, body: ChatBody): string {
  let prompt = [
    `You are editing the video composition in the current directory (${projectDir}).`,
    `It is a HyperFrames/Framecraft HTML composition: timed elements carry data-start/data-duration, visuals carry class="clip", motion lives in a paused GSAP root timeline on window.__timelines. Only deterministic edits.`,
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
    runHttpJob(spec, prompt, broadcast, finish);
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

/** Reply-only agent over any OpenAI-compatible /chat/completions endpoint. */
function runHttpJob(
  spec: AgentSpec,
  prompt: string,
  broadcast: (chunk: string) => void,
  finish: (code: number | null) => void,
): void {
  const key = spec.keyEnv ? process.env[spec.keyEnv] : undefined;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  fetch(spec.url as string, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: spec.model ?? "default", messages: [{ role: "user", content: prompt }] }),
  })
    .then(async (r) => {
      const j = (await r.json()) as {
        choices?: { message?: { content?: string } }[];
        error?: { message?: string };
      };
      if (!r.ok) {
        broadcast(`error ${r.status}: ${j.error?.message ?? JSON.stringify(j).slice(0, 400)}`);
        finish(1);
        return;
      }
      broadcast(j.choices?.[0]?.message?.content ?? "(empty reply)");
      finish(0);
    })
    .catch((err) => {
      broadcast(`endpoint unreachable: ${String(err)}`);
      finish(1);
    });
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
        const cfgPath = join(projectDir, "framecraft.json");
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
