import { cloudAgent } from "@/lib/agent";
import { requireSubscriber } from "@/lib/auth";
import { userPrefix, userUid } from "@/lib/subscribers";
import { NextResponse } from "next/server";

export async function GET() {
  const auth = await requireSubscriber();
  if ("error" in auth) return auth.error;
  const agent = cloudAgent(userUid(auth.email), userPrefix(auth.email));
  await agent.syncDown();
  return NextResponse.json({ turns: agent.historyTurns });
}
