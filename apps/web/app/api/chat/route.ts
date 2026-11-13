import { cloudAgent } from "@/lib/agent";
import { requireSubscriber } from "@/lib/auth";
import { chatAllowance, recordChatUsage, userPrefix, userUid } from "@/lib/subscribers";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const auth = await requireSubscriber();
  if ("error" in auth) return auth.error;
  const body = (await req.json().catch(() => null)) as { message?: string } | null;
  if (!body?.message?.trim()) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }
  const allowance = await chatAllowance(auth.email);
  if (!allowance.allowed) {
    return NextResponse.json(
      { error: allowance.reason, code: "CHAT_LIMIT", remaining: 0 },
      { status: 429 },
    );
  }
  try {
    const turn = await cloudAgent(userUid(auth.email), userPrefix(auth.email)).chat(
      body.message.trim(),
    );
    await recordChatUsage(auth.email, turn.usage ?? { inputTokens: 0, outputTokens: 0 });
    const remaining = allowance.remaining === -1 ? -1 : allowance.remaining - 1;
    return NextResponse.json({ ...turn, chatRemaining: remaining });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
