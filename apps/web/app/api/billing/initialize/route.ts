import { NextResponse } from "next/server";
import { initializeHelcimCheckout } from "@/lib/helcim";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const email = body.email ? String(body.email).trim() : undefined;
    const name = body.name ? String(body.name).trim() : undefined;

    const session = await initializeHelcimCheckout({
      amount: 11.0,
      currency: "USD",
      email,
      customerName: name,
    });

    return NextResponse.json({
      ok: true,
      checkoutToken: session.checkoutToken,
      secretToken: session.secretToken,
    });
  } catch (err: unknown) {
    console.error("Billing initialize failed:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
