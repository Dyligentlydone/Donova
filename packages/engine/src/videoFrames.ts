import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CompositionSpec } from "@framecraft/contract";
import { runFfmpeg } from "./ffmpeg.js";

/**
 * Deterministic <video> handling (03 §5).
 *
 * Chrome can't seek <video> frame-accurately during capture, so every video
 * clip's needed range is pre-extracted to PNGs at the render fps. At capture
 * time the runtime hides the <video> and swaps an overlaid <img> to the
 * correct frame. Frames land in `<project>/.framecraft/frames/<hash>/` so the
 * static file server can reach them.
 */

export interface VideoMapEntry {
  /** CSS selector matching the <video> element (src-based). */
  selector: string;
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

const CACHE_DIRNAME = ".framecraft";

export async function prepareVideoFrames(
  ffmpeg: string,
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
  }> = [];
  for (const clip of spec.clips) {
    if (clip.media.kind === "video" && clip.media.src) {
      videoJobs.push({
        src: clip.media.src,
        attrs: clip.attrs,
        window: { start: clip.timing.start, duration: clip.timing.duration },
        audioStart: clip.audio.start,
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
    });
  }

  let vIdx = 0;
  for (const job of videoJobs) {
    const src = job.src;
    const hash = createHash("sha1").update(src).digest("hex").slice(0, 10);
    const dir = `${CACHE_DIRNAME}/frames/v${vIdx}-${hash}`;
    const absDir = join(outBase, `v${vIdx}-${hash}`);
    await mkdir(absDir, { recursive: true });

    const trimStart = Number(job.attrs["data-trim-start"] ?? job.audioStart ?? 0) || 0;
    const speed = Number(job.attrs["data-speed"] ?? "1") || 1;
    const duration = job.window.duration;
    const frameCount = Math.max(1, Math.ceil(duration * fps));

    // Extract exactly the frames needed: media time [trimStart, trimStart + duration*speed].
    const mediaDur = duration * speed;
    await runFfmpeg(ffmpeg, [
      "-ss",
      trimStart.toFixed(6),
      "-t",
      mediaDur.toFixed(6),
      "-i",
      join(projectDir, src),
      "-vf",
      `fps=${fps}`,
      "-start_number",
      "0",
      "-f",
      "image2",
      join(absDir, "f%06d.png"),
    ]);

    entries.push({
      selector: `video[src="${src}"]`,
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
