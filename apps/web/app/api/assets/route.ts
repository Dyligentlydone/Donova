import { requireSubscriber } from "@/lib/auth";
import { ensureProjectSeeded, listProjectFiles, projectFileExists } from "@/lib/project";
import { userPrefix } from "@/lib/subscribers";
import { NextResponse } from "next/server";

export async function GET() {
  const auth = await requireSubscriber();
  if ("error" in auth) return auth.error;
  const prefix = userPrefix(auth.email);
  await ensureProjectSeeded(prefix);
  const files = await listProjectFiles(prefix);
  const media = files.filter((f) => f.startsWith("media/") || f.startsWith("raw footage/"));
  const blocks = [
    ...new Set(
      files
        .filter((f) => f.startsWith("compositions/") && f.endsWith("/index.html"))
        .map((f) => f.split("/")[1] ?? ""),
    ),
  ].filter(Boolean);
  return NextResponse.json({ media, blocks, style: await projectFileExists(prefix, "style.md") });
}
