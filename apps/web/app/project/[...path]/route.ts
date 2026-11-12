import { projectFileMeta, projectFileStream, readProjectFile } from "@/lib/project";
import { getGsapSource } from "@donova/runtime";

/**
 * Serves the composition project from GCS — the Studio iframe loads
 * /project/index.html here. HTML gets the __fc runtime injected so the parent
 * can call renderSeek / read __playerReady. Media streams with Range support.
 */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function mime(path: string): string {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const rel = path.join("/");

  // Compositions reference /__fc-gsap.js relative to the document — the same
  // vendored file serves it here (matches the local server's dual route).
  if (rel === "__fc-gsap.js") {
    return new Response(getGsapSource(), {
      headers: { "Content-Type": "text/javascript; charset=utf-8" },
    });
  }

  const type = mime(rel);

  if (type.startsWith("text/html")) {
    const html = await readProjectFile(rel);
    if (html == null) return new Response("not found", { status: 404 });
    const tag = '<script src="/__fc-runtime.js"></script>';
    const out = html.includes("/__fc-runtime.js") ? html : html.replace(/<\/head>/i, `${tag}\n</head>`);
    return new Response(out, {
      headers: { "Content-Type": type, "Cache-Control": "no-store" },
    });
  }

  const meta = await projectFileMeta(rel);
  if (!meta) return new Response("not found", { status: 404 });

  // Byte-range support so <video>/<audio> can seek in the preview iframe.
  const range = req.headers.get("range");
  const m = range?.match(/bytes=(\d*)-(\d*)/);
  if (m && (m[1] !== "" || m[2] !== "")) {
    const start = m[1] === "" ? Math.max(0, meta.size - Number(m[2])) : Number(m[1]);
    const end = m[2] === "" || m[1] === "" ? meta.size - 1 : Math.min(Number(m[2]), meta.size - 1);
    const stream = projectFileStream(rel, start, end);
    if (!stream) return new Response("forbidden", { status: 403 });
    return new Response(stream as unknown as ReadableStream, {
      status: 206,
      headers: {
        "Content-Type": meta.contentType ?? type,
        "Content-Range": `bytes ${start}-${end}/${meta.size}`,
        "Content-Length": String(end - start + 1),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      },
    });
  }

  const stream = projectFileStream(rel);
  if (!stream) return new Response("forbidden", { status: 403 });
  return new Response(stream as unknown as ReadableStream, {
    headers: {
      "Content-Type": meta.contentType ?? type,
      "Content-Length": String(meta.size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    },
  });
}
