import { requireSubscriber } from "@/lib/auth";
import { ensureProjectSeeded, listProjectFiles } from "@/lib/project";
import { userPrefix } from "@/lib/subscribers";
import { NextResponse } from "next/server";

export async function GET() {
  const auth = await requireSubscriber();
  if ("error" in auth) return auth.error;
  const prefix = userPrefix(auth.email);
  await ensureProjectSeeded(prefix);
  const files = (await listProjectFiles(prefix)).filter(
    (f) => !f.split("/").some((seg) => seg.startsWith(".")) && !f.startsWith("node_modules"),
  );
  return NextResponse.json({ files });
}
