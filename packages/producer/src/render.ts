import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseCompositionHtml, planRender, resolveTimeline } from "@framecraft/contract";
import { locateFfmpeg, prepareVideoFrames, renderVideoOnly, startFileServer } from "@framecraft/engine";
import { mixAudio, muxAudio, tracksFromClips } from "./audio.js";

export interface RenderOpts {
  /** Project directory containing the composition html. */
  projectDir: string;
  /** Composition file name within projectDir. */
  composition?: string;
  out: string;
  fps?: number;
  format?: "mp4" | "webm" | "mov" | "png-seq" | "gif" | "hls";
  quality?: "draft" | "standard" | "high";
  workers?: number;
  codec?: "h264" | "h265" | "vp9" | "prores";
  alpha?: boolean;
  /** Render only [startSec, endSec) of the composition (--range). */
  range?: { start: number; end: number };
  /** Capture scale; 0.5 halves output resolution (draft mode). */
  scale?: number;
  /** Stage timings for `render --profile`. */
  onStage?: (name: string, ms: number) => void;
  onProgress?: (done: number, total: number) => void;
}

export interface RenderResult {
  out: string;
  frames: number;
  fps: number;
  duration: number;
  width: number;
  height: number;
  beginFrame: boolean;
  /** Stage timings, present when onStage is provided. */
  stages?: Record<string, number>;
}

const QUALITY_CRF = { draft: 26, standard: 18, high: 12 } as const;

export async function render(opts: RenderOpts): Promise<RenderResult> {
  const projectDir = resolve(opts.projectDir);
  const compFile = opts.composition ?? "index.html";
  const html = await readFile(join(projectDir, compFile), "utf8");
  const { spec } = parseCompositionHtml(html, { isRoot: true, path: compFile });
  if (spec.errors.length) {
    const msgs = spec.errors.map((e) => `${e.rule}: ${e.message}`).join("\n");
    throw new Error(`composition has errors:\n${msgs}`);
  }
  const timeline = resolveTimeline(spec);
  const plan = planRender(spec, timeline, { fps: opts.fps });

  const { ffmpeg, ffprobe } = await locateFfmpeg();
  const stages: Record<string, number> = {};
  const stage = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    const r = await fn();
    stages[name] = (stages[name] ?? 0) + (Date.now() - t0);
    opts.onStage?.(name, stages[name]);
    return r;
  };

  // Deterministic media prep: extract per-frame images for every <video> clip so
  // capture never relies on Chrome's video seeking (03 §5).
  await stage("extract-frames", () => prepareVideoFrames(ffmpeg, ffprobe, projectDir, spec, plan.fps));

  // --range: seconds → frame window on the render plan.
  const frameRange = opts.range
    ? {
        start: Math.max(0, Math.floor(opts.range.start * plan.fps)),
        end: Math.min(plan.totalFrames, Math.ceil(opts.range.end * plan.fps)),
      }
    : undefined;
  const scale = opts.scale && opts.scale > 0 && opts.scale < 1 ? opts.scale : undefined;
  const encW = scale ? Math.round(spec.width * scale) : spec.width;
  const encH = scale ? Math.round(spec.height * scale) : spec.height;

  const server = await startFileServer(projectDir);
  try {
    const quality = opts.quality ?? "standard";
    const codec = opts.codec ?? (opts.format === "webm" ? "vp9" : opts.format === "mov" ? "prores" : "h264");
    const videoOnly = `${opts.out}.video-only.tmp${opts.format === "webm" ? ".webm" : ".mp4"}`;
    const workers = Math.max(1, opts.workers ?? 1);
    let frames = 0;
    let beginFrame = false;

    if (workers > 1) {
      const { renderParallel } = await import("./parallel.js");
      const workDir = join(projectDir, ".framecraft", `render-${Date.now()}`);
      const videoPath = await stage("capture+encode", () =>
        renderParallel({
          ffmpeg,
          serverUrl: server.url,
          composition: compFile,
          spec,
          plan,
          workers,
          workDir,
          range: frameRange,
          scale,
          encoder: { crf: QUALITY_CRF[quality], codec, alpha: opts.alpha },
          onProgress: opts.onProgress,
        }),
      );
      const { copyFile } = await import("node:fs/promises");
      await copyFile(videoPath, videoOnly);
      frames = frameRange ? frameRange.end - frameRange.start : plan.totalFrames;
      beginFrame = false;
    } else {
      const res = await stage("capture+encode", () =>
        renderVideoOnly({
          url: `${server.url}/${compFile}`,
          duration: spec.duration,
          fps: plan.fps,
          width: spec.width,
          height: spec.height,
          ffmpeg,
          out: videoOnly,
          startFrame: frameRange?.start,
          endFrame: frameRange?.end,
          encoder: {
            crf: QUALITY_CRF[quality],
            codec,
            alpha: opts.alpha,
          },
          encoderWidth: encW,
          encoderHeight: encH,
          // JPEG q80 is HyperFrames' default capture; PNG only when alpha is needed.
          capture: {
            format: opts.alpha ? "png" : "jpeg",
            jpegQuality: quality === "draft" ? 70 : quality === "high" ? 92 : 85,
            scale,
          },
          onProgress: opts.onProgress,
        }),
      );
      frames = res.frames;
      beginFrame = res.beginFrame;
    }

    // Audio: mix all audio-bearing clips into one track, mux with video.
    const jobs = tracksFromClips(spec);
    const mixed = jobs.length
      ? await stage("audio-mix", () =>
          mixAudio(ffmpeg, projectDir, jobs, join(projectDir, ".framecraft", "audio-mix.aac")),
        )
      : null;

    // Format fan-out (04 §7): mp4/webm/mov go through muxAudio; the rest are
    // derived from the video-only master.
    const fmt = opts.format ?? "mp4";
    if (fmt === "gif") {
      const { runFfmpeg } = await import("@framecraft/engine");
      await runFfmpeg(ffmpeg, [
        "-i",
        videoOnly,
        "-vf",
        "fps=15,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse=dither=bayer",
        "-loop",
        "0",
        opts.out,
      ]);
    } else if (fmt === "png-seq") {
      const { runFfmpeg } = await import("@framecraft/engine");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(opts.out, { recursive: true });
      await runFfmpeg(ffmpeg, ["-i", videoOnly, join(opts.out, "f%06d.png")]);
    } else if (fmt === "hls") {
      const { runFfmpeg } = await import("@framecraft/engine");
      const { mkdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(opts.out), { recursive: true });
      const withAudio = mixed ? ["-i", mixed, "-c:a", "aac", "-b:a", "192k"] : [];
      await runFfmpeg(ffmpeg, [
        "-i",
        videoOnly,
        ...withAudio,
        "-c:v",
        "libx264",
        "-crf",
        "20",
        "-hls_time",
        "4",
        "-hls_playlist_type",
        "vod",
        opts.out,
      ]);
    } else {
      await stage("mux", () =>
        muxAudio(ffmpeg, videoOnly, mixed, opts.out, {
          audioStart: opts.range?.start,
          audioDuration: frameRange ? (frameRange.end - frameRange.start) / plan.fps : undefined,
        }),
      );
    }

    const rangeSecs = frameRange ? (frameRange.end - frameRange.start) / plan.fps : spec.duration;
    return {
      out: opts.out,
      frames,
      fps: plan.fps,
      duration: rangeSecs,
      width: encW,
      height: encH,
      beginFrame,
      stages: Object.keys(stages).length ? stages : undefined,
    };
  } finally {
    await server.close();
  }
}
