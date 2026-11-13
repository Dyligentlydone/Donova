import { NextResponse } from "next/server";
import { createCheckoutSession } from "../../../../lib/stripe";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const email = body.email ? String(body.email).trim() : "";
    if (!email.includes("@")) {
      return NextResponse.json({ ok: false, error: "A valid email is required" }, { status: 400 });
    }

    const origin = req.headers.get("origin") ?? process.env.DONOVA_WEB_URL ?? "";
    const base = origin || "http://localhost:3000";

    const { url } = await createCheckoutSession({
      email,
      successUrl: `${base}/api/billing/confirm?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/#pricing`,
    });

    return NextResponse.json({ ok: true, url });
  } catch (err: unknown) {
    console.error("Billing checkout failed:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
