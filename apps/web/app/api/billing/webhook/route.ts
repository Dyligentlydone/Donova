import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { constructWebhookEvent } from "../../../../lib/stripe";
import { deactivateSubscriber, recordSubscriber } from "../../../../lib/subscribers";

/**
 * Stripe lifecycle webhook — the durable source of truth for subscriber
 * status (the confirm redirect is only UX). Activation on paid checkout,
 * deactivation on cancel / terminal non-payment.
 */

function emailFromSubscription(sub: Stripe.Subscription): string | null {
  const e = sub.metadata?.email;
  return e?.includes("@") ? e.trim().toLowerCase() : null;
}

async function activateFromSession(session: Stripe.Checkout.Session): Promise<void> {
  const email = session.customer_details?.email ?? session.customer_email ?? session.metadata?.email ?? null;
  if (!email?.includes("@")) return;
  const subscriptionId =
    typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
  await recordSubscriber(email, session.id, {
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
  });
}

async function applySubscriptionState(sub: Stripe.Subscription): Promise<void> {
  const email = emailFromSubscription(sub);
  if (!email) return;
  if (sub.status === "active" || sub.status === "trialing") {
    await recordSubscriber(email, undefined, {
      stripeCustomerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
      stripeSubscriptionId: sub.id,
    });
  } else if (sub.status === "canceled" || sub.status === "unpaid" || sub.status === "incomplete_expired") {
    // past_due keeps access while Stripe retries the card.
    await deactivateSubscriber(email, sub.status);
  }
}

export async function POST(req: Request) {
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "missing-signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    // Raw body is required for signature verification.
    event = constructWebhookEvent(await req.text(), signature);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err);
    return NextResponse.json({ error: "invalid-signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await activateFromSession(event.data.object as Stripe.Checkout.Session);
        break;
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await applySubscriptionState(event.data.object as Stripe.Subscription);
        break;
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        console.warn("Stripe invoice payment failed:", invoice.id, invoice.customer_email);
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error(`Stripe webhook ${event.type} handler failed:`, err);
    // 500 → Stripe retries delivery (with backoff for ~3 days).
    return NextResponse.json({ ok: false, error: "handler-failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, received: true });
}
