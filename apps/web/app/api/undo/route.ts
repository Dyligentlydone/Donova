import { cloudAgent } from "@/lib/agent";
import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(await cloudAgent().undo());
}
