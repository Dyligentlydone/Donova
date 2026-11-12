import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
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
const GATE_SECRET = process.env.STUDIO_GATE_SECRET || "";
const SESSION_COOKIE = "__donova_session";
const WEB_APP_URL = process.env.WEB_APP_URL || "https://donova-web-712078215622.us-central1.run.app";

/**
 * Gate: only requests carrying a valid session pass to the Studio upstream.
 * The web app issues short-lived tokens via /api/studio-link; the first
 * request carries ?t=<token>, we validate + set a session cookie and 302 to
 * the clean URL. Session cookies are themselves HMAC-signed (30d).
 * Format: base64url(email|expiryMs) + "." + hmacSHA256hex(payload, secret).
 */
function sign(email: string, expiryMs: number): string {
  const payload = Buffer.from(`${email}|${expiryMs}`).toString("base64url");
  const sig = createHmac("sha256", GATE_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verify(token: string): string | null {
  if (!GATE_SECRET) return "gate-disabled";
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = createHmac("sha256", GATE_SECRET).update(payload).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const raw = Buffer.from(payload, "base64url").toString();
  const sep = raw.lastIndexOf("|");
  if (sep <= 0) return null;
  const email = raw.slice(0, sep);
  const expiry = Number(raw.slice(sep + 1));
  if (!email.includes("@") || !Number.isFinite(expiry) || expiry < Date.now()) return null;
  return email;
}

function cookieSession(req: IncomingMessage): string | null {
  const header = req.headers.cookie || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;\\s]+)`));
  return match ? verify(decodeURIComponent(match[1])) : null;
}

function gatedPage(): string {
  const pillar = (title: string, body: string) => `<div class="pillar">
  <h3>${title}</h3><p>${body}</p></div>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Donova Studio — AI Video Editor</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{box-sizing:border-box;margin:0}
  body{background:#0a0a0f;color:#f5f1e8;font:400 15px/1.65 system-ui,-apple-system,sans-serif;
       min-height:100vh}
  .wrap{max-width:960px;margin:0 auto;padding:64px 24px 80px;text-align:center}
  .logo{height:34px;width:auto;margin-bottom:26px}
  .badge{display:inline-block;padding:6px 14px;border:1px solid rgba(74,143,216,.3);
    background:rgba(74,143,216,.08);color:#4a8fd8;border-radius:99px;
    font:600 11px/1 ui-monospace,monospace;letter-spacing:.08em;margin-bottom:22px}
  h1{font-size:clamp(30px,5vw,52px);font-weight:800;letter-spacing:-.03em;
     line-height:1.08;color:#fff;margin-bottom:16px}
  h1 .gold{color:#4a8fd8}
  .sub{color:rgba(245,241,232,.55);max-width:560px;margin:0 auto 40px;font-size:16px}
  .phone{width:min(300px,72vw);margin:0 auto 14px;border-radius:28px;overflow:hidden;
    border:2px solid rgba(74,143,216,.5);box-shadow:0 0 80px rgba(74,143,216,.18);background:#000}
  .phone video{display:block;width:100%;aspect-ratio:9/16;object-fit:cover}
  .caption{color:rgba(245,241,232,.35);font:500 10px/1 ui-monospace,monospace;
    letter-spacing:.18em;margin-bottom:56px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));
    gap:16px;text-align:left;margin-bottom:56px}
  .pillar{border:1px solid rgba(255,255,255,.09);border-radius:16px;padding:20px;
    background:rgba(255,255,255,.02)}
  .pillar h3{color:#fff;font-size:15px;margin-bottom:8px}
  .pillar p{color:rgba(245,241,232,.55);font-size:13px;line-height:1.55}
  .pillar code{color:#4a8fd8;font-family:ui-monospace,monospace}
  .cta{display:inline-block;background:#4a8fd8;color:#000;font-weight:800;font-size:13px;
    letter-spacing:.12em;text-transform:uppercase;text-decoration:none;
    padding:16px 36px;border-radius:12px;margin-bottom:14px;
    box-shadow:0 0 30px rgba(74,143,216,.25)}
  .cta:hover{background:#6aa7f0}
  .member{color:rgba(245,241,232,.4);font-size:13px}
  .member a{color:#4a8fd8;text-decoration:none}
  .locked{display:inline-block;margin-left:8px;padding:3px 10px;border-radius:99px;
    border:1px solid rgba(255,255,255,.15);color:rgba(245,241,232,.5);
    font:600 10px/1.6 ui-monospace,monospace;letter-spacing:.1em}
</style></head><body><div class="wrap">
  <img class="logo" src="${WEB_APP_URL}/donova-logo.png" alt="Donova">
  <div><span class="badge">DONOVA STUDIO · YOUR AI VIDEO EDITOR · $11/MO</span></div>
  <h1>Edit videos by just<br><span class="gold">telling it what you want.</span></h1>
  <p class="sub">You're looking at Donova Studio — the actual editor, live on this URL.
  Drop in clips, describe the edit in plain English, and it cuts the pauses, adds
  captions in your style, and hands you videos ready to post. Subscribers only.</p>
  <div class="phone"><video src="${WEB_APP_URL}/demo.mp4" autoplay muted loop playsinline></video></div>
  <p class="caption">RAW CLIP → FINISHED VIDEO · WATCH IT HAPPEN</p>
  <div class="grid">
    ${pillar("Learns your style", "Show it one edit — it remembers your fonts, colors, pacing, and caption look. Every video after feels like yours.")}
    ${pillar("Text behind you", "The signature creator look — captions that slide behind your head — happens automatically. No green screen needed.")}
    ${pillar("Done in minutes", "Exports happen on our computers, not yours. Your laptop stays fast and quiet — grab a coffee, your video's ready.")}
    ${pillar("Hands-free mode", "Drop clips in a folder and walk away. Come back to finished videos ready to post.")}
  </div>
  <a class="cta" href="${WEB_APP_URL}/#pricing">Subscribe — $11/mo →</a>
  <p class="member">Already subscribed?
    <a href="${WEB_APP_URL}">Open it from your account →</a>
    <span class="locked">401 · SESSION REQUIRED</span>
  </p>
</div></body></html>`;
}

function handleGate(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, project: PROJECT_PREFIX }));
    return true;
  }
  const url = new URL(req.url || "/", "http://internal");
  const token = url.searchParams.get("t");
  if (token) {
    // owner path: the raw gate secret itself is a master token
    const email = GATE_SECRET && token === GATE_SECRET ? "owner@donova.local" : verify(token);
    if (email) {
      url.searchParams.delete("t");
      const session = sign(email, Date.now() + 30 * 24 * 60 * 60 * 1000);
      res.writeHead(302, {
        location: url.pathname + url.search,
        "set-cookie": `${SESSION_COOKIE}=${session}; Max-Age=${30 * 24 * 60 * 60}; Path=/; HttpOnly; Secure; SameSite=Lax`,
      });
      res.end();
    } else {
      res.writeHead(401, { "content-type": "text/html" });
      res.end(gatedPage());
    }
    return true;
  }
  if (cookieSession(req)) return false; // valid session → proxy through
  res.writeHead(401, { "content-type": "text/html" });
  res.end(gatedPage());
  return true;
}

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
    if (handleGate(req, res)) return;
    proxyOnce(req, res);
  });
  server.on("upgrade", (req, socket, head) => {
    if (GATE_SECRET && !cookieSession(req)) {
      socket.destroy();
      return;
    }
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
