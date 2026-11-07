import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CompositionSpec, RenderPlan } from "@framecraft/contract";
import { encodeChunkToFile, openFrameSource, runFfmpeg } from "@framecraft/engine";

/**
 * Parallel rendering (03 §7, 04 §5).
 * Mirrors HyperFrames parallelCoordinator.distributeFrames: the frame range is
 * split into N equal contiguous ranges, one browser per worker, each encoded
 * to one chunk; the concat demuxer stitches them in order. A worker whose
 * browser dies is retried once on a fresh instance.
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
  /** Restrict to a frame sub-range (--range). Defaults to the whole plan. */
  range?: { start: number; end: number };
  /** Capture scale (draft mode). Encoder gets scaled pixel dims. */
  scale?: number;
  onProgress?: (done: number, total: number) => void;
}

/** Equal contiguous ranges (HyperFrames distributeFrames). */
export function distributeFrames(
  totalFrames: number,
  workers: number,
): Array<{ start: number; end: number }> {
  const per = Math.ceil(totalFrames / workers);
  const out: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < workers; i++) {
    const start = i * per;
    if (start >= totalFrames) break;
    out.push({ start, end: Math.min(totalFrames, start + per) });
  }
  return out;
}

export async function renderParallel(opts: ParallelOpts): Promise<string> {
  const { plan, spec } = opts;
  const chunksDir = join(opts.workDir, "chunks");
  await mkdir(chunksDir, { recursive: true });
  const frameStart = opts.range?.start ?? 0;
  const frameEnd = opts.range?.end ?? plan.totalFrames;
  const rangeLen = Math.max(0, frameEnd - frameStart);
  const ranges = distributeFrames(rangeLen, Math.max(1, opts.workers)).map((r) => ({
    start: r.start + frameStart,
    end: r.end + frameStart,
  }));
  const encW = opts.scale ? Math.round(spec.width * opts.scale) : spec.width;
  const encH = opts.scale ? Math.round(spec.height * opts.scale) : spec.height;
  const url = `${opts.serverUrl}/${opts.composition}`;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const progress = new Array<number>(ranges.length).fill(0);
  const report = () =>
    opts.onProgress?.(
      progress.reduce((a, b) => a + b, 0),
      rangeLen,
    );

  const outs = await Promise.all(
    ranges.map(async (r, w) => {
      // Stagger cold starts so N browsers don't contend at once.
      if (w > 0) await sleep(w * 800);
      const name = `chunk-${String(w).padStart(3, "0")}.mp4`;
      let lastErr: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        progress[w] = 0;
        let src: Awaited<ReturnType<typeof openFrameSource>> | undefined;
        try {
          src = await openFrameSource({
            url,
            duration: spec.duration,
            fps: plan.fps,
            width: spec.width,
            height: spec.height,
            startFrame: r.start,
            endFrame: r.end,
            capture: {
              format: opts.encoder.alpha ? "png" : "jpeg",
              jpegQuality: 85,
              scale: opts.scale,
              alpha: opts.encoder.alpha,
            },
            onProgress: (d) => {
              progress[w] = d;
              report();
            },
          });
          return await encodeChunkToFile(
            {
              ffmpeg: opts.ffmpeg,
              out: "",
              dir: chunksDir,
              name,
              fps: plan.fps,
              width: encW,
              height: encH,
              crf: opts.encoder.crf,
              preset: opts.encoder.preset,
              codec: opts.encoder.codec ?? "h264",
              alpha: opts.encoder.alpha,
            },
            src.frames(),
          );
        } catch (e) {
          lastErr = e;
        } finally {
          await src?.close().catch(() => {});
        }
      }
      throw new Error(`worker ${w} (frames ${r.start}-${r.end}) failed: ${String(lastErr)}`);
    }),
  );

  const listPath = join(opts.workDir, "concat.txt");
  await writeFile(listPath, outs.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
  const out = join(opts.workDir, "video-only.mp4");
  await runFfmpeg(opts.ffmpeg, [
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    out,
  ]);
  return out;
}
