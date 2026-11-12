import { ensureProjectSeeded, readProjectFile, writeProjectFile } from "@/lib/project";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const path = new URL(req.url).searchParams.get("path") ?? "";
  await ensureProjectSeeded();
  const content = await readProjectFile(path);
  if (content == null) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ path, content });
}

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => null)) as { path?: string; content?: string } | null;
  if (!body?.path || body.content == null) {
    return NextResponse.json({ error: "path and content required" }, { status: 400 });
  }
  try {
    await writeProjectFile(body.path, body.content);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 403 });
  }
}
