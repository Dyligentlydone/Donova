import { ensureProjectSeeded, readProjectFile, writeProjectFile } from "@/lib/project";
import { NextResponse } from "next/server";

export async function GET() {
  await ensureProjectSeeded();
  const content = await readProjectFile("style.md");
  return NextResponse.json({ path: "style.md", content });
}

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => null)) as { content?: string } | null;
  if (body?.content == null) {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }
  await writeProjectFile("style.md", body.content);
  return NextResponse.json({ ok: true });
}
