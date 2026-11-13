import { Storage } from "@google-cloud/storage";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { userPrefix } from "../../../lib/subscribers";

const DEFAULT_BUCKET = process.env.DONOVA_BUCKET || "donova-renders-donova-514500";
const storage = new Storage();

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ ok: false, error: "No file provided" }, { status: 400 });
    }

    const email = (await cookies()).get("donova_email")?.value;
    const prefix = userPrefix(email);
    const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const fileKey = `${prefix}raw footage/${Date.now()}_${cleanName}`;
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
      projectPath: `raw footage/${Date.now()}_${cleanName}`,
      size: bytes.length,
      name: file.name,
    });
  } catch (err: unknown) {
    console.error("Upload error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
