import { cloudAgent } from "@/lib/agent";
import { requireSubscriber } from "@/lib/auth";
import { userPrefix, userUid } from "@/lib/subscribers";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const auth = await requireSubscriber();
  if ("error" in auth) return auth.error;
  const body = (await req.json().catch(() => null)) as { message?: string } | null;
  if (!body?.message?.trim()) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }
  try {
    const turn = await cloudAgent(userUid(auth.email), userPrefix(auth.email)).chat(
      body.message.trim(),
    );
    return NextResponse.json(turn);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
