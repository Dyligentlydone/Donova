import { requireSubscriber } from "@/lib/auth";
import { startRenderJob } from "@/lib/jobs";
import { ensureProjectSeeded } from "@/lib/project";
import { userPrefix, userUid } from "@/lib/subscribers";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const auth = await requireSubscriber();
  if ("error" in auth) return auth.error;
  const prefix = userPrefix(auth.email);
  const body = (await req.json().catch(() => ({}))) as {
    composition?: string;
    fps?: number;
    quality?: "draft" | "standard" | "high";
  };
  await ensureProjectSeeded(prefix);
  const job = await startRenderJob({ ...body, prefix, owner: userUid(auth.email) });
  return NextResponse.json({ id: job.id }, { status: 202 });
}
