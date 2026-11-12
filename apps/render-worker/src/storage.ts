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
  destDir: string;
}

export async function downloadAndExtractBundle(opts: DownloadBundleOpts): Promise<string> {
  const destDir = resolve(opts.destDir);
  await mkdir(destDir, { recursive: true });

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
    // @ts-expect-error ReadableStream vs NodeJS.ReadableStream
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
