import { startRenderJob } from "@/lib/jobs";
import { ensureProjectSeeded } from "@/lib/project";
import { userPrefix } from "@/lib/subscribers";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    composition?: string;
    fps?: number;
    quality?: "draft" | "standard" | "high";
  };
  const email = (await cookies()).get("donova_email")?.value;
  const prefix = userPrefix(email);
  await ensureProjectSeeded();
  const job = await startRenderJob({ ...body, prefix });
  return NextResponse.json({ id: job.id }, { status: 202 });
}
