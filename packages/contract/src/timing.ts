import type { ClipSpec, CompositionSpec, RenderPlan, ResolvedTimeline } from "./types.js";

/**
 * Timing resolution (01 §4/§5).
 *
 * - Root clip windows are authored seconds.
 * - Clips inside a sub-composition are offset by the sub-composition clip's start
 *   on the parent timeline, and scaled when the parent sets data-speed.
 * - `data-clip-absolute` (05 §clip-absolute): the clip window is NOT re-scaled by
 *   parent speed; children keep absolute seconds on the root timeline.
 */

interface FlattenCtx {
  offset: number; // seconds added to clip starts (root time)
  scale: number; // time multiplier from ancestor data-speed
  compPath: string[];
}

function clipWindow(c: ClipSpec): { start: number; end: number } {
  const start = c.timing.start;
  const dur = c.timing.duration;
  const end = c.timing.end ?? start + dur;
  return { start, end: Math.max(start, end) };
}

export function resolveTimeline(
  root: CompositionSpec,
  subComps?: Map<string, CompositionSpec>, // key: relative path
): ResolvedTimeline {
  const out: ResolvedTimeline = { compositionId: root.id, duration: root.duration, clips: [], cuts: [] };
  const cuts = new Set<number>();

  const flattenComp = (spec: CompositionSpec, ctx: FlattenCtx): void => {
    for (const clip of spec.clips) {
      const w = clipWindow(clip);
      const absolute = clip.attrs["data-clip-absolute"] === "true";
      const localStart = absolute ? w.start : ctx.offset + w.start * ctx.scale;
      const localEnd = absolute ? w.end : ctx.offset + w.end * ctx.scale;
      const resolved = {
        clipId: clip.id,
        compPath: [...ctx.compPath, spec.id],
        start: localStart,
        end: localEnd,
        trackIndex: clip.attrs["data-track-index"] ? Number(clip.attrs["data-track-index"]) : undefined,
        audio: clip.audio.hasAudio ? clip.audio : undefined,
        media: clip.media,
      };
      out.clips.push(resolved);
      cuts.add(localStart);
      cuts.add(localEnd);

      // Recurse into sub-composition clips.
      const subSrc = clip.attrs["data-composition-src"];
      if (subSrc && subComps?.has(subSrc)) {
        const sub = subComps.get(subSrc);
        if (sub) {
          const speed = Number(clip.attrs["data-speed"] ?? "1") || 1;
          flattenComp(sub, {
            offset: localStart,
            scale: ctx.scale * speed,
            compPath: [...ctx.compPath, spec.id],
          });
        }
      }
    }
  };

  flattenComp(root, { offset: 0, scale: 1, compPath: [] });
  out.clips.sort((a, b) => a.start - b.start || a.end - b.end);
  out.cuts = [...cuts].filter((t) => t >= 0 && t <= root.duration).sort((a, b) => a - b);
  return out;
}

/**
 * Build a render plan (04 §3): fps/frame counts from root spec + options.
 * Segments are cut-bounded groups of frames for worker sharding.
 */
export function planRender(
  spec: CompositionSpec,
  timeline: ResolvedTimeline,
  opts: { fps?: number; segmentSeconds?: number } = {},
): RenderPlan {
  const fps = opts.fps ?? spec.fps ?? 30;
  const totalFrames = Math.max(1, Math.round(spec.duration * fps));

  const segSecs = Math.max(0.5, opts.segmentSeconds ?? 10);
  const boundaries = new Set<number>([0, spec.duration]);
  for (const c of timeline.cuts) boundaries.add(c);
  // Also split long runs at segmentSeconds multiples.
  for (let t = segSecs; t < spec.duration; t += segSecs) boundaries.add(t);
  const sorted = [...boundaries].sort((a, b) => a - b);

  const segments: RenderPlan["segments"] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const t0 = sorted[i] ?? 0;
    const t1 = sorted[i + 1] ?? t0;
    const startFrame = Math.round(t0 * fps);
    const endFrame = Math.min(totalFrames, Math.round(t1 * fps));
    if (endFrame > startFrame) segments.push({ startFrame, frameCount: endFrame - startFrame });
  }
  if (segments.length === 0) segments.push({ startFrame: 0, frameCount: totalFrames });

  return { fps, totalFrames, width: spec.width, height: spec.height, segments };
}
