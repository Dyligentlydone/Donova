import { createHash } from "node:crypto";
import { Storage } from "@google-cloud/storage";

/**
 * GCS-backed rate limiting that survives instance churn. Counters live at
 * ratelimits/<action>/<sha256(ip)[:16]>/<yyyymmdd> — one small object per
 * caller per day. Read-modify-write is not atomic; that's fine for abuse
 * damping (worst case a few extra requests slip through under concurrency).
 */

const BUCKET = process.env.DONOVA_BUCKET || "donova-renders-donova-514500";
const storage = new Storage();
const bucket = storage.bucket(BUCKET);

export async function rateLimitHit(
  action: string,
  req: Request,
  maxPerDay: number,
): Promise<boolean> {
  const fwd = req.headers.get("x-forwarded-for") || "";
  const ip = fwd.split(",")[0]?.trim() || "unknown";
  const day = new Date().toISOString().slice(0, 10);
  const key = `ratelimits/${action}/${createHash("sha256").update(ip).digest("hex").slice(0, 16)}/${day}`;
  const file = bucket.file(key);
  try {
    let count = 0;
    const [buf] = await file.download().catch(() => [null]);
    if (buf) count = Number(JSON.parse(buf.toString("utf8"))?.count ?? 0);
    if (count >= maxPerDay) return false;
    await file.save(JSON.stringify({ count: count + 1, ip_hash: key.split("/")[2] }), {
      contentType: "application/json",
    });
    return true;
  } catch (err) {
    // Rate-limit infrastructure failing should not block legit claims —
    // log and allow; abuse pressure is bounded by per-user prefixes anyway.
    console.error("ratelimit check failed:", err);
    return true;
  }
}
