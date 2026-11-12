import { startRenderJob } from "@/lib/jobs";
import { ensureProjectSeeded } from "@/lib/project";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    composition?: string;
    fps?: number;
    quality?: "draft" | "standard" | "high";
  };
  await ensureProjectSeeded();
  const job = await startRenderJob(body);
  return NextResponse.json({ id: job.id }, { status: 202 });
}
