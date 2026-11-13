import { type ChildProcess, spawn } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { Storage } from "@google-cloud/storage";

/**
 * Donova Studio cloud service — runs the real rebranded Studio (the same
 * `donova studio` → `hyperframes preview` path used locally) against per-user
 * project trees synced with Google Cloud Storage.
 *
 * Accounts: the session cookie carries the user's email → uid → one instance:
 *   projects/<uid>/ in GCS  ⇄  /tmp/users/<uid>/  ⇄  `donova studio` on its own port
 * Instances lazy-boot on first Studio request, sync every SYNC_MS, and are
 * reaped after IDLE_MS (or LRU-evicted past MAX_INSTANCES).
 *
 * Deploy single-instance (max-instances=1) so the supervisor owns all trees.
 */

const BUCKET_NAME = process.env.DONOVA_BUCKET || "donova-renders-donova-514500";
const USER_ROOT = process.env.USER_ROOT || "/tmp/donova-users";
const BASE_PORT = Number(process.env.STUDIO_INTERNAL_PORT) || 3100;
const MAX_INSTANCES = Number(process.env.MAX_INSTANCES) || 8;
const IDLE_MS = Number(process.env.IDLE_MS) || 20 * 60 * 1000;
const PUBLIC_PORT = Number(process.env.PORT) || 8080;
const SYNC_MS = Number(process.env.SYNC_MS) || 8000;
const CLI_BIN = process.env.DONOVA_CLI || "/app/packages/cli/bin/donova.mjs";

/** hyperframes CLI bin, resolved relative to the donova CLI's deps. */
const HF_BIN = (() => {
  try {
    const req = createRequire(CLI_BIN);
    const pkg = req.resolve("hyperframes/package.json");
    return join(dirname(pkg), "bin", "hyperframes.mjs");
  } catch {
    return "hyperframes"; // PATH fallback
  }
})();
console.log(`hyperframes bin: ${HF_BIN}`);

let rebrandApplied = false;
/** Patch the bundled studio SPA once (Donova branding) — same patch
 * `donova studio` applies, imported from the CLI's built chunk. */
async function applyRebrand(): Promise<void> {
  if (rebrandApplied) return;
  try {
    const dist = join(dirname(CLI_BIN), "..", "dist");
    const chunk = readdirSync(dist).find((f) => /^rebrand-.+\.js$/.test(f));
    if (!chunk) return;
    const mod = (await import(join(dist, chunk))) as { rebrandStudioUi?: () => boolean };
    rebrandApplied = mod.rebrandStudioUi?.() ?? false;
    if (rebrandApplied) console.log("studio bundle rebranded");
  } catch (err) {
    console.error("rebrand failed:", err);
  }
}
const SKIP_PUSH = /(^|\/)(node_modules|\.git|dist)(\/|$)/;
const GATE_SECRET = process.env.STUDIO_GATE_SECRET || "";
const USER_FOLDERS = ["inspo", "raw footage", "donova videos"] as const;
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

/** Decoded gate/session token: email + optional session-expiry hint (trial end). */
interface TokenInfo {
  email: string;
  sessionExp?: number;
}

function verify(token: string): TokenInfo | null {
  if (!GATE_SECRET) return null; // fail closed — never silently open the gate
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = createHmac("sha256", GATE_SECRET).update(payload).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const parts = Buffer.from(payload, "base64url").toString().split("|");
  if (parts.length < 2) return null;
  const email = parts[0];
  const expiry = Number(parts[1]);
  const sessionExp = parts.length > 2 ? Number(parts[2]) : undefined;
  if (!email.includes("@") || !Number.isFinite(expiry) || expiry < Date.now()) return null;
  return { email, sessionExp: Number.isFinite(sessionExp) ? sessionExp : undefined };
}

