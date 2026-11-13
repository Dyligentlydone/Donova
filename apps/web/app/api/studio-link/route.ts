import { NextResponse } from "next/server";
import { authedEmail } from "../../../lib/auth";
import {
  getSubscriber,
  isSubscriber,
  subscriberState,
  studioLink,
} from "../../../lib/subscribers";

/**
 * GET /api/studio-link — issues a signed Studio URL if the caller's signed
 * account cookie maps to an active subscriber record (or owner allowlist).
 * Trial users get a session capped at their trial end; ended trials get a
 * distinct error so the UI can show the subscribe CTA.
 * The Studio service validates the token and sets its own session cookie.
 */
export async function GET() {
  const email = await authedEmail();
  if (!email) {
    return NextResponse.json({ ok: false, error: "no-account" }, { status: 401 });
  }
  const rec = await getSubscriber(email);
  const state = subscriberState(rec);
  if (state === "trial-ended") {
    return NextResponse.json({ ok: false, error: "trial-ended" }, { status: 403 });
  }
  if (!(await isSubscriber(email))) {
    return NextResponse.json({ ok: false, error: "not-subscribed" }, { status: 403 });
  }
  const sessionExpMs = state === "trial-active" ? rec?.trialEndsAt : undefined;
  return NextResponse.json({ ok: true, url: studioLink(email, { sessionExpMs }) });
}
