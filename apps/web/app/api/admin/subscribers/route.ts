import { NextResponse } from "next/server";
import { listSubscribers, subscriberState } from "../../../../lib/subscribers";

/**
 * GET /api/admin/subscribers?key=<STUDIO_GATE_SECRET>
 * Owner-only list of every trial + subscriber record — for retargeting
 * emails. Not linked anywhere; treat the key like a password.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get("key") || req.headers.get("x-admin-key") || "";
  const secret = process.env.STUDIO_GATE_SECRET || "";
  if (!secret || key !== secret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const subs = await listSubscribers();
  return NextResponse.json({
    ok: true,
    count: subs.length,
    subscribers: subs.map((s) => ({
      email: s.email,
      state: subscriberState(s),
      plan: s.plan ?? null,
      trialEndsAt: s.trialEndsAt ? new Date(s.trialEndsAt).toISOString() : null,
      activatedAt: s.activatedAt ?? null,
    })),
  });
}
