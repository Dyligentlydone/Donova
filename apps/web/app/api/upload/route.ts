import { Storage } from "@google-cloud/storage";
import { NextResponse } from "next/server";
import { requireSubscriber } from "../../../lib/auth";
import { userPrefix } from "../../../lib/subscribers";

const DEFAULT_BUCKET = process.env.DONOVA_BUCKET || "donova-renders-donova-514500";
const storage = new Storage();
/** formData is buffered in-memory by the runtime — hard cap keeps the 2Gi
 * container alive. Bigger clips go through the Studio workspace, which
 * streams. */
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

export async function POST(req: Request) {
  const auth = await requireSubscriber();
  if ("error" in auth) return auth.error;
  const prefix = userPrefix(auth.email);
  try {
    const contentLength = Number(req.headers.get("content-length") ?? 0);
    if (contentLength > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { ok: false, error: "file too large — upload it from your Studio workspace instead" },
        { status: 413 },
      );
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ ok: false, error: "No file provided" }, { status: 400 });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { ok: false, error: "file too large — upload it from your Studio workspace instead" },
        { status: 413 },
      );
    }

    const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const ts = Date.now();
    const rel = `raw footage/${ts}_${cleanName}`;
    const fileKey = `${prefix}${rel}`;
    const bytes = Buffer.from(await file.arrayBuffer());

    const bucket = storage.bucket(DEFAULT_BUCKET);
    const gcsFile = bucket.file(fileKey);

    await gcsFile.save(bytes, {
      contentType: file.type || "video/mp4",
      resumable: bytes.length > 10 * 1024 * 1024,
    });

    return NextResponse.json({
      ok: true,
      fileKey,
      projectPath: rel,
      size: bytes.length,
      name: file.name,
    });
  } catch (err: unknown) {
    console.error("Upload error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
