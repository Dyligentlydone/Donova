import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CompositionSpec } from "@editnce/contract";
import { probe, runFfmpeg } from "./ffmpeg.js";

/**
 * Deterministic <video> handling (03 §5).
 *
 * Chrome can't seek <video> frame-accurately during capture, so every video
 * clip's needed range is pre-extracted to PNGs at the render fps. At capture
 * time the runtime hides the <video> and swaps an overlaid <img> to the
 * correct frame. Frames land in `<project>/.editnce/frames/<hash>/` so the
 * static file server can reach them.
 */

export interface VideoMapEntry {
  /** CSS selector matching the <video> element (src-based, fallback). */
  selector: string;
  /** Index among all <video> elements in document order (authoritative). */
  index?: number;
  /** Frame file extension. */
  ext?: string;
  /** Directory of extracted frames, relative to project root (URL path). */
  dir: string;
  fps: number;
  /** Composition seconds when the media's first frame should show. */
  start: number;
  /** Duration in seconds to cover. */
  duration: number;
  /** Seconds into the source media where playback begins (trim). */
  trimStart: number;
  /** Playback rate. */
  speed: number;
  frameCount: number;
  /** Total frames extracted. */
}

export interface VideoMap {
  entries: VideoMapEntry[];
}

const CACHE_DIRNAME = ".editnce";
/** Opaque footage → JPG (fast decode/encode, ~10x smaller than PNG), as in
 *  HyperFrames videoFrameExtractor's `auto` format. Alpha footage → PNG. */
const FRAME_EXT = "jpg";
const ALPHA_FRAME_EXT = "png";

/** Pixel formats carrying an alpha channel. */
const ALPHA_PIXFMT = /^(yuva|rgba|bgra|argb|abgr|gbrap?|ya8|ya16|ayuv|pal8)/;

async function sourceHasAlpha(ffprobe: string, srcPath: string): Promise<boolean> {
  try {
    const p = await probe(ffprobe, srcPath);
    if (p.pixFmt && ALPHA_PIXFMT.test(p.pixFmt)) return true;
    // WebM alpha rides a stream tag (alpha_mode=1), not the main pix_fmt —
    // the mask lives in BlockAdditional data decoded by libvpx.
    if (p.alphaMode) return true;
    // VP9 stores alpha in a side channel; ffprobe exposes it via codec/pix_fmt
    // only in some builds — treat vp9-in-webm cautiously by checking pix_fmt suffix.
    if (p.codec === "vp9" && (p.pixFmt ?? "").includes("a")) return true;
    return false;
  } catch {
    return false;
  }
}

export async function prepareVideoFrames(
  ffmpeg: string,
  ffprobe: string,
  projectDir: string,
  spec: CompositionSpec,
  fps: number,
): Promise<VideoMap> {
  const entries: VideoMapEntry[] = [];
  const outBase = join(projectDir, CACHE_DIRNAME, "frames");

  const clipById = new Map(spec.clips.map((c) => [c.id, c]));

  // Collect video sources: timed <video> clips AND untimed <video> inside clips.
  const videoJobs: Array<{
    src: string;
    attrs: Record<string, string>;
    window: { start: number; duration: number };
    audioStart?: number;
    mediaIndex?: number;
  }> = [];
  for (const clip of spec.clips) {
    if (clip.media.kind === "video" && clip.media.src) {
      videoJobs.push({
        src: clip.media.src,
        attrs: clip.attrs,
        window: { start: clip.timing.start, duration: clip.timing.duration },
        audioStart: clip.audio.start,
        mediaIndex: clip.media.mediaIndex,
      });
    }
  }
  for (const mi of spec.mediaItems) {
    if (mi.kind !== "video") continue;
    const clip = mi.clipId ? clipById.get(mi.clipId) : undefined;
    videoJobs.push({
      src: mi.src,
      attrs: mi.attrs,
      window: clip
        ? { start: clip.timing.start, duration: clip.timing.duration }
        : { start: 0, duration: spec.duration },
      mediaIndex: mi.mediaIndex,
    });
  }

  let vIdx = 0;
  for (const job of videoJobs) {
    const src = job.src;
    const hash = createHash("sha1").update(src).digest("hex").slice(0, 10);
    const dir = `${CACHE_DIRNAME}/frames/v${vIdx}-${hash}`;
    const absDir = join(outBase, `v${vIdx}-${hash}`);
    await mkdir(absDir, { recursive: true });

    const trimStart =
      Number(job.attrs["data-media-start"] ?? job.attrs["data-trim-start"] ?? job.audioStart ?? 0) || 0;
    const speed = Number(job.attrs["data-speed"] ?? job.attrs["data-playback-rate"] ?? "1") || 1;
    const duration = job.window.duration;
    const frameCount = Math.max(1, Math.ceil(duration * fps));
    const srcPath = join(projectDir, src);
    const alpha = await sourceHasAlpha(ffprobe, srcPath);
    const ext = alpha ? ALPHA_FRAME_EXT : FRAME_EXT;

    // Extract exactly the frames needed: media time [trimStart, trimStart + duration*speed].
    const mediaDur = duration * speed;
    const p = await probe(ffprobe, srcPath).catch(() => ({ codec: undefined }));
    // VP9 alpha requires the libvpx decoder (native vp9 drops the alpha plane).
    const decoderArgs = alpha && p.codec === "vp9" ? ["-c:v", "libvpx-vp9"] : [];
    await runFfmpeg(ffmpeg, [
      ...decoderArgs,
      "-ss",
      trimStart.toFixed(6),
      "-t",
      mediaDur.toFixed(6),
      "-i",
      srcPath,
      "-vf",
      `fps=${fps}`,
      ...(alpha ? [] : ["-q:v", "2"]),
      "-start_number",
      "0",
      "-f",
      "image2",
      join(absDir, `f%06d.${ext}`),
    ]);

    entries.push({
      selector: `video[src="${src}"]`,
      index: job.mediaIndex,
      ext,
      dir,
      fps,
      start: job.window.start,
      duration,
      trimStart,
      speed,
      frameCount,
    });
    vIdx++;
  }

  const map: VideoMap = { entries };
  const mapDir = join(projectDir, CACHE_DIRNAME);
  await mkdir(mapDir, { recursive: true });
  await writeFile(join(mapDir, "video-map.json"), JSON.stringify(map, null, 2));
  return map;
}
