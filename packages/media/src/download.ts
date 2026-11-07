import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { get as httpsGet } from "node:https";
import { dirname } from "node:path";

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

/** Follow redirects (HF resolve → signed CDN), return the final 200 response. */
function resolveRedirects(url: string, hops = 5): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (hops <= 0) {
          reject(new Error("too many redirects"));
          return;
        }
        // Location may be relative — resolve against the URL that redirected.
        const next = new URL(res.headers.location, url).href;
        resolveRedirects(next, hops - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`download failed: HTTP ${res.statusCode}`));
        return;
      }
      resolve(res);
    });
    req.on("error", reject);
  });
}

export async function download(url: string, dest: string, onBytes?: (n: number) => void): Promise<void> {
  const res = await resolveRedirects(url);
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(tmp);
    let n = 0;
    res.on("data", (c: Buffer) => {
      n += c.length;
      onBytes?.(n);
    });
    res.on("error", reject);
    res.pipe(out);
    out.on("finish", () => out.close(() => resolve()));
    out.on("error", reject);
  });
  await rename(tmp, dest);
}
