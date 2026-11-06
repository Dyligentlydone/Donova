import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CompositionSpec, RenderPlan } from "@framecraft/contract";
import { encodeChunkToFile, openFrameSource, runFfmpeg } from "@framecraft/engine";

/**
 * Parallel rendering (03 §7, 04 §5).
 * Shards the frame range across N browser instances; each encodes its segment
 * to an intermediate file; the concat demuxer stitches them in order.
 */

export interface ParallelOpts {
  ffmpeg: string;
  serverUrl: string;
  composition: string;
  spec: CompositionSpec;
  plan: RenderPlan;
  workers: number;
  workDir: string;
  encoder: { crf?: number; codec?: "h264" | "h265" | "vp9" | "prores"; alpha?: boolean; preset?: string };
  onProgress?: (done: number, total: number) => void;
}

export async function renderParallel(opts: ParallelOpts): Promise<string> {
  const { plan, spec } = opts;
  const workers = Math.max(1, Math.min(opts.workers, plan.segments.length));
  const chunksDir = join(opts.workDir, "chunks");
  await mkdir(chunksDir, { recursive: true });

  // Distribute segments round-robin across workers, preserving order per worker.
  const buckets: Array<{ startFrame: number; frameCount: number }[]> = Array.from({ length: workers }, () => []);
  plan.segments.forEach((seg, i) => buckets[i % workers]?.push(seg));

  let done = 0;
  const url = `${opts.serverUrl}/${opts.composition}`;
  const results = await Promise.all(
    buckets.map(async (segs, w) => {
      const outs: string[] = [];
      for (const [i, seg] of segs.entries()) {
        const src = await openFrameSource({
          url,
          duration: spec.duration,
          fps: plan.fps,
          width: spec.width,
          height: spec.height,
          startFrame: seg.startFrame,
          endFrame: seg.startFrame + seg.frameCount,
          capture: { format: "png" },
          onProgress: (d, t) => {
            done += 1;
            void d;
            void t;
            opts.onProgress?.(done, plan.totalFrames);
          },
        });
        const name = `w${w}-s${i}.mp4`;
        const out = await encodeChunkToFile(
          {
            ffmpeg: opts.ffmpeg,
            out: "",
            dir: chunksDir,
            name,
            fps: plan.fps,
            width: spec.width,
            height: spec.height,
            crf: opts.encoder.crf,
            preset: opts.encoder.preset,
            codec: opts.encoder.codec ?? "h264",
            alpha: opts.encoder.alpha,
          },
          src.frames(),
        );
        await src.close();
        outs.push(out);
      }
      return outs;
    }),
  );

  // Concat in segment order (buckets interleaved → rebuild by segment order).
  const ordered: string[] = [];
  for (let i = 0; i < plan.segments.length; i++) {
    const w = i % workers;
    const idx = Math.floor(i / workers);
    const f = results[w]?.[idx];
    if (f) ordered.push(f);
  }
  const listPath = join(opts.workDir, "concat.txt");
  await writeFile(listPath, ordered.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
  const out = join(opts.workDir, "video-only.mp4");
  await runFfmpeg(opts.ffmpeg, ["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", out]);
  return out;
}
