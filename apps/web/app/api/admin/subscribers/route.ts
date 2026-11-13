import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { listSubscribers, subscriberState } from "../../../../lib/subscribers";

/**
 * GET /api/admin/subscribers — owner-only list of every trial + subscriber
 * record, for retargeting emails. Requires `x-admin-key: <STUDIO_GATE_SECRET>`
 * header — the key is never accepted in the URL because query strings land
 * in request logs. Treat the key like a password.
 */
export async function GET(req: Request) {
  const key = req.headers.get("x-admin-key") || "";
  const secret = process.env.STUDIO_GATE_SECRET || "";
  const a = Buffer.from(key);
  const b = Buffer.from(secret);
  if (!secret || a.length !== b.length || !timingSafeEqual(a, b)) {
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