function cookieSession(req: IncomingMessage): TokenInfo | null {
  if (!GATE_SECRET) return null;
  const header = req.headers.cookie || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;\\s]+)`));
  return match ? verify(decodeURIComponent(match[1])) : null;
}

/* ------------------------- per-user instances ---------------------------- */

/** email → stable, path-safe user id. Owner + dev mode keep the legacy tree. */
function uidFor(email: string): string {
  if (email === "owner@donova.local" || email === "gate-disabled") return "default";
  return `u-${createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 12)}`;
}

interface UserInstance {
  uid: string;
  prefix: string; // projects/<uid>/
  dir: string; // /tmp/users/<uid>
  port: number;
  proc?: ChildProcess;
  sidecar?: ChildProcess;
  booted: boolean;
  boot?: Promise<void>;
  pushing?: boolean;
  /** Rel paths seen locally at materialize or pushed since — the delete baseline. */
  knownPaths: Set<string>;
  lastTouched: number;
  lastPush: number;
}

const instances = new Map<string, UserInstance>();
let nextPort = BASE_PORT;

function instanceFor(email: string): UserInstance {
  const uid = uidFor(email);
  let inst = instances.get(uid);
  if (!inst) {
    inst = {
      uid,
      prefix: `projects/${uid}/`,
      dir: join(USER_ROOT, uid),
      port: nextPort++,
      booted: false,
      knownPaths: new Set<string>(),
      lastTouched: Date.now(),
      lastPush: Date.now(),
    };
    instances.set(uid, inst);
  }
  inst.lastTouched = Date.now();
  return inst;
}

/** Materialize (or seed) the user's tree and boot their preview server. */
function ensureInstance(inst: UserInstance): Promise<void> {
  if (inst.booted) return Promise.resolve();
  if (inst.boot) return inst.boot;
  inst.boot = (async () => {
    await evictIfNeeded();
    mkdirSync(inst.dir, { recursive: true });
    await seedIfEmpty(inst.prefix);
    await ensureUserFolders(inst.prefix, inst.dir);
    const pulled = await pullProject(inst.prefix, inst.dir);
    inst.knownPaths = new Set(walkFiles(inst.dir).map((p) => relative(inst.dir, p).split("\\").join("/")));
    console.log(`[${inst.uid}] materialized ${pulled} files`);
    inst.proc = launchStudio(inst);
    inst.lastPush = Date.now();
    await waitForPort(inst.port, 240000).catch((err) => {
      dumpDaemonLog();
      throw err;
    });
    inst.sidecar = launchAnnotate(inst);
    inst.booted = true;
    console.log(`[${inst.uid}] studio up on 127.0.0.1:${inst.port}`);
  })().finally(() => {
    inst.boot = undefined;
  });
  return inst.boot;
}

/** Graceful instance stop: final push, kill preview, drop the tree + port. */
async function stopInstance(inst: UserInstance): Promise<void> {
  inst.booted = false;
  try {
    await pushChanges(inst);
  } catch (err) {
    console.error(`[${inst.uid}] final push failed:`, err);
  }
  try {
    inst.proc?.kill("SIGTERM");
    inst.sidecar?.kill("SIGTERM");
  } catch {
    /* already dead */
  }
  try {
    rmSync(inst.dir, { recursive: true, force: true });
  } catch {
    /* dir may not exist */
  }
  instances.delete(inst.uid);
  console.log(`[${inst.uid}] instance stopped`);
}

async function evictIfNeeded(): Promise<void> {
  const live = [...instances.values()].filter((i) => i.booted || i.boot);
  if (live.length < MAX_INSTANCES) return;
  live.sort((a, b) => a.lastTouched - b.lastTouched);
  const victim = live.find((i) => i.uid !== "default") ?? live[0];
  console.log(`evicting idle instance ${victim.uid} (cap ${MAX_INSTANCES})`);
  await stopInstance(victim);
}

/** Reap instances idle longer than IDLE_MS. */
function reapIdle(): void {
  for (const inst of instances.values()) {
    if ((inst.booted || inst.boot) && Date.now() - inst.lastTouched > IDLE_MS) {
      console.log(`[${inst.uid}] idle ${Math.round((Date.now() - inst.lastTouched) / 60000)}m — reaping`);
      void stopInstance(inst);
    }
  }
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

/** Injected into upstream HTML pages: clicking the donova wordmark goes home
 * to the workspace. Cloud-only — the local rebrand patcher is untouched. */
const LOGO_HOME_SNIPPET = `<script>
document.addEventListener('click',function(e){
  var n=e.target;
  if(n.closest&&n.closest('img[alt="donova"]')){e.preventDefault();location.href='/';return;}
  while(n&&n!==document){
    if(n.tagName==='SPAN'&&n.textContent&&n.textContent.trim()==='donova'){location.href='/';return;}
    n=n.parentElement;
  }
},true);
</script><style>img[alt="donova"]{cursor:pointer}</style>
`;

function desktopPage(email: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Donova — Your Workspace</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{box-sizing:border-box;margin:0}
  body{background:#0a0a0f;color:#f5f1e8;font:400 15px/1.65 system-ui,-apple-system,sans-serif;min-height:100vh}
  .wrap{max-width:1040px;margin:0 auto;padding:48px 24px 80px}
  .top{display:flex;align-items:center;justify-content:space-between;margin-bottom:44px}
  .top img{height:30px;width:auto}
  .top .hint{color:rgba(245,241,232,.4);font-size:12px;font-family:ui-monospace,monospace;letter-spacing:.1em}
  .hero{display:flex;align-items:center;justify-content:space-between;gap:24px;
    border:1px solid rgba(74,143,216,.35);border-radius:20px;padding:28px 30px;margin-bottom:28px;
    background:linear-gradient(135deg,rgba(74,143,216,.12),rgba(74,143,216,.03))}
  .hero h1{font-size:26px;font-weight:800;letter-spacing:-.02em;color:#fff;margin-bottom:6px}
  .hero p{color:rgba(245,241,232,.55);font-size:14px}
  .open{background:#4a8fd8;color:#0a0a0f;font-weight:800;font-size:13px;letter-spacing:.12em;
    text-transform:uppercase;text-decoration:none;padding:16px 30px;border-radius:12px;white-space:nowrap;
    box-shadow:0 0 30px rgba(74,143,216,.3)}
  .open:hover{background:#6aa7f0}
  .folders{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:22px}
  .folder{display:flex;flex-direction:column;align-items:center;gap:4px;user-select:none}
  .folder .ico{width:128px;height:auto;cursor:pointer;transition:transform .12s,filter .12s;
    filter:drop-shadow(0 6px 14px rgba(0,0,0,.45))}
  .folder:hover .ico{transform:scale(1.04)}
  .folder.over .ico{transform:scale(1.08);
    filter:drop-shadow(0 0 22px rgba(122,178,255,.55))}
  .folder.busy .ico{opacity:.55;transform:none}
  .folder .lbl{color:#fff;font-size:14px;font-weight:600;letter-spacing:-.01em;
    text-shadow:0 1px 3px rgba(0,0,0,.7);cursor:pointer}
  .folder .cnt{color:rgba(245,241,232,.45);font-size:11px;font-family:ui-monospace,monospace;
    letter-spacing:.06em;min-height:14px}
  .files{list-style:none;padding:6px 0;margin-top:8px;width:100%;overflow-y:auto;max-height:190px;
    border-top:1px solid rgba(255,255,255,.07)}
  .files li{display:flex;align-items:center;gap:10px;padding:8px 10px;font-size:13px;
    color:rgba(245,241,232,.75);border-radius:8px}
  .files li:hover{background:rgba(255,255,255,.03)}
  .files .name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .files .sz{color:rgba(245,241,232,.3);font-size:11px;font-family:ui-monospace,monospace;white-space:nowrap}
  .files a.dl{color:#4a8fd8;text-decoration:none;font-size:11px;font-weight:700;
    letter-spacing:.08em;white-space:nowrap}
  .files a.dl:hover{color:#6aa7f0}
  .empty{padding:20px 12px;color:rgba(245,241,232,.32);font-size:12.5px;text-align:center}
  .folder input{display:none}
  .other{margin-top:26px}
  .other summary{cursor:pointer;color:rgba(245,241,232,.5);font-size:13px;margin-bottom:8px}
  .foot{margin-top:40px;color:rgba(245,241,232,.3);font-size:12px;text-align:center}
</style></head><body><div class="wrap">
  <div class="top">
    <img src="${WEB_APP_URL}/donova-logo.png" alt="Donova">
    <span class="hint">${email === "owner@donova.local" ? "YOUR WORKSPACE" : `YOUR WORKSPACE · ${email}`}</span>
  </div>
  <div class="hero">
    <div>
      <h1>Your video workspace</h1>
      <p>Drop raw clips on <b>Raw Footage</b>, style references on <b>Inspo</b> —
      finished videos land in <b>Donova Videos</b>. Click any folder to browse your computer.</p>
    </div>
    <a class="open" href="/studio">Open Studio →</a>
  </div>
  <svg width="0" height="0" style="position:absolute"><defs>
    <linearGradient id="gBack" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4f93da"/><stop offset="1" stop-color="#3a76bb"/>
    </linearGradient>
    <linearGradient id="gFront" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7fb4ea"/><stop offset=".12" stop-color="#6ba3e2"/><stop offset="1" stop-color="#4a87d2"/>
    </linearGradient>
  </defs></svg>
  <div class="folders" id="folders"></div>
  <template id="tpl-folder">
    <div class="folder">
      <svg class="ico" viewBox="0 0 128 104">
        <path d="M14 34 L14 20 Q14 12 22 12 L46 12 L56 20 L106 20 Q114 20 114 28 L114 40 L14 40 Z" fill="url(#gBack)"/>
        <rect x="6" y="30" width="116" height="66" rx="10" fill="url(#gFront)" stroke="rgba(0,0,0,0.14)" stroke-width="1.5"/>
        <rect x="6" y="30" width="116" height="11" rx="5.5" fill="rgba(255,255,255,0.14)"/>
      </svg>
      <span class="lbl"></span>
      <span class="cnt"></span>
      <input type="file" accept="video/*" multiple>
      <ul class="files"></ul>
    </div>
  </template>
  <details class="other"><summary>Project files</summary><ul class="files" id="f-other"></ul></details>
  <p class="foot">Files sync automatically while Studio is open.</p>
</div>
<script>
if(location.hash&&location.hash.indexOf('#project')===0){location.replace('/studio'+location.hash);}
var esc=function(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML;};
var fmt=function(n){return n>1e9?(n/1e9).toFixed(1)+' GB':n>1e6?(n/1e6).toFixed(1)+' MB':n>1e3?(n/1e3).toFixed(0)+' KB':n+' B';};
function item(f,dl){
  return '<li><span class="name">'+esc(f.rel.slice(f.rel.indexOf('/')+1))+'</span>'+
    '<span class="sz">'+fmt(f.size)+'</span>'+
    (dl?'<a class="dl" href="/api/desktop/download?rel='+encodeURIComponent(f.rel)+'">DOWNLOAD</a>':'')+'</li>';
}
var FOLDERS=[
  {key:'raw footage',label:'Raw Footage',hint:'Drop clips here or click to browse — everything you film lives in this folder.'},
  {key:'inspo',label:'Inspo',hint:'Videos whose style you love — your agent learns from these.'},
  {key:'donova videos',label:'Donova Videos',hint:'Finished videos land here — download and post.',downloads:true},
];
var tpl=document.getElementById('tpl-folder'),mount=document.getElementById('folders'),nodes={};
FOLDERS.forEach(function(fd){
  var node=tpl.content.firstElementChild.cloneNode(true);
  node.dataset.folder=fd.key;
  node.querySelector('.lbl').textContent=fd.label;
  var pick=node.querySelector('input'),cnt=node.querySelector('.cnt'),list=node.querySelector('.files');
  list.innerHTML='<li class="empty">'+fd.hint+'</li>';
  function send(file){
    node.classList.add('busy');cnt.textContent='uploading '+file.name+'…';
    fetch('/api/desktop/upload?name='+encodeURIComponent(file.name)+'&folder='+encodeURIComponent(fd.key),{method:'POST',body:file})
      .then(function(){node.classList.remove('busy');paint();})
      .catch(function(){node.classList.remove('busy');cnt.textContent='upload failed — try again';});
  }
  node.querySelector('.ico').addEventListener('click',function(){pick.click();});
  node.querySelector('.lbl').addEventListener('click',function(){pick.click();});
  pick.addEventListener('change',function(){Array.from(pick.files).forEach(send);pick.value='';});
  ['dragover','dragenter'].forEach(function(ev){node.addEventListener(ev,function(e){e.preventDefault();node.classList.add('over');});});
  ['dragleave','drop'].forEach(function(ev){node.addEventListener(ev,function(e){e.preventDefault();node.classList.remove('over');
    if(ev==='drop'&&e.dataTransfer&&e.dataTransfer.files)Array.from(e.dataTransfer.files).forEach(send);});});
  mount.appendChild(node);nodes[fd.key]={cnt:cnt,list:list,dl:!!fd.downloads};
});
function paint(){
  fetch('/api/desktop/files').then(function(r){return r.json();}).then(function(d){
    var groups={};Object.keys(nodes).forEach(function(k){groups[k]=[];});
    var other=[];
    (d.files||[]).forEach(function(f){
      if(groups[f.folder])groups[f.folder].push(f);
      else if(f.rel.indexOf('renders/')===0)groups['donova videos'].push(f);
      else other.push(f);
    });
    Object.keys(nodes).forEach(function(k){
      var n=nodes[k],fs=groups[k];
      n.cnt.textContent=fs.length===1?'1 item':fs.length+' items';
      if(fs.length)n.list.innerHTML=fs.map(function(f){return item(f,n.dl);}).join('');
    });
    document.getElementById('f-other').innerHTML=other.map(function(f){return item(f,false);}).join('')||'<li class="empty">Nothing yet.</li>';
  });
}
paint();
</script></body></html>`;
}

