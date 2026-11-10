import {
  ATTR,
  type CompositionSpec,
  type ContractIssue,
  parseCompositionHtml,
  parseMotionAttr,
} from "@editnce/contract";

/**
 * Static lint — 07 §2. Runs purely on parsed HTML; no browser needed.
 * Rules are additive; each returns ContractIssue with severity + suggestion.
 */

export function lintHtml(
  html: string,
  opts?: { path?: string; isRoot?: boolean },
): { spec: CompositionSpec; issues: ContractIssue[] } {
  const { spec } = parseCompositionHtml(html, opts);
  const issues: ContractIssue[] = [...spec.errors, ...spec.warnings];

  // --- Determinism hazards (07 §3) ---
  const hazards: Array<[RegExp, string]> = [
    [/\bDate\.now\s*\(/, "Date.now() is non-deterministic. Use composition time."],
    [/\bnew\s+Date\s*\(/, "new Date() is non-deterministic."],
    [/\bMath\.random\s*\(/, "Math.random() is non-deterministic. Use a seeded PRNG."],
    [/\bfetch\s*\(\s*['"]https?:/, "Runtime network fetch — bundle media locally."],
    [/setInterval\s*\(/, "setInterval drifts under frame capture. Use timeline callbacks."],
    [/requestAnimationFrame\s*\(\s*(?!.*__fc)/, "rAF outside the runtime is non-deterministic."],
    [/\bperformance\.now\s*\(/, "performance.now() is non-deterministic in captured frames."],
  ];
  for (const [re, msg] of hazards) {
    if (re.test(html)) {
      issues.push({ rule: "nondeterministic-api", severity: "error", message: msg, file: opts?.path });
    }
  }

  // --- Root contract ---
  if (spec.isRoot) {
    if (!spec.duration || spec.duration <= 0) {
      issues.push({
        rule: "missing-duration",
        severity: "error",
        message: "Root composition needs a positive data-duration.",
      });
    }
    if (!spec.width || !spec.height) {
      issues.push({
        rule: "missing-size",
        severity: "error",
        message: "Root composition needs data-width and data-height.",
      });
    }
  }

  // --- Clips ---
  for (const clip of spec.clips) {
    if (clip.timing.start < 0) {
      issues.push({
        rule: "clip-negative-start",
        severity: "error",
        message: `Clip ${clip.id} starts < 0.`,
        clipId: clip.id,
      });
    }
    if (spec.isRoot && clip.timing.start + clip.timing.duration > spec.duration + 1e-6) {
      issues.push({
        rule: "clip-past-duration",
        severity: "warn",
        message: `Clip ${clip.id} extends past composition duration ${spec.duration}s.`,
        clipId: clip.id,
      });
    }
    const motion = parseMotionAttr(clip.attrs[ATTR.motion]);
    for (const mi of motion.issues) issues.push({ ...mi, clipId: clip.id, file: opts?.path });
    if (clip.attrs[ATTR.speed] != null) {
      const s = Number(clip.attrs[ATTR.speed]);
      if (!Number.isFinite(s) || s <= 0) {
        issues.push({
          rule: "invalid-speed",
          severity: "error",
          message: `data-speed must be > 0 (clip ${clip.id}).`,
          clipId: clip.id,
        });
      }
    }
  }

  // --- Timeline registration ---
  if (
    spec.isRoot &&
    spec.clips.length > 0 &&
    !spec.clips.some((c) => c.attrs["data-fc-motion"] != null) &&
    spec.timelines.length === 0
  ) {
    // Timed clips but no animation runtime at all is suspicious only when there are
    // visible clips meant to animate — keep as info.
    issues.push({
      rule: "no-animations",
      severity: "info",
      message: `No ${"__timelines"} registration found; only clip visibility/motion attrs will animate.`,
    });
  }

  // --- Media refs must exist locally or be remote-downloadable ---
  for (const m of spec.mediaRefs) {
    if (m.src.startsWith("data:")) continue;
    if (!m.remote && m.src.includes("://")) {
      issues.push({ rule: "bad-media-src", severity: "error", message: `Suspicious media src "${m.src}".` });
    }
  }

  return { spec, issues };
}

export function formatIssues(issues: ContractIssue[]): string {
  const icons = { error: "✖", warn: "▲", info: "•" } as const;
  return issues
    .map((i) => `${icons[i.severity]} ${i.rule}: ${i.message}${i.suggestion ? `\n   → ${i.suggestion}` : ""}`)
    .join("\n");
}

export function summarize(issues: ContractIssue[]): { errors: number; warnings: number; info: number } {
  return {
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warn").length,
    info: issues.filter((i) => i.severity === "info").length,
  };
}
