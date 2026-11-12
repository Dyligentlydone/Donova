import { getJob } from "@/lib/jobs";
import { NextResponse } from "next/server";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await getJob(id);
  return job ? NextResponse.json(job) : NextResponse.json({ error: "no job" }, { status: 404 });
}