/**
 * Returns the caller's identity when authenticated, or null after having
 * fully handled the request (health check, token exchange redirect, or the
 * 401 gate page).
 */
function handleGate(req: IncomingMessage, res: ServerResponse): TokenInfo | null {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, instances: instances.size }));
    return null;
  }
  if (!GATE_SECRET) {
    // Fail closed: a missing secret must never expose every user's tree.
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("gate misconfigured");
    return null;
  }
  const url = new URL(req.url || "/", "http://internal");
  const token = url.searchParams.get("t");
  if (token) {
    // owner path: the raw gate secret itself is a master token
    const info: TokenInfo | null =
      GATE_SECRET && token === GATE_SECRET ? { email: "owner@donova.local" } : verify(token);
    if (info) {
      url.searchParams.delete("t");
      // session lives until the token's sessionExp hint (trial end) or 30d, whichever is sooner
      const sessionExp = Math.min(
        info.sessionExp ?? Number.POSITIVE_INFINITY,
        Date.now() + 30 * 24 * 60 * 60 * 1000,
      );
      const maxAge = Math.max(1, Math.floor((sessionExp - Date.now()) / 1000));
      const session = sign(info.email, sessionExp);
      res.writeHead(302, {
        location: url.pathname + url.search,
        "set-cookie": `${SESSION_COOKIE}=${session}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`,
      });
      res.end();
    } else {
      res.writeHead(401, { "content-type": "text/html" });
      res.end(gatedPage());
    }
    return null;
  }
  const session = cookieSession(req);
  if (session) return session; // valid session → continue to routing
  res.writeHead(401, { "content-type": "text/html" });
  res.end(gatedPage());
  return null;
}

