import { NextResponse } from "next/server";
import { ACCOUNT_COOKIE, signAccount } from "../../../../lib/auth";
import { verifyCheckoutSession } from "../../../../lib/stripe";
import { recordSubscriber } from "../../../../lib/subscribers";

/**
 * Stripe Checkout success redirect (GET — user lands here from Stripe).
 * Verifies the session server-side before granting access; the same
 * activation also arrives via webhook, so this write is belt-and-suspenders
 * for instant UX.
 */
export async function GET(req: Request) {
  const base = new URL(req.url);
  const sessionId = base.searchParams.get("session_id") ?? "";
  const fail = (reason: string) =>
    NextResponse.redirect(new URL(`/?billing_error=${encodeURIComponent(reason)}`, base.origin));

  try {
    if (!sessionId.startsWith("cs_")) return fail("missing-session");

    const { paid, email, customerId, subscriptionId } = await verifyCheckoutSession(sessionId);
    if (!paid || !email || !email.includes("@")) {
      return fail("payment-not-verified");
    }

    try {
      await recordSubscriber(email, sessionId, {
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
      });
    } catch (err) {
      // The webhook retries the activation — the redirect still succeeds so
      // the user isn't stranded by a transient GCS write failure.
      console.error("subscriber record write failed:", err);
    }

    const res = NextResponse.redirect(new URL("/dashboard", base.origin));
    const secure = process.env.NODE_ENV === "production";
    const month = 30 * 24 * 60 * 60;
    res.cookies.set("donova_subscriber", "active", { httpOnly: false, secure, maxAge: month, path: "/" });
    // Display-only cookie; the signed account cookie is what auth checks.
    res.cookies.set("donova_email", email.trim(), { httpOnly: false, secure, maxAge: month, path: "/" });
    res.cookies.set(ACCOUNT_COOKIE, signAccount(email.trim()), {
      httpOnly: true,
      secure,
      sameSite: "lax",
      maxAge: month,
      path: "/",
    });
    return res;
  } catch (err: unknown) {
    console.error("Billing confirm failed:", err);
    return fail("confirm-failed");
  }
}
