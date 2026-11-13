import { createHash, createHmac, timingSafeEqual } from "node:crypto";
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
  /** Lifetime chat count — trial plan only (cap is lifetime, not monthly). */
  trialChats?: number;
  /** Paid-plan usage for `usageMonth` (YYYY-MM); resets when the month rolls. */
  usage?: { month: string; chats: number; tokensIn: number; tokensOut: number };
}

export const TRIAL_CHAT_LIMIT = 25;
export const PAID_CHAT_MONTHLY = 300;
export const PAID_TOKEN_MONTHLY = 4_000_000; // in+out; abuse backstop ≈ $2-4 worst case

export type ChatAllowance =
  | { allowed: true; plan: "owner" | "paid" | "trial"; remaining: number }
  | { allowed: false; plan: "paid" | "trial"; remaining: 0; reason: string };

/** How many agent chats the account may still send. Owners are uncapped. */
export async function chatAllowance(email: string): Promise<ChatAllowance> {
  const e = email.trim().toLowerCase();
  if (OWNER_EMAILS.includes(e)) return { allowed: true, plan: "owner", remaining: -1 };
  const rec = await getSubscriber(e);
  const state = subscriberState(rec);
  if (state === "paid") {
    const month = new Date().toISOString().slice(0, 7);
    const u = rec?.usage?.month === month ? rec.usage : undefined;
    const usedTokens = (u?.tokensIn ?? 0) + (u?.tokensOut ?? 0);
    const remaining = Math.min(PAID_CHAT_MONTHLY - (u?.chats ?? 0), PAID_TOKEN_MONTHLY - usedTokens);
    if (remaining <= 0) {
      return {
        allowed: false,
        plan: "paid",
        remaining: 0,
        reason: `Monthly AI edit limit reached (${PAID_CHAT_MONTHLY} chats). Resets on the 1st.`,
      };
    }
    return { allowed: true, plan: "paid", remaining };
  }
  if (state === "trial-active") {
    const remaining = TRIAL_CHAT_LIMIT - (rec?.trialChats ?? 0);
    if (remaining <= 0) {
      return {
        allowed: false,
        plan: "trial",
        remaining: 0,
        reason: `Trial includes ${TRIAL_CHAT_LIMIT} AI chats — subscribe to keep editing with the agent.`,
      };
    }
    return { allowed: true, plan: "trial", remaining };
  }
  // trial-ended / none: requireSubscriber upstream already blocks these.
  return { allowed: false, plan: "trial", remaining: 0, reason: "No active plan." };
}

/**
 * Record one completed chat + its token usage on the subscriber record.
 * Soft cap: read-modify-write can lose a count across concurrent containers —
 * acceptable for quotas (per-user chats are already mutexed within a container).
 */
export async function recordChatUsage(
  email: string,
  usage: { inputTokens: number; outputTokens: number },
): Promise<void> {
  const e = email.trim().toLowerCase();
  if (OWNER_EMAILS.includes(e)) return;
  const rec = (await getSubscriber(e)) ?? { email: e };
  if (rec.status === "trial") {
    rec.trialChats = (rec.trialChats ?? 0) + 1;
  } else {
    const month = new Date().toISOString().slice(0, 7);
    if (rec.usage?.month !== month) rec.usage = { month, chats: 0, tokensIn: 0, tokensOut: 0 };
    rec.usage.chats += 1;
    rec.usage.tokensIn += usage.inputTokens;
    rec.usage.tokensOut += usage.outputTokens;
  }
  await bucket.file(subscriberKey(e)).save(JSON.stringify(rec), { contentType: "application/json" });
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
  await bucket.file(subscriberKey(e)).save(JSON.stringify(rec), { contentType: "application/json" });
  return { rec, created: true };
}

/**
 * email → the user's stable id — the same scheme the Studio service uses.
 * Owner + unauthed map to the shared default tree. Both sides must stay in
 * sync: uid = u-<sha256(email)[:12]>.
 */
export function userUid(email: string | null | undefined): string {
  if (!email || !email.includes("@") || email === "owner@donova.local") {
    return "default";
  }
  return `u-${createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 12)}`;
}

/** email → the user's GCS project prefix (see userUid). */
export function userPrefix(email: string | null | undefined): string {
  return `projects/${userUid(email)}/`;
}

export function subscriberState(
  rec: SubscriberRecord | null,
): "paid" | "trial-active" | "trial-ended" | "none" {
  if (!rec) return "none";
  if (rec.status === "active") return "paid";
  if (rec.status === "trial") {
    return typeof rec.trialEndsAt === "number" && rec.trialEndsAt > Date.now()
      ? "trial-active"
      : "trial-ended";
  }
  return "none";
}

export async function listSubscribers(): Promise<SubscriberRecord[]> {
  const [files] = await bucket.getFiles({ prefix: "subscribers/" });
  const records = await Promise.all(
    files
      .filter((f) => f.name.endsWith(".json"))
      .map(async (f) => {
        try {
          const [buf] = await f.download();
          return JSON.parse(buf.toString()) as SubscriberRecord;
        } catch {
          return null;
        }
      }),
  );
  return records
    .filter((r): r is SubscriberRecord => !!r?.email)
    .sort((a, b) => (b.trialEndsAt ?? 0) - (a.trialEndsAt ?? 0));
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
  const parts = Buffer.from(payload, "base64url").toString().split("|");
  if (parts.length < 2) return null;
  const email = parts[0];
  const expiry = Number(parts[1]);
  if (!email.includes("@") || !Number.isFinite(expiry) || expiry < Date.now()) return null;
  return email;
}
