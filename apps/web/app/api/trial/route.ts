import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { recordTrial, subscriberState, studioLink } from "../../../lib/subscribers";

/**
 * POST /api/trial — { email } → free 7-day trial access.
 * One trial per email: the trial clock starts on first claim and never
 * restarts. Paid subscribers and active trials get a fresh Studio link;
 * ended trials get a 403 so the page can show the subscribe CTA.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ ok: false, error: "invalid-email" }, { status: 400 });
    }

    const { rec } = await recordTrial(email);
    const state = subscriberState(rec);
    if (state === "trial-ended" || state === "none") {
      return NextResponse.json({ ok: false, error: "trial-ended" }, { status: 403 });
    }

    const cookieStore = await cookies();
    cookieStore.set("donova_email", email, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60,
      path: "/",
    });

    const sessionExpMs = state === "trial-active" ? rec.trialEndsAt : undefined;
    return NextResponse.json({
      ok: true,
      state,
      trialEndsAt: rec.trialEndsAt ?? null,
      url: studioLink(email, { sessionExpMs }),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
