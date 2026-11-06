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

  const { ffmpeg } = await locateFfmpeg();

  // Deterministic media prep: extract per-frame PNGs for every <video> clip so
  // capture never relies on Chrome's video seeking (03 §5).
  await prepareVideoFrames(ffmpeg, projectDir, spec, plan.fps);

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
      const videoPath = await renderParallel({
        ffmpeg,
        serverUrl: server.url,
        composition: compFile,
        spec,
        plan,
        workers,
        workDir,
        encoder: { crf: QUALITY_CRF[quality], codec, alpha: opts.alpha },
        onProgress: opts.onProgress,
      });
      const { copyFile } = await import("node:fs/promises");
      await copyFile(videoPath, videoOnly);
      frames = plan.totalFrames;
      beginFrame = false;
    } else {
      const res = await renderVideoOnly({
        url: `${server.url}/${compFile}`,
        duration: spec.duration,
        fps: plan.fps,
        width: spec.width,
        height: spec.height,
        ffmpeg,
        out: videoOnly,
        encoder: { crf: QUALITY_CRF[quality], codec, alpha: opts.alpha },
        capture: {
          format: quality === "draft" ? "jpeg" : "png",
          jpegQuality: 70,
        },
        onProgress: opts.onProgress,
      });
      frames = res.frames;
      beginFrame = res.beginFrame;
    }

    // Audio: mix all audio-bearing clips into one track, mux with video.
    const jobs = tracksFromClips(spec);
    const mixed = jobs.length
      ? await mixAudio(ffmpeg, projectDir, jobs, join(projectDir, ".framecraft", "audio-mix.aac"))
      : null;
    await muxAudio(ffmpeg, videoOnly, mixed, opts.out);

    return {
      out: opts.out,
      frames,
      fps: plan.fps,
      duration: spec.duration,
      width: spec.width,
      height: spec.height,
      beginFrame,
    };
  } finally {
    await server.close();
  }
}
