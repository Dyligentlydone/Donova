import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { isSubscriber, studioLink } from "../../../lib/subscribers";

/**
 * GET /api/studio-link — issues a signed Studio URL if the caller's
 * donova_email cookie maps to an active subscriber record (or owner
 * allowlist). The Studio service validates the token and sets its own
 * session cookie on its origin.
 */
export async function GET() {
  const cookieStore = await cookies();
  const email = cookieStore.get("donova_email")?.value?.trim();
  if (!email || !email.includes("@")) {
    return NextResponse.json({ ok: false, error: "no-account" }, { status: 401 });
  }
  if (!(await isSubscriber(email))) {
    return NextResponse.json({ ok: false, error: "not-subscribed" }, { status: 403 });
  }
  return NextResponse.json({ ok: true, url: studioLink(email) });
}
