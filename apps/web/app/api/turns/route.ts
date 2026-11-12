import { cloudAgent } from "@/lib/agent";
import { NextResponse } from "next/server";

export async function GET() {
  await cloudAgent().syncDown();
  return NextResponse.json({ turns: cloudAgent().historyTurns });
}
