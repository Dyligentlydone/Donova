import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { checkoutToken, rawDataResponse: _raw, email } = body;

    if (!checkoutToken) {
      return NextResponse.json({ ok: false, error: "Missing checkoutToken" }, { status: 400 });
    }

    console.log("Helcim subscription payment confirmed for token:", checkoutToken);

    // Set an active subscriber cookie (valid for 30 days)
    const cookieStore = await cookies();
    cookieStore.set("donova_subscriber", "active", {
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
      maxAge: 30 * 24 * 60 * 60,
      path: "/",
    });

    if (email) {
      cookieStore.set("donova_email", String(email).trim(), {
        httpOnly: false,
        secure: process.env.NODE_ENV === "production",
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
