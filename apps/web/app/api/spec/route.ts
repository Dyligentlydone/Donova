import { ensureProjectSeeded, readProjectFile } from "@/lib/project";
import { parseCompositionHtml } from "@donova/contract";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const file = new URL(req.url).searchParams.get("file") ?? "index.html";
  await ensureProjectSeeded();
  const html = await readProjectFile(file);
  if (html == null) return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const { spec } = parseCompositionHtml(html, { path: file, isRoot: true });
    // Same-origin /project URL so the Studio iframe can reach the composition
    // and expose __fc/renderSeek (runtime is injected by the /project route).
    return NextResponse.json({ spec, compositionUrl: `/project/${file}` });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
