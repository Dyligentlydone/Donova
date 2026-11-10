import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { get } from "node:http";

/**
 * Annotation sidecar — receives "draw on the frame" marks from the Studio
 * overlay and writes them into the project for the agent to consume.
 *
 * `fc studio` launches hyperframes' own preview server, whose routes we can't
 * extend, so this runs as a tiny detached server on studioPort+1000 bound to
 * localhost. The injected overlay POSTs {t, marks, note, png} → we persist
 * annotations/<slug>.json + <slug>.png. Contract: plan/19-ANNOTATE.md.
 */

const SIDECAR_PORT_OFFSET = 1000;

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

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "note"
  );
}

function handle(projectDir: string, req: IncomingMessage, res: import("node:http").ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "POST, GET, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, projectDir }));
    return;
  }
  if (req.method === "POST" && req.url === "/stop") {
    res.writeHead(200).end("bye");
    setTimeout(() => process.exit(0), 100);
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
      res.on("end", () => resolve(res.statusCode === 200 && body.includes(projectDir)));
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
  const script = join(fileURLToPath(import.meta.url));
  const child = spawn(process.execPath, [script, projectDir, String(port)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
