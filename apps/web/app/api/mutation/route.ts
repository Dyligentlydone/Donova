import { requireSubscriber } from "@/lib/auth";
import { applyMutation } from "@/lib/mutation";
import { readProjectFile, writeProjectFile } from "@/lib/project";
import { userPrefix } from "@/lib/subscribers";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const auth = await requireSubscriber();
  if ("error" in auth) return auth.error;
  const prefix = userPrefix(auth.email);
  const body = (await req.json().catch(() => null)) as {
    file?: string;
    mutations?: Array<Record<string, unknown>>;
  } | null;
  if (!body?.file || !Array.isArray(body.mutations)) {
    return NextResponse.json({ error: "file and mutations required" }, { status: 400 });
  }
  const html = await readProjectFile(prefix, body.file);
  if (html == null) return NextResponse.json({ error: "not found" }, { status: 404 });
  const out = await applyMutation(html, body.mutations);
  await writeProjectFile(prefix, body.file, out);
  return NextResponse.json({ ok: true, bytes: out.length });
}
