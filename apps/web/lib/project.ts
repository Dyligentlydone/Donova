import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { Storage } from "@google-cloud/storage";

/**
 * GCS-backed project store for hosted Studio. One shared project per service
 * (multi-user namespacing lands with auth). GCS is the source of truth; text
 * files are materialized to /tmp only for the Agent's fs-based turn engine.
 */

const BUCKET = process.env.DONOVA_BUCKET || "donova-renders-donova-514500";
const PREFIX = process.env.DONOVA_PROJECT_PREFIX || "projects/default/";
const LOCAL_ROOT = join("/tmp", "donova-studio-project");

export function localRoot(): string {
  return LOCAL_ROOT;
}

let storage: Storage | null = null;
function gcs(): Storage {
  if (!storage) storage = new Storage();
  return storage;
}

function safeRel(p: string): string | null {
  const rel = normalize(p).replace(/^\/+/, "");
  if (!rel || rel === "." || rel.includes("..")) return null;
  return rel;
}

export function projectKey(rel: string): string {
  return `${PREFIX}${rel}`;
}

export async function readProjectFile(rel: string): Promise<string | null> {
  const r = safeRel(rel);
  if (!r) return null;
  const f = gcs().bucket(BUCKET).file(projectKey(r));
  const [exists] = await f.exists();
  if (!exists) return null;
  const [buf] = await f.download();
  return buf.toString("utf8");
}

export async function writeProjectFile(rel: string, content: string | Buffer): Promise<void> {
  const r = safeRel(rel);
  if (!r) throw new Error(`unsafe path: ${rel}`);
  await gcs().bucket(BUCKET).file(projectKey(r)).save(content);
}

export async function deleteProjectFile(rel: string): Promise<void> {
  const r = safeRel(rel);
  if (!r) return;
  await gcs().bucket(BUCKET).file(projectKey(r)).delete({ ignoreNotFound: true });
}

/** All object paths under the project prefix, relative to the project root. */
export async function listProjectFiles(): Promise<string[]> {
  const [files] = await gcs().bucket(BUCKET).getFiles({ prefix: PREFIX });
  return files
    .map((f) => f.name.slice(PREFIX.length))
    .filter((n) => n.length > 0 && !n.endsWith("/"))
    .sort();
}

export async function projectFileExists(rel: string): Promise<boolean> {
  const r = safeRel(rel);
  if (!r) return false;
  const [exists] = await gcs().bucket(BUCKET).file(projectKey(r)).exists();
  return exists;
}

export function projectFileStream(rel: string, start?: number, end?: number) {
  const r = safeRel(rel);
  if (!r) return null;
  return gcs()
    .bucket(BUCKET)
    .file(projectKey(r))
    .createReadStream(start != null || end != null ? { start, end } : undefined);
}

export async function projectFileMeta(rel: string): Promise<{ size: number; contentType?: string } | null> {
  const r = safeRel(rel);
  if (!r) return null;
  const f = gcs().bucket(BUCKET).file(projectKey(r));
  const [exists] = await f.exists();
  if (!exists) return null;
  const [meta] = await f.getMetadata();
  return { size: Number(meta.size ?? 0), contentType: meta.contentType };
}

/** Signed read URL for private-bucket objects (renders, media). */
export async function signedReadUrl(key: string, ttlMs = 15 * 60 * 1000): Promise<string> {
  const [url] = await gcs()
    .bucket(BUCKET)
    .file(key)
    .getSignedUrl({ action: "read", expires: Date.now() + ttlMs });
  return url;
}

export function gcsObjectUri(rel: string): string {
  return `gs://${BUCKET}/${projectKey(rel)}`;
}

/* ------------------------- local materialization ------------------------- */
// The Studio Agent (packages/studio-server/src/agent.ts) does real fs I/O on a
// project root. Text files only — media binaries are streamed from GCS by the
// iframe and downloaded by the render worker, never materialized here.

const TEXT_EXT = /\.(html?|css|m?js|json|md|txt|svg|xml|ts|tsx|map)$/i;
const SKIP_DIRS = /^(media|uploads|node_modules)\//;

function localPath(rel: string): string | null {
  const r = safeRel(rel);
  if (!r) return null;
  const fp = resolve(join(LOCAL_ROOT, r));
  return fp.startsWith(LOCAL_ROOT + sep) || fp === LOCAL_ROOT ? fp : null;
}

/** Download every text-like project file to the local mirror. */
export async function materializeProject(): Promise<string> {
  const files = await listProjectFiles();
  for (const rel of files) {
    if (SKIP_DIRS.test(rel) || !TEXT_EXT.test(rel)) continue;
    const lp = localPath(rel);
    if (!lp) continue;
    const content = await readProjectFile(rel);
    if (content == null) continue;
    await mkdir(dirname(lp), { recursive: true });
    await writeFile(lp, content);
  }
  return LOCAL_ROOT;
}

export function localStream(rel: string) {
  const lp = localPath(rel);
  return lp ? createReadStream(lp) : null;
}

/* ------------------------------ seed project ----------------------------- */

const SEED_INDEX = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>My Donova Project</title>
<style>
  html, body { margin: 0; background: #000; }
  #root { position: relative; width: 1080px; height: 1920px; overflow: hidden; background: #000;
          font-family: system-ui, sans-serif; }
  .clip { position: absolute; inset: 0; }
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-width="1080" data-height="1920" data-duration="2.5" data-fps="30">
  <div class="clip" data-start="0" data-duration="2.5"
       style="display:flex;align-items:center;justify-content:center;color:#fff">
    <h1 style="font-size:72px;font-weight:800">My first edit</h1>
  </div>
</div>
</body>
</html>
`;

const SEED_STYLE = `# Style Bible

Describe your editing preferences here — caption look, fonts, colors, pacing,
transition taste. The agent reads this before every edit. Everything you write
applies to this project until you change it.

## Captions
- (your caption style)

## Look
- (colors, fonts, overlays)

## Pacing
- (cut style, rhythm)
`;

const SEED_CONFIG = JSON.stringify(
  { name: "My Donova Project", composition: "index.html", fps: 30 },
  null,
  2,
);

/** Seed an empty project in GCS on first access. Idempotent. */
export async function ensureProjectSeeded(): Promise<void> {
  if (await projectFileExists("index.html")) return;
  await writeProjectFile("index.html", SEED_INDEX);
  await writeProjectFile("style.md", SEED_STYLE);
  await writeProjectFile("donova.json", SEED_CONFIG);
}
