import Stripe from "stripe";

// Stripe billing for Donova Cloud subscriptions — Checkout-hosted payment,
// webhook-driven lifecycle. Replaces the Helcim integration: the durable
// subscriber record is written by /api/billing/webhook; /api/billing/confirm
// (the success redirect) does the same activation so the UX isn't gated on
// webhook latency.

const PRICE_ID = process.env.STRIPE_PRICE_ID || "";

let _client: Stripe | null = null;

function client(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
  if (!_client) _client = new Stripe(key);
  return _client;
}

/** Hosted Checkout session for the $11/mo Creator plan. */
export async function createCheckoutSession(opts: {
  email: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url: string }> {
  if (!PRICE_ID) throw new Error("STRIPE_PRICE_ID is not configured");
  const session = await client().checkout.sessions.create({
    mode: "subscription",
    customer_email: opts.email,
    line_items: [{ price: PRICE_ID, quantity: 1 }],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    // Email rides on the session + the subscription so webhooks can resolve
    // the account without a subscriber-record lookup.
    metadata: { email: opts.email },
    subscription_data: { metadata: { email: opts.email } },
    allow_promotion_codes: true,
  });
  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return { url: session.url };
}

/**
 * Server-side proof a Checkout session actually paid — the success redirect
 * must never grant access on the client's word alone. Returns the buyer email
 * Stripe collected (authoritative — not the client-supplied value).
 */
export async function verifyCheckoutSession(sessionId: string): Promise<{
  paid: boolean;
  email?: string;
  customerId?: string;
  subscriptionId?: string;
}> {
  const session = await client().checkout.sessions.retrieve(sessionId);
  const paid = session.status === "complete" && session.payment_status === "paid";
  const email =
    session.customer_details?.email ?? session.customer_email ?? session.metadata?.email ?? undefined;
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
  const subscriptionId =
    typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  return { paid, email, customerId, subscriptionId };
}

/**
 * Verify a webhook signature + parse the event. Throws on a bad signature —
 * callers must not process unverified payloads.
 */
export function constructWebhookEvent(payload: string, signature: string): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
  return client().webhooks.constructEvent(payload, signature, secret);
}
