import { ensureProjectSeeded, listProjectFiles } from "@/lib/project";
import { NextResponse } from "next/server";

export async function GET() {
  await ensureProjectSeeded();
  const files = (await listProjectFiles()).filter(
    (f) => !f.split("/").some((seg) => seg.startsWith(".")) && !f.startsWith("node_modules"),
  );
  return NextResponse.json({ files });
}
