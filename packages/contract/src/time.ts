/**
 * Time parsing. Contract rule: bare numbers are SECONDS (never frames, never ms).
 * Strings accept "SS", "SS.mmm", "MM:SS", "MM:SS.mmm", "HH:MM:SS(.mmm)".
 * Also accepted (explicit units): "500ms", "2s", "1.5min", "30f" ONLY with fps context.
 */
export function parseTime(v: string | number | undefined | null, fps?: number): number | undefined {
  if (v == null || v === "") return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  const s = v.trim();
  if (s === "") return undefined;

  // Explicit units.
  const unitMatch = /^(-?\d+(?:\.\d+)?)(ms|s|min|f)$/.exec(s);
  if (unitMatch) {
    const n = Number(unitMatch[1]);
    switch (unitMatch[2]) {
      case "ms":
        return n / 1000;
      case "s":
        return n;
      case "min":
        return n * 60;
      case "f":
        return fps ? n / fps : undefined;
    }
  }

  // Colon-separated: [HH:]MM:SS(.mmm)
  if (s.includes(":")) {
    const parts = s.split(":");
    if (parts.length < 2 || parts.length > 3) return undefined;
    const nums = parts.map(Number);
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) return undefined;
    if (parts.length === 2) return (nums[0] ?? 0) * 60 + (nums[1] ?? 0);
    return (nums[0] ?? 0) * 3600 + (nums[1] ?? 0) * 60 + (nums[2] ?? 0);
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** Format seconds → "MM:SS.mmm" for display + ffmpeg args where needed. */
export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds)) return "00:00.000";
  const neg = seconds < 0;
  const abs = Math.abs(seconds);
  const m = Math.floor(abs / 60);
  const s = abs - m * 60;
  const str = `${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
  return neg ? `-${str}` : str;
}

/** Parse a boolean-ish data attribute: "true"/"1"/"" = true; "false"/"0" = false. */
export function parseBool(v: string | undefined | null, fallback = false): boolean {
  if (v == null) return fallback;
  if (v === "" || v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return fallback;
}