/** Per-upload ceiling — /tmp is RAM-backed and shared by every user's
 * preview process, so one oversized file could OOM the whole container.
 * 2GB covers multi-minute phone clips while leaving headroom. */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

interface ProjectFile {
  key: string;
  rel: string;
  folder: string;
  size: number;
  updated: string;
}

async function listProjectTree(prefix: string): Promise<ProjectFile[]> {
  const [files] = await bucket.getFiles({ prefix });
  return files
    .map((f) => {
      const rel = f.name.slice(prefix.length);
      const folder = rel.includes("/") ? rel.slice(0, rel.indexOf("/")) : "";
      return {
        key: f.name,
        rel,
        folder,
        size: Number(f.metadata.size ?? 0),
        updated: f.metadata.updated ?? "",
      };
    })
    .filter(
      (f) =>
        f.rel &&
        !f.rel.endsWith("/") &&
        !f.rel.startsWith(".") &&
        !(f.rel.split("/").pop() || "").startsWith("."),
    )
    .sort((a, b) => b.updated.localeCompare(a.updated));
}

async function handleDesktopApi(
  req: IncomingMessage,
  res: ServerResponse,
  inst: UserInstance,
): Promise<boolean> {
  const url = new URL(req.url || "/", "http://internal");
  if (url.pathname === "/api/desktop/files" && req.method === "GET") {
    let files = await listProjectTree(inst.prefix);
    if (files.length === 0) {
      // brand-new account — seed the project + folders at first desktop view,
      // not just at first Studio boot
      await seedIfEmpty(inst.prefix);
      await ensureUserFolders(inst.prefix, inst.dir);
      files = await listProjectTree(inst.prefix);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ files }));
    return true;
  }
  if (url.pathname === "/api/desktop/upload" && req.method === "POST") {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_UPLOAD_BYTES) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "file too large (2GB max)" }));
      req.destroy();
      return true;
    }
    const name = (url.searchParams.get("name") || `clip-${Date.now()}.mp4`)
      .replace(/[/\\]+/g, "-")
      .slice(0, 140);
    const folderParam = url.searchParams.get("folder") || "raw footage";
    const folder = (USER_FOLDERS as readonly string[]).includes(folderParam) ? folderParam : "raw footage";
    const rel = `${folder}/${name}`;
    const dest = join(inst.dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    let received = 0;
    let tooBig = false;
    try {
      await new Promise<void>((ok, fail) => {
        const w = createWriteStream(dest);
        req.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_UPLOAD_BYTES && !tooBig) {
            tooBig = true;
            req.destroy();
            w.destroy();
            fail(new Error("file too large (2GB max)"));
          }
        });
        req.pipe(w).on("finish", ok).on("error", fail);
      });
    } catch {
      rmSync(dest, { force: true });
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "file too large (2GB max)" }));
      return true;
    }
    try {
      await bucket.upload(dest, { destination: inst.prefix + rel });
    } catch (err) {
      console.error("upload push failed:", err);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rel }));
    return true;
  }
  if (url.pathname === "/api/desktop/download" && req.method === "GET") {
    const rel = url.searchParams.get("rel") || "";
    if (!rel || rel.includes("..")) {
      res.writeHead(400).end("bad rel");
      return true;
    }
    const [signed] = await bucket.file(inst.prefix + rel).getSignedUrl({
      action: "read",
      expires: Date.now() + 15 * 60 * 1000,
    });
    res.writeHead(302, { location: signed });
    res.end();
    return true;
  }
  return false;
}

