import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { isSubscriber } from "./subscribers";

/**
 * Signed account cookie (`donova_account`) — proves the caller owns the email
 * it names without a database lookup. Same HMAC scheme as Studio gate tokens;
 * the unsigned `donova_email` cookie is display-only and NEVER trusted for
 * auth decisions.
 */

const SECRET = process.env.STUDIO_GATE_SECRET || "";
export const ACCOUNT_COOKIE = "donova_account";
export const ACCOUNT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function signAccount(email: string, ttlMs = ACCOUNT_TTL_MS): string {
  const payload = Buffer.from(`${email.trim().toLowerCase()}|${Date.now() + ttlMs}`).toString(
    "base64url",
  );
  const sig = createHmac("sha256", SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

export function verifyAccountCookie(value: string | undefined): string | null {
  if (!value || !SECRET) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expect = createHmac("sha256", SECRET).update(payload).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const parts = Buffer.from(payload, "base64url").toString().split("|");
  if (parts.length < 2) return null;
  const email = parts[0];
  const exp = Number(parts[1]);
  if (!email.includes("@") || !Number.isFinite(exp) || exp < Date.now()) return null;
  return email;
}

/** Signed account cookie → email, or null when absent/forged/expired. */
export async function authedEmail(): Promise<string | null> {
  const value = (await cookies()).get(ACCOUNT_COOKIE)?.value;
  return verifyAccountCookie(value);
}

type Authed = { email: string } | { error: NextResponse };

/**
 * Gate for the project API surface: requires a signed account cookie AND an
 * active subscriber/trial record. Returns { email } on success or a ready
 * 401/403 response.
 */
export async function requireSubscriber(): Promise<Authed> {
  const email = await authedEmail();
  if (!email) {
    return { error: NextResponse.json({ ok: false, error: "no-account" }, { status: 401 }) };
  }
  if (!(await isSubscriber(email))) {
    return {
      error: NextResponse.json({ ok: false, error: "not-subscribed" }, { status: 403 }),
    };
  }
  return { email };
}
