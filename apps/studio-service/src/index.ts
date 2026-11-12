import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { createWriteStream, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { Storage } from "@google-cloud/storage";

/**
 * Donova Studio cloud service — runs the real rebranded Studio (the same
 * `donova studio` → `hyperframes preview` path used locally) against a project
 * tree synced with Google Cloud Storage.
 *
 * Boot:  pull projects/<prefix>/ from GCS into /tmp/studio-project
 *        spawn `donova studio <dir> --port <internal> --no-open`
 *        proxy :PORT → 127.0.0.1:<internal>  (SPA + API + SSE + media)
 * Loop:  every SYNC_MS, upload files whose mtime changed back to GCS.
 *
 * Deploy single-instance (max-instances=1) so all edits land in one tree.
 */

const BUCKET_NAME = process.env.DONOVA_BUCKET || "donova-renders-donova-514500";
const PROJECT_PREFIX = (process.env.PROJECT_PREFIX || "projects/default/").replace(/\/+$/, "") + "/";
const PROJECT_DIR = process.env.PROJECT_DIR || "/tmp/studio-project";
const INTERNAL_PORT = Number(process.env.STUDIO_INTERNAL_PORT) || 3001;
const PUBLIC_PORT = Number(process.env.PORT) || 8080;
const SYNC_MS = Number(process.env.SYNC_MS) || 8000;
const CLI_BIN = process.env.DONOVA_CLI || "/app/packages/cli/bin/donova.mjs";
const SKIP_PUSH = /(^|\/)(node_modules|\.git|dist)(\/|$)/;

const storage = new Storage();
const bucket = storage.bucket(BUCKET_NAME);

async function pullProject(): Promise<number> {
  const [files] = await bucket.getFiles({ prefix: PROJECT_PREFIX });
  let pulled = 0;
  for (const f of files) {
    const rel = f.name.slice(PROJECT_PREFIX.length);
    if (!rel) continue;
    const dest = join(PROJECT_DIR, rel);
    mkdirSync(dirname(dest), { recursive: true });
    await new Promise<void>((res, rej) => {
      f.createReadStream()
        .pipe(createWriteStream(dest))
        .on("finish", res)
        .on("error", rej);
    });
    pulled++;
  }
  return pulled;
}

async function seedIfEmpty(): Promise<void> {
  const [files] = await bucket.getFiles({ prefix: PROJECT_PREFIX, maxResults: 1 });
  if (files.length > 0) return;
  const seeds: Record<string, string> = {
    "index.html": `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Donova Studio Project</title></head>
<body><div id="root" data-composition-id="root" data-width="1080" data-height="1920"
style="width:1080px;height:1920px;background:#0a0a0f;display:flex;align-items:center;justify-content:center">
<div class="clip" data-start="0" data-duration="2.5"
style="color:#f5f1e8;font:700 72px system-ui;text-align:center">New Donova project.<br>Upload footage in Assets.</div>
</div></body></html>`,
    "style.md": "# Style Bible\n\nDescribe your editing style here. The agent reads this before every edit.\n",
    "donova.json": '{\n  "version": 1\n}\n',
    ".donova/turns.json": '{\n  "turns": []\n}\n',
  };
  for (const [k, v] of Object.entries(seeds)) {
    await bucket.file(PROJECT_PREFIX + k).save(v);
  }
}

function walkFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_PUSH.test(`${relative(base, p)}/`)) out.push(...walkFiles(p, base));
    } else if (!SKIP_PUSH.test(relative(base, p))) {
      out.push(p);
    }
  }
  return out;
}

let lastPush = Date.now();
async function pushChanges(): Promise<number> {
  const since = lastPush;
  lastPush = Date.now();
  let pushed = 0;
  for (const abs of walkFiles(PROJECT_DIR)) {
    const st = statSync(abs);
    if (st.mtimeMs < since - 1500 || st.size > 512 * 1024 * 1024) continue;
    const rel = relative(PROJECT_DIR, abs).split("\\").join("/");
    try {
      await bucket.upload(abs, { destination: PROJECT_PREFIX + rel });
      pushed++;
    } catch (err) {
      console.error(`push failed: ${rel}`, err);
    }
  }
  return pushed;
}

function waitForPort(port: number, timeoutMs = 90000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((res, rej) => {
    const tick = () => {
      const sock = connect({ host: "127.0.0.1", port }, () => {
        sock.destroy();
        res();
      });
      sock.on("error", () => {
        sock.destroy();
        if (Date.now() > deadline) rej(new Error("studio never came up"));
        else setTimeout(tick, 400);
      });
    };
    tick();
  });
}

function launchStudio(): ChildProcess {
  const child = spawn(
    process.execPath,
    [CLI_BIN, "studio", PROJECT_DIR, "--port", String(INTERNAL_PORT), "--no-open"],
    {
      env: {
        ...process.env,
        HYPERFRAMES_NO_TELEMETRY: "1",
        DO_NOT_TRACK: "1",
        BROWSER: "none",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (d) => process.stdout.write(`[studio] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[studio] ${d}`));
  return child;
}

function proxyOnce(req: IncomingMessage, res: ServerResponse) {
  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port: INTERNAL_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${INTERNAL_PORT}` },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`studio upstream error: ${err.message}`);
  });
  req.pipe(upstream);
}

async function main() {
  mkdirSync(PROJECT_DIR, { recursive: true });
  await seedIfEmpty();
  const pulled = await pullProject();
  console.log(`project materialized: ${pulled} files from gs://${BUCKET_NAME}/${PROJECT_PREFIX}`);
  lastPush = Date.now();

  launchStudio();
  await waitForPort(INTERNAL_PORT);
  console.log(`studio up on 127.0.0.1:${INTERNAL_PORT} — proxying :${PUBLIC_PORT}`);

  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, project: PROJECT_PREFIX }));
      return;
    }
    proxyOnce(req, res);
  });
  server.on("upgrade", (req, socket, head) => {
    const up = connect({ host: "127.0.0.1", port: INTERNAL_PORT }, () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n`);
      for (const [k, v] of Object.entries(req.headers)) {
        up.write(`${k}: ${Array.isArray(v) ? v.join(", ") : v ?? ""}\r\n`);
      }
      up.write("\r\n");
      if (head?.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    up.on("error", () => socket.destroy());
  });
  server.listen(PUBLIC_PORT, "0.0.0.0", () => {
    console.log(`donova-studio-service listening on :${PUBLIC_PORT}`);
  });

  setInterval(() => {
    pushChanges().then((n) => {
      if (n > 0) console.log(`synced ${n} changed file(s) → GCS`);
    });
  }, SYNC_MS).unref();

  const shutdown = async () => {
    console.log("shutdown: final push to GCS");
    try {
      await pushChanges();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("studio-service fatal:", err);
  process.exit(1);
});
