import { requireSubscriber } from "@/lib/auth";
import { readProjectFile } from "@/lib/project";
import { userPrefix } from "@/lib/subscribers";
import { lintHtml } from "@donova/lint";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const auth = await requireSubscriber();
  if ("error" in auth) return auth.error;
  const prefix = userPrefix(auth.email);
  const file = new URL(req.url).searchParams.get("file") ?? "index.html";
  const html = await readProjectFile(prefix, file);
  if (html == null) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { issues } = lintHtml(html, { path: file, isRoot: true });
  return NextResponse.json({ issues });
}
