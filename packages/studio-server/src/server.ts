import { execFile } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseCompositionHtml } from "@donova/contract";
import { startFileServer } from "@donova/engine";
import { lintHtml } from "@donova/lint";
import { render } from "@donova/producer";
import { getGsapSource, getRuntimeSource } from "@donova/runtime";
import * as parse5 from "parse5";
import { Agent } from "./agent.js";

/**
 * Studio server (08 §server). JSON over HTTP; no auth (local).
 *
 *   GET  /api/spec?file=index.html           → parsed CompositionSpec
 *   GET  /api/file?path=index.html           → raw file
 *   PUT  /api/file  {path, content}          → write file (byte-preserving client edits)
 *   POST /api/mutation {file, mutations:[…]} → DOM mutation via parse5 rewrite
 *   GET  /api/lint?file=index.html           → ContractIssue[]
 *   POST /api/render {composition, out, fps, quality, workers} → render
 *   GET  /api/render/:id                     → job status
 *   GET  /api/files                          → project file list
 *   GET  /api/frames?file=&t=                → capture PNG of frame at time t (thumbnails)
 *   GET  /studio/*                           → editor UI assets
 */

interface Job {
  id: string;
  status: "queued" | "rendering" | "done" | "error";
  out?: string;
  error?: string;
  progress?: [number, number];
}
const jobs = new Map<string, Job>();

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".mp4": "video/mp4",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((r) => {
    let d = "";
    req.on("data", (c) => {
      d += c;
    });
    req.on("end", () => r(d));
  });
}

function safePath(root: string, p: string): string | null {
  const f = resolve(join(root, normalize(p)));
  return f.startsWith(root + sep) || f === root ? f : null;
}

