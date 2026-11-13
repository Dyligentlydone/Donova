import { requireSubscriber } from "@/lib/auth";
import { ensureProjectSeeded, readProjectFile, writeProjectFile } from "@/lib/project";
import { userPrefix } from "@/lib/subscribers";
import { NextResponse } from "next/server";

export async function GET() {
  const auth = await requireSubscriber();
  if ("error" in auth) return auth.error;
  const prefix = userPrefix(auth.email);
  await ensureProjectSeeded(prefix);
  const content = await readProjectFile(prefix, "style.md");
  return NextResponse.json({ path: "style.md", content });
}

export async function PUT(req: Request) {
  const auth = await requireSubscriber();
  if ("error" in auth) return auth.error;
  const prefix = userPrefix(auth.email);
  const body = (await req.json().catch(() => null)) as { content?: string } | null;
  if (body?.content == null) {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }
  await writeProjectFile(prefix, "style.md", body.content);
  return NextResponse.json({ ok: true });
}
