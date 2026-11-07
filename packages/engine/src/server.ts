import { createReadStream, existsSync, statSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { getGsapSource } from "@framecraft/runtime";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".vtt": "text/vtt",
  ".srt": "application/x-subrip",
  ".hdr": "application/octet-stream",
  ".glb": "model/gltf-binary",
  ".wasm": "application/wasm",
};

export interface FileServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Static file server rooted at the project dir. Deterministic caching disabled;
 * Range requests supported for <video>/<audio> media.
 */
export async function startFileServer(root: string): Promise<FileServer> {
  const base = resolve(root);
  const server: Server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      let path = normalize(decodeURIComponent(url.pathname));
      if (path.endsWith(sep) || path === "/") path = join(path, "index.html");
      // Compositions have no favicon; browsers request it per page and a 404
      // shows up as a console error in `check`. Answer 204 instead.
      if (path === `${sep}favicon.ico`) {
        res.writeHead(204).end();
        return;
      }
      // Vendored GSAP for imported sub-composition scripts (runtime rewrites
      // CDN srcs to this path).
      if (path === `${sep}__fc-gsap.js`) {
        res.setHeader("Content-Type", "text/javascript; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.writeHead(200).end(getGsapSource());
        return;
      }
      const file = resolve(join(base, path));
      if (!file.startsWith(base + sep) && file !== base) {
        res.writeHead(403).end();
        return;
      }
      if (!existsSync(file) || !statSync(file).isFile()) {
        // .framecraft/ is internal render cache — absence is a normal state
        // (check/preview run without it) and must not noise the console.
        res.writeHead(path.startsWith(`${sep}.framecraft`) ? 204 : 404).end();
        return;
      }
      const size = statSync(file).size;
      const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
      res.setHeader("Content-Type", type);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Accept-Ranges", "bytes");

      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        if (m) {
          const start = m[1] ? Number(m[1]) : 0;
          const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
          res.writeHead(206, {
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Content-Length": end - start + 1,
          });
          createReadStream(file, { start, end }).pipe(res);
          return;
        }
      }
      res.writeHead(200, { "Content-Length": size });
      createReadStream(file).pipe(res);
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