/** DOM mutation ops — byte-preserving where the change is attr-only. */
async function applyMutation(
  _file: string,
  html: string,
  mutations: Array<Record<string, unknown>>,
): Promise<string> {
  // Use parse5 to locate, then do a targeted string splice on the ORIGINAL html
  // so untouched regions keep their bytes (08 §12 undo/byte-preserving).
  const doc = parse5.parse(html, { sourceCodeLocationInfo: true });
  type El = parse5.DefaultTreeAdapterMap["element"];
  const walk = function* (n: unknown): Generator<El> {
    const node = n as {
      tagName?: string;
      childNodes?: unknown[];
      attrs?: Array<{ name: string; value: string }>;
    };
    if (node.tagName) yield node as unknown as El;
    for (const c of node.childNodes ?? []) yield* walk(c);
  };
  let out = html;
  // Apply in reverse document order so offsets stay valid.
  const edits: Array<{ start: number; end: number; text: string }> = [];
  // Pre-index timed elements for domIndex addressing.
  const timedEls = [...walk(doc)].filter((e) =>
    e.attrs?.some((a: { name: string; value: string }) => a.name === "data-start"),
  );
  for (const m of mutations) {
    if (m.op === "setAttr" && (typeof m.selector === "string" || typeof m.domIndex === "number")) {
      const targets =
        typeof m.domIndex === "number"
          ? timedEls.filter((_e, i) => i === m.domIndex)
          : [...walk(doc)].filter((e) =>
              e.attrs?.some(
                (a: { name: string; value: string }) => `[${a.name}="${a.value}"]` === m.selector,
              ),
            );
      for (const el of targets) {
        const loc = el.sourceCodeLocation;
        if (!loc?.startTag) continue;
        const attrName = String(m.attr);
        const value = String(m.value ?? "");
        const openTag = html.slice(loc.startTag.startOffset, loc.startTag.endOffset);
        const attrRe = new RegExp(`\\s${attrName}="[^"]*"`);
        let newTag: string;
        if (attrRe.test(openTag))
          newTag = openTag.replace(attrRe, ` ${attrName}="${value.replace(/"/g, "&quot;")}"`);
        else
          newTag = openTag.replace(
            /\s*\/?>$/,
            (tail) => ` ${attrName}="${value.replace(/"/g, "&quot;")}"${tail}`,
          );
        edits.push({ start: loc.startTag.startOffset, end: loc.startTag.endOffset, text: newTag });
      }
    } else if (m.op === "setText" && (typeof m.selector === "string" || typeof m.domIndex === "number")) {
      const targets =
        typeof m.domIndex === "number"
          ? timedEls.filter((_e, i) => i === m.domIndex)
          : [...walk(doc)].filter((e) =>
              e.attrs?.some(
                (a: { name: string; value: string }) => `[${a.name}="${a.value}"]` === m.selector,
              ),
            );
      for (const el of targets) {
        const loc = el.sourceCodeLocation;
        if (!loc?.startTag || !loc.endTag) continue;
        edits.push({
          start: loc.startTag.endOffset,
          end: loc.endTag.startOffset,
          text: String(m.value ?? ""),
        });
      }
    }
  }
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

export async function startStudioServer(
  projectDir: string,
  opts?: { port?: number },
): Promise<{ url: string; server: Server; compositionUrl: string }> {
  const root = resolve(projectDir);
  const compServer = await startFileServer(root); // serves the raw project for the iframe
  // UI lives in src/ui during dev; dist/ui when packaged. Check both.
  const uiCandidates = [
    fileURLToPath(new URL("../ui/", import.meta.url)),
    fileURLToPath(new URL("../src/ui/", import.meta.url)),
    fileURLToPath(new URL("../../src/ui/", import.meta.url)),
  ];
  const uiDir = uiCandidates.find((d) => existsSync(join(d, "index.html"))) ?? uiCandidates[0] ?? "";

  // --- Agent (MV6). Commands run through the donova bin so Studio reuses
  // the exact CLI surface; renderDraft goes through the in-process renderer.
  const execFileP = promisify(execFile);
  const cliBin =
    process.env.DONOVA_CLI ?? fileURLToPath(new URL("../../cli/bin/donova.mjs", import.meta.url));

  const runCmd = async (cmd: string, args: Record<string, unknown>): Promise<unknown> => {
    if (cmd === "renderDraft") {
      const r = await render({
        projectDir: root,
        composition: "index.html",
        out: join(root, "draft.mp4"),
        quality: "draft",
        workers: 1,
      });
      return r;
    }
    const POSITIONAL: Record<string, string> = {
      transcribe: "media",
      cuts: "transcript",
      scaffold: "media",
      captions: "transcript",
      probe: "media",
      add: "name",
    };
    const argv = [cliBin, cmd];
    const rest = { ...args };
    const pk = POSITIONAL[cmd];
    if (pk != null) {
      if (rest[pk] != null) argv.push(String(rest[pk]));
      delete rest[pk];
    }
    for (const [k, v] of Object.entries(rest)) {
      if (v == null || v === false) continue;
      if (v === true) argv.push(`--${k}`);
      else argv.push(`--${k}`, String(v));
    }
    argv.push("--json");
    const { stdout } = await execFileP(process.execPath, argv, { cwd: root, timeout: 300_000 });
    try {
      return JSON.parse(stdout);
    } catch {
      return { stdout };
    }
  };

  const agent = new Agent(root, {
    runCmd,
    mutateHtml: async (mutations) => {
      const fp = join(root, "index.html");
      const out = await applyMutation("index.html", await readFile(fp, "utf8"), mutations);
      await writeFile(fp, out);
    },
    readContext: async () => {
      const indexHtml = existsSync(join(root, "index.html"))
        ? await readFile(join(root, "index.html"), "utf8")
        : "";
      let duration = 0;
      try {
        duration = parseCompositionHtml(indexHtml, { path: "index.html", isRoot: true }).spec.duration;
      } catch {
        /* leave 0 */
      }
      const stylePath = join(root, "style.md");
      const files: string[] = [];
      const walk = async (d: string, prefix = ""): Promise<void> => {
        for (const e of await readdir(d, { withFileTypes: true })) {
          if (e.name.startsWith(".") || e.name === "node_modules") continue;
          const rel = prefix ? `${prefix}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(join(d, e.name), rel);
          else files.push(rel);
        }
      };
      await walk(root);
      return {
        indexHtml,
        styleMd: existsSync(stylePath) ? await readFile(stylePath, "utf8") : null,
        files,
        duration,
      };
    },
  });
  await agent.load();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    const send = (code: number, body: unknown, type = "application/json") => {
      res.writeHead(code, { "Content-Type": type, "Access-Control-Allow-Origin": "*" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (req.method === "OPTIONS") return send(204, "");
    try {
      // --- API ---
      if (p === "/api/spec") {
        const f = url.searchParams.get("file") ?? "index.html";
        const fp = safePath(root, f);
        if (!fp || !existsSync(fp)) return send(404, { error: "not found" });
        const { spec } = parseCompositionHtml(await readFile(fp, "utf8"), { path: f, isRoot: true });
        // Same-origin /project URL so the UI can reach into the iframe (renderSeek, spec).
        return send(200, { spec, compositionUrl: `/project/${f}` });
      }
      if (p === "/api/file" && req.method === "GET") {
        const fp = safePath(root, url.searchParams.get("path") ?? "");
        if (!fp || !existsSync(fp)) return send(404, { error: "not found" });
        return send(200, { path: url.searchParams.get("path"), content: await readFile(fp, "utf8") });
      }
      if (p === "/api/file" && req.method === "PUT") {
        const body = JSON.parse(await readBody(req)) as { path: string; content: string };
        const fp = safePath(root, body.path);
        if (!fp) return send(403, { error: "forbidden" });
        await writeFile(fp, body.content);
        return send(200, { ok: true });
      }
      if (p === "/api/mutation" && req.method === "POST") {
        const body = JSON.parse(await readBody(req)) as {
          file: string;
          mutations: Array<Record<string, unknown>>;
        };
        const fp = safePath(root, body.file);
        if (!fp || !existsSync(fp)) return send(404, { error: "not found" });
        const html = await readFile(fp, "utf8");
        const out = await applyMutation(body.file, html, body.mutations);
        await writeFile(fp, out);
        return send(200, { ok: true, bytes: out.length });
      }
      if (p === "/api/lint") {
        const f = url.searchParams.get("file") ?? "index.html";
        const fp = safePath(root, f);
        if (!fp || !existsSync(fp)) return send(404, { error: "not found" });
        const { issues } = lintHtml(await readFile(fp, "utf8"), { path: f, isRoot: true });
        return send(200, { issues });
      }
      if (p === "/api/render" && req.method === "POST") {
        const body = JSON.parse(await readBody(req)) as {
          composition?: string;
          out?: string;
          fps?: number;
          quality?: "draft" | "standard" | "high";
          workers?: number;
        };
        const id = `job-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const job: Job = { id, status: "queued" };
        jobs.set(id, job);
        void (async () => {
          job.status = "rendering";
          try {
            const r = await render({
              projectDir: root,
              composition: body.composition ?? "index.html",
              out: body.out ?? join(root, "out.mp4"),
              fps: body.fps,
              quality: body.quality ?? "standard",
              workers: body.workers ?? 1,
              onProgress: (d, t) => {
                job.progress = [d, t];
              },
            });
            job.status = "done";
            job.out = r.out;
          } catch (e) {
            job.status = "error";
            job.error = String(e);
          }
        })();
        return send(202, { id });
      }
      if (p.startsWith("/api/render/")) {
        const job = jobs.get(p.slice("/api/render/".length));
        return job ? send(200, job) : send(404, { error: "no job" });
      }
      // --- Agent chat (MV6) ---
      if (p === "/api/chat" && req.method === "POST") {
        const body = JSON.parse(await readBody(req)) as { message?: string };
        if (!body.message?.trim()) return send(400, { error: "message required" });
        const turn = await agent.chat(body.message.trim());
        return send(200, turn);
      }
      if (p === "/api/undo" && req.method === "POST") {
        return send(200, await agent.undo());
      }
      if (p === "/api/turns") {
        return send(200, { turns: agent.historyTurns });
      }
      if (p === "/api/style" && req.method === "GET") {
        const fp = join(root, "style.md");
        return send(
          200,
          existsSync(fp)
            ? { path: "style.md", content: await readFile(fp, "utf8") }
            : { path: "style.md", content: null },
        );
      }
      if (p === "/api/style" && req.method === "PUT") {
        const body = JSON.parse(await readBody(req)) as { content: string };
        await writeFile(join(root, "style.md"), body.content);
        return send(200, { ok: true });
      }
      if (p === "/api/assets") {
        const media: string[] = [];
        const blocks: string[] = [];
        const list = async (d: string, into: string[]) => {
          if (!existsSync(d)) return;
          for (const e of await readdir(d, { withFileTypes: true })) {
            if (e.name.startsWith(".")) continue;
            if (e.isDirectory()) await list(join(d, e.name), into);
            else into.push(join(d, e.name).slice(root.length + 1));
          }
        };
        await list(join(root, "media"), media);
        for (const e of await readdir(join(root, "compositions")).catch(() => [])) {
          if (typeof e === "string" && !e.startsWith(".")) blocks.push(e);
        }
        return send(200, { media, blocks, style: existsSync(join(root, "style.md")) });
      }
      if (p === "/api/files") {
        const walk = async (d: string, prefix = ""): Promise<string[]> => {
          const out: string[] = [];
          for (const e of await readdir(d, { withFileTypes: true })) {
            if (e.name.startsWith(".") || e.name === "node_modules") continue;
            const rel = prefix ? `${prefix}/${e.name}` : e.name;
            if (e.isDirectory()) out.push(...(await walk(join(d, e.name), rel)));
            else out.push(rel);
          }
          return out;
        };
        return send(200, { files: await walk(root) });
      }

      // --- Composition preview (same-origin proxy → project file server).
      // HTML responses get the runtime injected so the iframe exposes __fc/__playerReady.
      if (p === "/__fc-runtime.js") {
        return send(200, getRuntimeSource(), "text/javascript; charset=utf-8");
      }
      if (p === "/__fc-gsap.js" || p === "/project/__fc-gsap.js") {
        return send(200, getGsapSource(), "text/javascript; charset=utf-8");
      }
      if (p === "/project" || p.startsWith("/project/")) {
        const rel = decodeURIComponent(p.slice("/project".length) || "/index.html");
        const up = await fetch(`${compServer.url}${rel}`, {
          headers: req.headers.range ? { range: req.headers.range } : {},
        });
        const type = up.headers.get("content-type") ?? "application/octet-stream";
        const headers: Record<string, string | undefined> = {
          "Content-Type": type,
          "Cache-Control": "no-store",
        };
        for (const h of ["content-range", "accept-ranges", "content-length"]) {
          const v = up.headers.get(h);
          if (v) headers[h] = v;
        }
        if (type.includes("text/html")) {
          let html = await up.text();
          const tag = '<script src="/__fc-runtime.js"></script>';
          html = html.includes("/__fc-runtime.js") ? html : html.replace(/<\/head>/i, `${tag}\n</head>`);
          Reflect.deleteProperty(headers, "content-length");
          res.writeHead(up.status, headers);
          res.end(html);
          return;
        }
        res.writeHead(up.status, headers);
        if (up.body) {
          const { Readable } = await import("node:stream");
          Readable.fromWeb(up.body as import("node:stream/web").ReadableStream).pipe(res);
        } else res.end();
        return;
      }

      // --- Studio UI assets ---
      if (p === "/" || p === "/studio" || p === "/studio/") {
        const ui = join(uiDir, "index.html");
        return send(
          200,
          existsSync(ui) ? await readFile(ui, "utf8") : "<h1>studio ui missing</h1>",
          "text/html",
        );
      }
      if (p.startsWith("/studio/")) {
        const fp = join(uiDir, p.slice("/studio/".length));
        if (existsSync(fp)) {
          res.writeHead(200, { "Content-Type": MIME[extname(fp)] ?? "application/octet-stream" });
          createReadStream(fp).pipe(res);
          return;
        }
      }
      send(404, { error: "not found", path: p });
    } catch (e) {
      send(500, { error: String(e) });
    }
  });
  const port = opts?.port ?? 0;
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const addr = server.address();
  const bound = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${bound}`,
    server,
    compositionUrl: `http://127.0.0.1:${bound}/project/index.html`,
  };
}
