/**
 * Opens the real Studio service for subscribers: /api/studio-link verifies the
 * subscriber record server-side and returns a signed URL. Non-subscribers get
 * 401/403 — callers should route them to subscribe.
 */
export async function openStudio(): Promise<"ok" | "no-account" | "not-subscribed" | "error"> {
  try {
    const res = await fetch("/api/studio-link");
    if (res.ok) {
      const data = (await res.json()) as { url?: string };
      if (data.url) {
        window.location.href = data.url;
        return "ok";
      }
      return "error";
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return data.error === "no-account" ? "no-account" : "not-subscribed";
  } catch {
    return "error";
  }
}
