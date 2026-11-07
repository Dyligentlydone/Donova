import type { CutPlan, CutSegment, Transcript } from "./types.js";

/**
 * Dead-air removal at word boundaries (17 §3.3, ported from the fc-4063
 * build.py recipe — generalized, no style baked in).
 *
 * Splits the timeline wherever the gap between consecutive words exceeds
 * `silenceThreshold`. Each kept piece is padded ±`pad` seconds inside source
 * bounds, then pieces are laid contiguously on the output timeline.
 */
export function planCuts(
  transcript: Transcript,
  opts?: { silenceThreshold?: number; pad?: number },
): CutPlan {
  const silenceThreshold = opts?.silenceThreshold ?? 0.35;
  const pad = opts?.pad ?? 0.06;
  const words = transcript.words;
  const dur = transcript.duration;

  if (words.length === 0) {
    return {
      version: 1,
      source: transcript.source,
      silenceThreshold,
      pad,
      sourceDuration: dur,
      duration: dur,
      removed: 0,
      segments: [
        {
          srcStart: 0,
          srcEnd: dur,
          compStart: 0,
          duration: dur,
          wordStart: 0,
          wordEnd: -1,
        },
      ],
    };
  }

  // Group words into runs separated by > threshold gaps.
  const runs: Array<{ wordStart: number; wordEnd: number }> = [];
  let runStart = 0;
  for (let i = 1; i < words.length; i++) {
    const gap = (words[i]?.start ?? 0) - (words[i - 1]?.end ?? 0);
    if (gap > silenceThreshold) {
      runs.push({ wordStart: runStart, wordEnd: i - 1 });
      runStart = i;
    }
  }
  runs.push({ wordStart: runStart, wordEnd: words.length - 1 });

  const segments: CutSegment[] = [];
  let compStart = 0;
  for (const r of runs) {
    const first = words[r.wordStart];
    const last = words[r.wordEnd];
    if (!first || !last) continue;
    const srcStart = Math.max(0, first.start - pad);
    const srcEnd = Math.min(dur, last.end + pad);
    const duration = srcEnd - srcStart;
    segments.push({
      srcStart,
      srcEnd,
      compStart,
      duration,
      wordStart: r.wordStart,
      wordEnd: r.wordEnd,
    });
    compStart += duration;
  }

  return {
    version: 1,
    source: transcript.source,
    silenceThreshold,
    pad,
    sourceDuration: dur,
    duration: compStart,
    removed: Math.max(0, dur - compStart),
    segments,
  };
}

/** Map a source-media time to output-timeline time (or null if it was cut). */
export function sourceToComp(plan: CutPlan, srcT: number): number | null {
  for (const s of plan.segments) {
    if (srcT >= s.srcStart && srcT <= s.srcEnd) return s.compStart + (srcT - s.srcStart);
  }
  return null;
}

/** Map an output-timeline time back to source-media time. */
export function compToSource(plan: CutPlan, compT: number): number | null {
  for (const s of plan.segments) {
    if (compT >= s.compStart && compT <= s.compStart + s.duration) {
      return s.srcStart + (compT - s.compStart);
    }
  }
  return null;
}