const storage = new Storage();
const bucket = storage.bucket(BUCKET_NAME);

async function pullProject(prefix: string, dir: string): Promise<number> {
  const [files] = await bucket.getFiles({ prefix });
  let pulled = 0;
  for (const f of files) {
    const rel = f.name.slice(prefix.length);
    if (!rel) continue;
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    await new Promise<void>((res, rej) => {
      f.createReadStream().pipe(createWriteStream(dest)).on("finish", res).on("error", rej);
    });
    pulled++;
  }
  return pulled;
}

async function seedIfEmpty(prefix: string): Promise<void> {
  const [files] = await bucket.getFiles({ prefix, maxResults: 1 });
  if (files.length > 0) return;
  const seeds: Record<string, string> = {
    "index.html": `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Donova Studio Project</title></head>
<body><div id="root" data-composition-id="root" data-width="1080" data-height="1920"
style="width:1080px;height:1920px;background:#0a0a0f;display:flex;align-items:center;justify-content:center">
<div class="clip" data-start="0" data-duration="2.5"
style="color:#f5f1e8;font:700 72px system-ui;text-align:center">New Donova project.<br>Upload footage in Assets.</div>
</div></body></html>`,
    "style.md":
      "# Style Bible\n\nDescribe your editing style here. The agent reads this before every edit.\n",
    "donova.json": '{\n  "version": 1\n}\n',
    ".donova/turns.json": "[]\n",
  };
  for (const [k, v] of Object.entries(seeds)) {
    await bucket.file(prefix + k).save(v);
  }
}

