import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { Storage } from "@google-cloud/storage";

const execFileAsync = promisify(execFile);

let gcsStorage: Storage | null = null;
function getStorage(): Storage {
  if (!gcsStorage) {
    gcsStorage = new Storage();
  }
  return gcsStorage;
}

export interface DownloadBundleOpts {
  bucket?: string;
  bundleKey?: string;
  bundleUrl?: string;
  /** GCS object prefix holding an unpacked project tree (e.g. "projects/default/"). */
  projectPrefix?: string;
  destDir: string;
}

/** Downloads every object under a GCS prefix into destDir, preserving rel paths. */
async function downloadProjectPrefix(
  storage: Storage,
  bucket: string,
  prefix: string,
  destDir: string,
): Promise<void> {
  const b = storage.bucket(bucket);
  const [files] = await b.getFiles({ prefix });
  const objects = files.filter((f) => !f.name.endsWith("/"));
  if (objects.length === 0) {
    throw new Error(`No project files found under gs://${bucket}/${prefix}`);
  }
  for (const f of objects) {
    const rel = f.name.slice(prefix.length);
    if (!rel || rel.includes("..")) continue;
    const dest = join(destDir, rel);
    if (!resolve(dest).startsWith(destDir)) continue;
    await mkdir(dirname(dest), { recursive: true });
    await f.download({ destination: dest });
  }
}

/**
 * Download only the named project files (rel paths) under a prefix into
 * destDir. Missing objects are skipped — callers check existsSync on inputs
 * they require. Returns the rels actually pulled.
 */
export async function downloadProjectFiles(
  storage: Storage,
  bucket: string,
  prefix: string,
  rels: string[],
  destDir: string,
): Promise<string[]> {
  const b = storage.bucket(bucket);
  const pulled: string[] = [];
  for (const rel of rels) {
    if (!rel || rel.includes("..")) continue;
    const f = b.file(prefix + rel);
    const [exists] = await f.exists();
    if (!exists) continue;
    const dest = join(destDir, rel);
    if (!resolve(dest).startsWith(resolve(destDir))) continue;
    await mkdir(dirname(dest), { recursive: true });
    await f.download({ destination: dest });
    pulled.push(rel);
  }
  return pulled;
}

/** Upload local files (rel paths under srcDir) back into the project prefix. */
export async function uploadProjectFiles(
  storage: Storage,
  bucket: string,
  prefix: string,
  srcDir: string,
  rels: string[],
): Promise<void> {
  const b = storage.bucket(bucket);
  for (const rel of rels) {
    if (!rel || rel.includes("..")) continue;
    const src = join(srcDir, rel);
    if (!resolve(src).startsWith(resolve(srcDir))) continue;
    await b.upload(src, { destination: prefix + rel });
  }
}

export function gcs(): Storage {
  return getStorage();
}

export async function downloadAndExtractBundle(opts: DownloadBundleOpts): Promise<string> {
  const destDir = resolve(opts.destDir);
  await mkdir(destDir, { recursive: true });

  if (opts.bucket && opts.projectPrefix) {
    await downloadProjectPrefix(getStorage(), opts.bucket, opts.projectPrefix, destDir);
    return destDir;
  }

  const tempArchive = join(destDir, "__bundle_archive__");

  if (opts.bucket && opts.bundleKey) {
    const storage = getStorage();
    const bucket = storage.bucket(opts.bucket);
    const file = bucket.file(opts.bundleKey);
    const [exists] = await file.exists();
    if (!exists) {
      throw new Error(`GCS bundle not found: gs://${opts.bucket}/${opts.bundleKey}`);
    }
    await file.download({ destination: tempArchive });
  } else if (opts.bundleUrl) {
    const resp = await fetch(opts.bundleUrl);
    if (!resp.ok) {
      throw new Error(`Failed to download bundle from URL (HTTP ${resp.status}): ${opts.bundleUrl}`);
    }
    if (!resp.body) {
      throw new Error("Empty response body when downloading bundle URL");
    }
    const writeStream = createWriteStream(tempArchive);
    await pipeline(resp.body, writeStream);
  } else {
    throw new Error("Must provide either bucket + bundleKey or bundleUrl");
  }

  // Detect format (zip vs tar) and extract
  const isZip = opts.bundleKey?.endsWith(".zip") || opts.bundleUrl?.endsWith(".zip");
  const isTar =
    opts.bundleKey?.endsWith(".tgz") ||
    opts.bundleKey?.endsWith(".tar.gz") ||
    opts.bundleUrl?.endsWith(".tgz") ||
    opts.bundleUrl?.endsWith(".tar.gz");

  if (isTar) {
    await execFileAsync("tar", ["-xzf", tempArchive, "-C", destDir]);
  } else {
    // Default to unzip (works for .zip and unbranded archives)
    try {
      await execFileAsync("unzip", ["-q", "-o", tempArchive, "-d", destDir]);
    } catch (err: unknown) {
      // If unzip fails, try tar fallback
      try {
        await execFileAsync("tar", ["-xf", tempArchive, "-C", destDir]);
      } catch {
        throw new Error(`Failed to extract bundle archive: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return destDir;
}

export interface UploadOutputOpts {
  filePath: string;
  bucket?: string;
  outputKey?: string;
  uploadUrl?: string;
  contentType?: string;
}

export interface UploadResult {
  destination: string;
  size: number;
}

export async function uploadRenderOutput(opts: UploadOutputOpts): Promise<UploadResult> {
  const filePath = resolve(opts.filePath);
  const st = await stat(filePath);
  const contentType = opts.contentType ?? (filePath.endsWith(".mp4") ? "video/mp4" : "application/octet-stream");

  if (opts.bucket && opts.outputKey) {
    const storage = getStorage();
    const bucket = storage.bucket(opts.bucket);
    const file = bucket.file(opts.outputKey);
    await bucket.upload(filePath, {
      destination: opts.outputKey,
      contentType,
      resumable: st.size > 20 * 1024 * 1024, // use resumable upload for >20MB
    });
    return {
      destination: `gs://${opts.bucket}/${opts.outputKey}`,
      size: st.size,
    };
  }

  if (opts.uploadUrl) {
    const { readFile } = await import("node:fs/promises");
    const data = await readFile(filePath);
    const resp = await fetch(opts.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(st.size),
      },
      body: data,
    });
    if (!resp.ok) {
      throw new Error(`Failed to upload output to uploadUrl (HTTP ${resp.status}): ${opts.uploadUrl}`);
    }
    return {
      destination: opts.uploadUrl.split("?")[0] ?? opts.uploadUrl,
      size: st.size,
    };
  }

  throw new Error("Must provide either bucket + outputKey or uploadUrl for upload");
}
