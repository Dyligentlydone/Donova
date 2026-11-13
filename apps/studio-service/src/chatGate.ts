import { createHash } from "node:crypto";
import { Storage } from "@google-cloud/storage";

/**
 * Chat allowance for the in-Studio agent bridge — mirrors the web app's
 * subscriber caps (apps/web/lib/subscribers.ts) against the same records at
 * subscribers/<sha256(email)>.json so dashboard chat and Studio chat draw
 * from one pool: trial = 25 lifetime, paid = 300/month, owners uncapped.
 *
 * Same soft-cap caveat as the web path: GCS read-modify-write can lose an
 * increment under concurrent containers; acceptable for quotas.
 */

const BUCKET_NAME = process.env.DONOVA_BUCKET || "donova-renders-donova-514500";
const OWNER_EMAIL = "owner@donova.local"; // master gate token identity
const OWNER_EMAILS = (process.env.DONOVA_OWNER_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export const TRIAL_CHAT_LIMIT = 25;
export const PAID_CHAT_MONTHLY = 300;
export const PAID_TOKEN_MONTHLY = 4_000_000; // in+out; matches web's abuse backstop

interface SubscriberRecord {
  email?: string;
  status?: string;
  trialEndsAt?: number;
  trialChats?: number;
  usage?: { month: string; chats: number; tokensIn: number; tokensOut: number };
}

const bucket = new Storage().bucket(BUCKET_NAME);
const keyFor = (email: string) =>
  `subscribers/${createHash("sha256").update(email.trim().toLowerCase()).digest("hex")}.json`;

async function readRecord(email: string): Promise<SubscriberRecord | null> {
  try {
    const [buf] = await bucket.file(keyFor(email)).download();
    return JSON.parse(buf.toString()) as SubscriberRecord;
  } catch {
    return null;
  }
}

const isOwner = (email: string) => {
  const e = email.trim().toLowerCase();
  return e === OWNER_EMAIL || OWNER_EMAILS.includes(e);
};

/** May this email send an agent chat right now? (does NOT consume one) */
export async function studioChatGate(email: string): Promise<{ allowed: boolean; reason?: string }> {
  const e = email.trim().toLowerCase();
  if (isOwner(e)) return { allowed: true };
  const rec = await readRecord(e);
  if (rec?.status === "active") {
    const month = new Date().toISOString().slice(0, 7);
    const u = rec.usage?.month === month ? rec.usage : undefined;
    const usedTokens = (u?.tokensIn ?? 0) + (u?.tokensOut ?? 0);
    if ((u?.chats ?? 0) >= PAID_CHAT_MONTHLY || usedTokens >= PAID_TOKEN_MONTHLY) {
      return {
        allowed: false,
        reason: `Monthly AI edit limit reached (${PAID_CHAT_MONTHLY} chats). Resets on the 1st.`,
      };
    }
    return { allowed: true };
  }
  if (rec?.status === "trial" && (rec.trialEndsAt ?? 0) > Date.now()) {
    if ((rec.trialChats ?? 0) >= TRIAL_CHAT_LIMIT) {
      return {
        allowed: false,
        reason: `Trial includes ${TRIAL_CHAT_LIMIT} AI chats — subscribe to keep editing with the agent.`,
      };
    }
    return { allowed: true };
  }
  return { allowed: false, reason: "No active plan." };
}

/** Consume one chat from the account's allowance (fire-and-forget safe). */
export async function recordStudioChat(email: string): Promise<void> {
  const e = email.trim().toLowerCase();
  if (isOwner(e)) return;
  const rec = (await readRecord(e)) ?? { email: e };
  if (rec.status === "trial") {
    rec.trialChats = (rec.trialChats ?? 0) + 1;
  } else {
    const month = new Date().toISOString().slice(0, 7);
    if (rec.usage?.month !== month) rec.usage = { month, chats: 0, tokensIn: 0, tokensOut: 0 };
    rec.usage.chats += 1;
  }
  await bucket.file(keyFor(e)).save(JSON.stringify(rec), { contentType: "application/json" });
}