/** Keep the local-machine folder names users already know from `donova init`:
 * inspo/ · raw footage/ · donova videos/ — as real dirs in /tmp and .keep
 * markers in GCS so the folders survive re-materialization. */
async function ensureUserFolders(prefix: string, dir: string): Promise<void> {
  for (const name of USER_FOLDERS) {
    mkdirSync(join(dir, name), { recursive: true });
    const key = `${prefix}${name}/.keep`;
    const [exists] = await bucket.file(key).exists();
    if (!exists) await bucket.file(key).save("donova user folder\n");
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

async function pushChanges(inst: UserInstance): Promise<number> {
  if (inst.pushing) return 0; // a big upload can outlive a sync tick — skip overlapping runs
  inst.pushing = true;
  try {
    const since = inst.lastPush;
    inst.lastPush = Date.now();
    let files: string[];
    try {
      files = walkFiles(inst.dir);
    } catch (err) {
      console.error(`[${inst.uid}] walk failed — skipping push`, err);
      return 0;
    }
    const current = new Set<string>();
    let pushed = 0;
    for (const abs of files) {
      const rel = relative(inst.dir, abs).split("\\").join("/");
      current.add(rel);
      const st = statSync(abs);
      if (st.mtimeMs < since - 1500) continue;
      try {
        await bucket.upload(abs, { destination: inst.prefix + rel });
        pushed++;
      } catch (err) {
        console.error(`[${inst.uid}] push failed: ${rel}`, err);
      }
    }
    // Propagate deletes: paths known locally that are now gone get removed from
    // GCS too, so they don't resurrect on the next materialization. Skipped
    // entirely when the local tree is empty — a wiped /tmp must never nuke GCS.
    if (current.size > 0) {
      let deleted = 0;
      for (const rel of inst.knownPaths) {
        if (current.has(rel)) continue;
        try {
          await bucket.file(inst.prefix + rel).delete();
          deleted++;
        } catch (err) {
          console.error(`[${inst.uid}] delete failed: ${rel}`, err);
        }
      }
      if (deleted) console.log(`[${inst.uid}] propagated ${deleted} deletes`);
    }
    inst.knownPaths = current;
    return pushed;
  } finally {
    inst.pushing = false;
  }
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

/**
 * Spawn the real Studio preview server directly — `hyperframes preview
 * --foreground` binds the port in-process. We deliberately skip the
 * `donova studio` wrapper: its `--background` path daemonizes and upstream
 * readiness detection gives up after ~10s, which cold container boots
 * exceed. Owning the process also makes idle reaping a clean SIGTERM.
 */
function launchStudio(inst: UserInstance): ChildProcess {
  const child = spawn(
    process.execPath,
    [HF_BIN, "preview", inst.dir, "--port", String(inst.port), "--no-open", "--foreground"],
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
  child.stdout?.on("data", (d) => process.stdout.write(`[studio:${inst.uid}] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[studio:${inst.uid}] ${d}`));
  child.on("error", (err) => {
    console.error(`[studio:${inst.uid}] preview spawn failed:`, err.message);
    if (inst.proc === child) inst.booted = false;
  });
  child.on("exit", (code, sig) => {
    console.log(`[studio:${inst.uid}] preview exited code=${code} sig=${sig}`);
    if (inst.proc === child) inst.booted = false;
  });
  return child;
}

/** Frame-annotation sidecar (the same one `donova studio` spawns on
 * studioPort+1000) — best-effort; Studio works without it. */
function launchAnnotate(inst: UserInstance): ChildProcess | undefined {
  try {
    const dist = join(dirname(CLI_BIN), "..", "dist");
    const chunk = readdirSync(dist).find((f) => /^annotate-.+\.js$/.test(f));
    if (!chunk) return undefined;
    return spawn(process.execPath, [join(dist, chunk), inst.dir, String(inst.port + 1000)], {
      env: { ...process.env, DONOVA_BIN: CLI_BIN },
      stdio: "ignore",
    });
  } catch {
    return undefined;
  }
}

/** The preview daemon logs to the hyperframes state dir, not the project
 * tree — dump the newest log's tail so boot failures are diagnosable. */
function dumpDaemonLog(): void {
  try {
    const dir = join(homedir(), ".local", "state", "hyperframes", "previews");
    const logs = readdirSync(dir)
      .filter((f) => f.endsWith(".log"))
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (!logs.length) {
      console.error("no daemon logs found");
      return;
    }
    const tail = readFileSync(join(dir, logs[0].f), "utf8").split("\n").slice(-25).join("\n");
    console.error(`--- daemon log ${logs[0].f} ---\n${tail}\n--- end ---`);
  } catch (err) {
    console.error("daemon log dump failed:", err);
  }
}

function proxyOnce(req: IncomingMessage, res: ServerResponse, port: number) {
  // Likely-HTML requests (no file extension) get buffered so the logo-home
  // snippet can be injected; strip accept-encoding so we inject plain text.
  const lastSeg = (req.url || "/").split("?")[0].split("/").pop() || "";
  const expectHtml = !lastSeg.includes(".");
  const headers = { ...req.headers, host: `127.0.0.1:${port}` };
  if (expectHtml) delete headers["accept-encoding"];

  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port,
      path: req.url,
      method: req.method,
      headers,
    },
    (up) => {
      const isHtml = String(up.headers["content-type"] || "").includes("text/html");
      if (!expectHtml || !isHtml) {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
        return;
      }
      const chunks: Buffer[] = [];
      up.on("data", (c: Buffer) => chunks.push(c));
      up.on("end", () => {
        let html = Buffer.concat(chunks).toString("utf8");
        html = html.replace("</body>", `${LOGO_HOME_SNIPPET}</body>`);
        const h = { ...up.headers };
        delete h["content-length"];
        delete h["content-encoding"];
        res.writeHead(up.statusCode ?? 502, h);
        res.end(html);
      });
    },
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`studio upstream error: ${err.message}`);
  });
  req.pipe(upstream);
}

