import { readProjectFile } from "@/lib/project";
import { lintHtml } from "@donova/lint";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const file = new URL(req.url).searchParams.get("file") ?? "index.html";
  const html = await readProjectFile(file);
  if (html == null) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { issues } = lintHtml(html, { path: file, isRoot: true });
  return NextResponse.json({ issues });
}
