import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { get } from "node:http";

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
 *   GET  /agent/health              { agent: bool, cmd } — bridge configured?
 *   POST /agent/chat {message, annotation?} → { jobId } (503 when no bridge)
 *   GET  /agent/jobs/:id/stream     SSE of the agent run
 *   POST /stop                      shutdown
 *
 * Agent command resolution: framecraft.json "agent.cmd" → FC_AGENT_CMD →
 * `claude -p -` when claude is on PATH. `{prompt}` in the cmd substitutes the
 * prompt as an arg; otherwise the prompt is written to the process's stdin.
 * Contract: plan/19-ANNOTATE.md.
 */

const SIDECAR_PORT_OFFSET = 1000;
const SIDECAR_VERSION = 3;

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

function resolveAgentCmd(projectDir: string): string | null {
  try {
    const cfg = join(projectDir, "framecraft.json");
    if (existsSync(cfg)) {
      const parsed = JSON.parse(readFileSync(cfg, "utf8")) as { agent?: { cmd?: string } };
      if (parsed.agent?.cmd) return parsed.agent.cmd;
    }
  } catch {}
  if (process.env.FC_AGENT_CMD) return process.env.FC_AGENT_CMD;
  try {
    execSync("which claude", { stdio: "ignore" });
    // headless: prompt arrives on stdin; skip-permissions so it can edit files
    // without an interactive approval prompt (the user sent the request).
    return "claude -p --dangerously-skip-permissions";
  } catch {}
  return null;
}

const jobs = new Map<string, { lines: string[]; done: boolean; code: number | null; listeners: ServerResponse[] }>();

function buildPrompt(projectDir: string, body: ChatBody): string {
  let prompt = [
    `You are editing the video composition in the current directory (${projectDir}).`,
    `It is a HyperFrames/Framecraft HTML composition: timed elements carry data-start/data-duration, visuals carry class="clip", motion lives in a paused GSAP root timeline on window.__timelines. Only deterministic edits.`,
    `The user just sent this request from the Studio dashboard:`,
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

function startJob(projectDir: string, cmd: string, prompt: string): string {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job = { lines: [] as string[], done: false, code: null as number | null, listeners: [] as ServerResponse[] };
  jobs.set(id, job);
  if (jobs.size > 50) {
    const oldest = jobs.keys().next().value;
    if (oldest) jobs.delete(oldest);
  }
  const broadcast = (chunk: string) => {
    job.lines.push(chunk);
    for (const l of job.listeners) l.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };
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
    proc.on("close", (code) => {
      job.done = true;
      job.code = code;
      for (const l of job.listeners) {
        l.write(`event: done\ndata: ${JSON.stringify({ code })}\n\n`);
        l.end();
      }
      job.listeners = [];
    });
  }
  return id;
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
      const ext = rel.endsWith(".png") ? "image/png" : rel.endsWith(".json") ? "application/json" : "application/octet-stream";
      res.writeHead(200, { "content-type": ext });
      res.end(readFileSync(full));
      return;
    }
    res.writeHead(404).end("not found");
    return;
  }
  if (req.method === "GET" && req.url === "/agent/health") {
    const cmd = resolveAgentCmd(projectDir);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, agent: Boolean(cmd), cmd }));
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
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        const body = JSON.parse(raw) as ChatBody;
        const cmd = resolveAgentCmd(projectDir);
        if (!cmd) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "no-agent" }));
          return;
        }
        const jobId = startJob(projectDir, cmd, buildPrompt(projectDir, body));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, jobId, cmd }));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    });
    return;
  }
  if (req.method === "POST" && req.url === "/annotate") {
    let raw = "";
    req.on("data", (c) => (raw += c));
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
      res.on("data", (c) => (body += c));
      res.on("end", () =>
        resolve(res.statusCode === 200 && body.includes(projectDir) && body.includes(`"v":${SIDECAR_VERSION}`)),
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
    const req = get({ host: "127.0.0.1", port, path: "/stop", timeout: 800, method: "POST" }, () => resolve());
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