/** Branded hold page while a user's preview server materializes + boots. */
function warmingPage(): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Donova — warming up</title>
<meta http-equiv="refresh" content="2.5"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{background:#0a0a0f;color:#f5f1e8;font:400 15px/1.65 system-ui,sans-serif;display:flex;
align-items:center;justify-content:center;min-height:100vh;text-align:center}
h1{color:#4a8fd8;font-size:22px;font-weight:800;margin-bottom:8px}p{color:rgba(245,241,232,.5);font-size:14px}</style>
</head><body><div><h1>Setting up your workspace…</h1>
<p>Pulling your files — this only happens the first time.</p></div></body></html>`;
}

async function main() {
  mkdirSync(USER_ROOT, { recursive: true });
  await applyRebrand();

  const server = createServer((req, res) => {
    const session = handleGate(req, res);
    if (!session) return;
    const inst = instanceFor(session.email);
    const url = new URL(req.url || "/", "http://internal");
    // workspace desktop at the root; the real Studio lives at /studio
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(desktopPage(session.email));
      return;
    }
    void handleDesktopApi(req, res, inst)
      .then((handled) => {
        if (handled) return;
        if (url.pathname === "/studio" || url.pathname === "/studio/") {
          req.url = "/" + url.search;
        } else if (url.pathname.startsWith("/studio/")) {
          req.url = url.pathname.slice("/studio".length) + url.search;
        }
        // kick a cold boot before deciding how to respond
        if (!inst.booted && !inst.boot) {
          void ensureInstance(inst).catch((err) => console.error(`[${inst.uid}] boot failed:`, err));
        }
        if (inst.booted) {
          inst.lastTouched = Date.now();
          proxyOnce(req, res, inst.port);
          return;
        }
        const lastSeg = url.pathname.split("/").pop() || "";
        if (req.method === "GET" && !lastSeg.includes(".")) {
          // HTML page requested mid-boot → hold page with auto-refresh
          res.writeHead(200, { "content-type": "text/html" });
          res.end(warmingPage());
          return;
        }
        if (!inst.boot) {
          // Boot attempt already finished and cleared — retry next request
          // rather than crashing on a stale promise.
          res.writeHead(503, { "content-type": "text/plain" });
          res.end("workspace failed to start — refresh to retry");
          return;
        }
        void inst.boot
          .then(() => {
            inst.lastTouched = Date.now();
            proxyOnce(req, res, inst.port);
          })
          .catch((err) => {
            if (!res.headersSent) res.writeHead(503, { "content-type": "text/plain" });
            res.end(`workspace failed to start: ${err instanceof Error ? err.message : err}`);
          });
      })
      .catch((err) => {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`error: ${err instanceof Error ? err.message : String(err)}`);
      });
  });
  server.on("upgrade", (req, socket, head) => {
    const session = cookieSession(req);
    if (GATE_SECRET && !session) {
      socket.destroy();
      return;
    }
    if (!session) {
      socket.destroy();
      return;
    }
    const inst = instanceFor(session.email);
    const pipe = () => {
      if (!inst.booted) {
        socket.destroy();
        return;
      }
      inst.lastTouched = Date.now();
      const up = connect({ host: "127.0.0.1", port: inst.port }, () => {
        up.write(`${req.method} ${req.url} HTTP/1.1\r\n`);
        for (const [k, v] of Object.entries(req.headers)) {
          up.write(`${k}: ${Array.isArray(v) ? v.join(", ") : (v ?? "")}\r\n`);
        }
        up.write("\r\n");
        if (head?.length) up.write(head);
        socket.pipe(up).pipe(socket);
      });
      up.on("error", () => socket.destroy());
    };
    if (inst.booted) pipe();
    else if (inst.boot) void inst.boot.then(pipe).catch(() => socket.destroy());
    else socket.destroy();
  });
  server.listen(PUBLIC_PORT, "0.0.0.0", () => {
    console.log(`donova-studio-service listening on :${PUBLIC_PORT} (multi-user, root=${USER_ROOT})`);
  });

  setInterval(() => {
    for (const inst of instances.values()) {
      if (!inst.booted) continue;
      pushChanges(inst).then((n) => {
        if (n > 0) console.log(`[${inst.uid}] synced ${n} changed file(s) → GCS`);
      });
    }
  }, SYNC_MS).unref();

  setInterval(reapIdle, 60 * 1000).unref();

  const shutdown = async () => {
    console.log("shutdown: final push to GCS for all instances");
    try {
      await Promise.all([...instances.values()].map((i) => pushChanges(i)));
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
