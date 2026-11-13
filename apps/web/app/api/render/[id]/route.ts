import { requireSubscriber } from "@/lib/auth";
import { getJob } from "@/lib/jobs";
import { userUid } from "@/lib/subscribers";
import { NextResponse } from "next/server";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSubscriber();
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const job = await getJob(id);
  // Job records carry an owner — never leak another user's render status or
  // its signed download URL.
  if (!job || job.owner !== userUid(auth.email)) {
    return NextResponse.json({ error: "no job" }, { status: 404 });
  }
  return NextResponse.json(job);
}
