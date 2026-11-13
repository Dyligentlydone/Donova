import { cloudAgent } from "@/lib/agent";
import { requireSubscriber } from "@/lib/auth";
import { userPrefix, userUid } from "@/lib/subscribers";
import { NextResponse } from "next/server";

export async function POST() {
  const auth = await requireSubscriber();
  if ("error" in auth) return auth.error;
  return NextResponse.json(
    await cloudAgent(userUid(auth.email), userPrefix(auth.email)).undo(),
  );
}
