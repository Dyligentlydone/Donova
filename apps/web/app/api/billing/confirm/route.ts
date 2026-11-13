import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { ACCOUNT_COOKIE, signAccount } from "../../../../lib/auth";
import { verifyHelcimCheckout } from "../../../../lib/helcim";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { checkoutToken, rawDataResponse: _raw, email } = body;

    if (!checkoutToken) {
      return NextResponse.json({ ok: false, error: "Missing checkoutToken" }, { status: 400 });
    }

    // Never grant access on the client's word: the checkout token must verify
    // against Helcim server-side. Without an API token configured this fails
    // closed — no subscriber record is written.
    if (!(await verifyHelcimCheckout(String(checkoutToken)))) {
      return NextResponse.json(
        { ok: false, error: "payment-not-verified" },
        { status: 402 },
      );
    }

    console.log("Helcim subscription payment verified for token:", String(checkoutToken).slice(0, 12));

    // Server-side subscriber record — the Studio gate checks this, not the cookie.
    if (email && String(email).includes("@")) {
      try {
        const { recordSubscriber } = await import("../../../../lib/subscribers");
        await recordSubscriber(String(email), String(checkoutToken));
      } catch (err) {
        console.error("subscriber record write failed:", err);
      }
    }

    const cookieStore = await cookies();
    cookieStore.set("donova_subscriber", "active", {
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
      maxAge: 30 * 24 * 60 * 60,
      path: "/",
    });

    if (email) {
      const clean = String(email).trim();
      // Display-only cookie (client-readable); the signed donova_account
      // cookie below is the one auth decisions are made on.
      cookieStore.set("donova_email", clean, {
        httpOnly: false,
        secure: process.env.NODE_ENV === "production",
        maxAge: 30 * 24 * 60 * 60,
        path: "/",
      });
      cookieStore.set(ACCOUNT_COOKIE, signAccount(clean), {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 30 * 24 * 60 * 60,
        path: "/",
      });
    }

    return NextResponse.json({
      ok: true,
      status: "active",
      plan: "creator",
      price: "$11/mo",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
