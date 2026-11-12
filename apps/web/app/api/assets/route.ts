import { ensureProjectSeeded, listProjectFiles, projectFileExists } from "@/lib/project";
import { NextResponse } from "next/server";

export async function GET() {
  await ensureProjectSeeded();
  const files = await listProjectFiles();
  const media = files.filter((f) => f.startsWith("media/"));
  const blocks = [
    ...new Set(
      files
        .filter((f) => f.startsWith("compositions/") && f.endsWith("/index.html"))
        .map((f) => f.split("/")[1] ?? ""),
    ),
  ].filter(Boolean);
  return NextResponse.json({ media, blocks, style: await projectFileExists("style.md") });
}
