import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { Storage } from "@google-cloud/storage";
import { STUDIO_URL } from "./studioUrl";

/**
 * Subscriber records + Studio gate tokens.
 * Records live at subscribers/<sha256(email)>.json in the project bucket —
 * written by /api/billing/confirm after Helcim checkout completes.
 * Studio gate tokens are HMAC-signed `base64url(email|expiryMs).hex` —
 * apps/studio-service verifies the same format with the shared secret.
 */

const BUCKET = process.env.DONOVA_BUCKET || "donova-renders-donova-514500";
const SECRET = process.env.STUDIO_GATE_SECRET || "";
const OWNER_EMAILS = (process.env.DONOVA_OWNER_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

const storage = new Storage();
const bucket = storage.bucket(BUCKET);

function subscriberKey(email: string): string {
  const hash = createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
  return `subscribers/${hash}.json`;
}

export async function recordSubscriber(email: string, checkoutToken?: string): Promise<void> {
  await bucket.file(subscriberKey(email)).save(
    JSON.stringify({
      email: email.trim().toLowerCase(),
      status: "active",
      plan: "creator",
      price: "$11/mo",
      checkoutToken: checkoutToken ?? null,
      activatedAt: new Date().toISOString(),
    }),
    { contentType: "application/json" },
  );
}

export async function isSubscriber(email: string): Promise<boolean> {
  const e = email.trim().toLowerCase();
  if (OWNER_EMAILS.includes(e)) return true;
  try {
    const [buf] = await bucket.file(subscriberKey(e)).download();
    const rec = JSON.parse(buf.toString()) as { status?: string };
    return rec.status === "active";
  } catch {
    return false;
  }
}

export function studioLink(email: string, ttlMs = 5 * 60 * 1000): string {
  const payload = Buffer.from(`${email.trim().toLowerCase()}|${Date.now() + ttlMs}`).toString("base64url");
  const sig = createHmac("sha256", SECRET).update(payload).digest("hex");
  return `${STUDIO_URL}/?t=${payload}.${sig}`;
}

/** Exported for tests; keeps verify logic identical to studio-service. */
export function verifyStudioToken(token: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const expect = createHmac("sha256", SECRET).update(payload).digest("hex");
  const a = Buffer.from(token.slice(dot + 1));
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const raw = Buffer.from(payload, "base64url").toString();
  const sep = raw.lastIndexOf("|");
  if (sep <= 0) return null;
  const email = raw.slice(0, sep);
  return Number(raw.slice(sep + 1)) > Date.now() ? email : null;
}
