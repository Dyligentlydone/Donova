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

export interface SubscriberRecord {
  email?: string;
  status?: string;
  plan?: string;
  /** Epoch ms — trial records only. Missing/absent = no expiry (paid). */
  trialEndsAt?: number;
  activatedAt?: string;
}

export async function getSubscriber(email: string): Promise<SubscriberRecord | null> {
  try {
    const [buf] = await bucket.file(subscriberKey(email.trim().toLowerCase())).download();
    return JSON.parse(buf.toString()) as SubscriberRecord;
  } catch {
    return null;
  }
}

/**
 * First claim wins: returns the existing record when the email already has
 * one (paid or trial — the trial clock does not restart). Only creates a new
 * 7-day trial record for an email we've never seen.
 */
export async function recordTrial(email: string): Promise<{ rec: SubscriberRecord; created: boolean }> {
  const e = email.trim().toLowerCase();
  const existing = await getSubscriber(e);
  if (existing) return { rec: existing, created: false };
  const rec: SubscriberRecord = {
    email: e,
    status: "trial",
    plan: "trial",
    trialEndsAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    activatedAt: new Date().toISOString(),
  };
  await bucket
    .file(subscriberKey(e))
    .save(JSON.stringify(rec), { contentType: "application/json" });
  return { rec, created: true };
}

export function subscriberState(rec: SubscriberRecord | null): "paid" | "trial-active" | "trial-ended" | "none" {
  if (!rec) return "none";
  if (rec.status === "active") return "paid";
  if (rec.status === "trial") {
    return typeof rec.trialEndsAt === "number" && rec.trialEndsAt > Date.now()
      ? "trial-active"
      : "trial-ended";
  }
  return "none";
}

export async function isSubscriber(email: string): Promise<boolean> {
  const e = email.trim().toLowerCase();
  if (OWNER_EMAILS.includes(e)) return true;
  const state = subscriberState(await getSubscriber(e));
  return state === "paid" || state === "trial-active";
}

/**
 * Signed Studio URL. `sessionExpMs` caps the Studio session lifetime (used
 * to expire trials exactly when the trial ends); the Studio service defaults
 * to its own 30-day cap when absent.
 */
export function studioLink(email: string, opts?: { ttlMs?: number; sessionExpMs?: number }): string {
  const { ttlMs = 5 * 60 * 1000, sessionExpMs } = opts ?? {};
  const parts = `${email.trim().toLowerCase()}|${Date.now() + ttlMs}${sessionExpMs ? `|${sessionExpMs}` : ""}`;
  const payload = Buffer.from(parts).toString("base64url");
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
