import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ClipSpec, CompositionSpec } from "@framecraft/contract";
import { runFfmpeg } from "@framecraft/engine";

/**
 * Audio pipeline (03 §4, 04 §9).
 *
 * Every audio-bearing element contributes one FFmpeg input. A single
 * filter_complex graph applies per-clip trim (atrim/atrim for video audio),
 * resample to 48k, volume + fade envelope, adelay to its timeline offset,
 * then amix normalize=0 → final track muxed with the rendered video.
 */

export interface AudioTrackJob {
  src: string; // project-relative media path
  /** composition seconds when this audio starts on the root timeline */
  timelineStart: number;
  /** seconds into the source file */
  mediaStart: number;
  /** seconds of audio to take (defaults to clip window) */
  duration: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  speed: number; // media speed (video data-speed)
}

function tracksFromClips(
  root: CompositionSpec,
  compFor?: (sub: string) => CompositionSpec | undefined,
): AudioTrackJob[] {
  const jobs: AudioTrackJob[] = [];
  const walk = (spec: CompositionSpec, offset: number, scale: number): void => {
    const _clipById = new Map(spec.clips.map((c) => [c.id, c]));
    for (const clip of spec.clips) {
      const abs = clip.attrs["data-clip-absolute"] === "true";
      const localScale = abs ? 1 : scale;
      const start = abs ? clip.timing.start : offset + clip.timing.start * scale;
      const end = abs
        ? (clip.timing.end ?? clip.timing.start + clip.timing.duration)
        : offset + (clip.timing.end ?? clip.timing.start + clip.timing.duration) * scale;
      if (clip.audio.hasAudio && clip.media.src) {
        jobs.push({
          src: clip.media.src,
          timelineStart: start + (clip.audio.offset ?? 0) * localScale,
          mediaStart: clip.audio.start ?? 0,
          duration: end - start,
          volume: clip.audio.volume ?? 1,
          fadeIn: clip.audio.fadeIn ?? 0,
          fadeOut: clip.audio.fadeOut ?? 0,
          speed: Number(clip.attrs["data-speed"] ?? "1") || 1,
        });
      }
      // Untimed <audio>/<video> children inside this clip inherit its window.
      for (const mi of spec.mediaItems) {
        if (mi.clipId !== clip.id || (mi.kind !== "audio" && mi.kind !== "video")) continue;
        const isAudio = mi.kind === "audio";
        const vidAudio =
          mi.kind === "video" && mi.attrs["data-has-audio"] !== "false" && mi.attrs.muted === undefined;
        if (!isAudio && !vidAudio) continue;
        const aOffset = Number(mi.attrs["data-audio-offset"] ?? "0") || 0;
        const aStart = Number(mi.attrs["data-media-start"] ?? mi.attrs["data-audio-start"] ?? "0") || 0;
        jobs.push({
          src: mi.src,
          timelineStart: start + aOffset * localScale,
          mediaStart: aStart,
          duration: end - start,
          volume: Number(mi.attrs["data-volume"] ?? "1") || 1,
          fadeIn: Number(mi.attrs["data-audio-fade-in"] ?? "0") || 0,
          fadeOut: Number(mi.attrs["data-audio-fade-out"] ?? "0") || 0,
          speed: Number(mi.attrs["data-speed"] ?? "1") || 1,
        });
      }
      const subSrc = clip.attrs["data-composition-src"];
      if (subSrc && compFor) {
        const sub = compFor(subSrc);
        if (sub) {
          const speed = Number(clip.attrs["data-speed"] ?? "1") || 1;
          walk(sub, start, localScale * speed);
        }
      }
    }
  };
  walk(root, 0, 1);
  return jobs;
}

export function buildAudioGraph(jobs: AudioTrackJob[]): {
  inputs: string[];
  filter: string;
  hasAudio: boolean;
} {
  if (jobs.length === 0) return { inputs: [], filter: "", hasAudio: false };
  const inputs: string[] = [];
  const chains: string[] = [];
  const mixLabels: string[] = [];
  jobs.forEach((j, i) => {
    inputs.push(j.src);
    const inLabel = `[${i}:a]`;
    const outLabel = `[a${i}]`;
    const parts: string[] = [];
    const pre: string[] = [];
    if (j.mediaStart > 0 || j.duration > 0) {
      // atrim cuts MEDIA seconds: a speed != 1 clip consumes duration*speed of
      // source, and atempo then stretches/shrinks it back to the film slot.
      pre.push(
        `atrim=start=${j.mediaStart.toFixed(6)}:duration=${(j.duration * j.speed).toFixed(6)}`,
        "asetpts=PTS-STARTPTS",
      );
    }
    if (j.speed !== 1) pre.push(`atempo=${j.speed.toFixed(6)}`);
    const vols: string[] = [];
    if (j.volume !== 1) vols.push(`volume=${j.volume.toFixed(4)}`);
    if (j.fadeIn > 0) vols.push(`afade=t=in:st=0:d=${j.fadeIn.toFixed(6)}`);
    if (j.fadeOut > 0) {
      const st = Math.max(0, j.duration - j.fadeOut);
      vols.push(`afade=t=out:st=${st.toFixed(6)}:d=${j.fadeOut.toFixed(6)}`);
    }
    parts.push(...pre, ...vols);
    const delayMs = Math.round(j.timelineStart * 1000);
    if (delayMs > 0) parts.push(`adelay=${delayMs}|${delayMs}`);
    if (parts.length === 0) parts.push("acopy");
    chains.push(`${inLabel}${parts.join(",")}${outLabel}`);
    mixLabels.push(outLabel);
  });
  const filter = `${chains.join(";")};${mixLabels.join("")}amix=inputs=${mixLabels.length}:normalize=0,aresample=48000,alimiter=limit=0.95[aout]`;
  return { inputs, filter, hasAudio: true };
}

/** Mix all audio tracks → single AAC file (48kHz). */
export async function mixAudio(
  ffmpeg: string,
  projectDir: string,
  jobs: AudioTrackJob[],
  outPath: string,
): Promise<string | null> {
  const g = buildAudioGraph(jobs);
  if (!g.hasAudio) return null;
  await mkdir(outPath.includes("/") ? outPath.slice(0, outPath.lastIndexOf("/")) : ".", { recursive: true });
  const args: string[] = [];
  for (const src of g.inputs) args.push("-i", join(projectDir, src));
  args.push(
    "-filter_complex",
    g.filter,
    "-map",
    "[aout]",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    outPath,
  );
  await runFfmpeg(ffmpeg, args, { cwd: projectDir });
  return outPath;
}

/** Mux a video-only file with the mixed audio → final output. */
export async function muxAudio(
  ffmpeg: string,
  videoPath: string,
  audioPath: string | null,
  outPath: string,
  opts?: { audioStart?: number; audioDuration?: number },
): Promise<string> {
  if (!audioPath) {
    if (videoPath !== outPath) {
      await runFfmpeg(ffmpeg, ["-i", videoPath, "-c", "copy", outPath]);
    }
    return videoPath === outPath ? outPath : outPath;
  }
  const webm = outPath.endsWith(".webm");
  const trim =
    opts?.audioStart != null || opts?.audioDuration != null
      ? [
          "-ss",
          (opts?.audioStart ?? 0).toFixed(6),
          ...(opts?.audioDuration != null ? ["-t", opts.audioDuration.toFixed(6)] : []),
        ]
      : [];
  await runFfmpeg(ffmpeg, [
    "-i",
    videoPath,
    ...trim,
    "-i",
    audioPath,
    "-c:v",
    "copy",
    "-c:a",
    webm ? "libopus" : "aac",
    "-b:a",
    "192k",
    "-shortest",
    ...(webm ? [] : ["-movflags", "+faststart"]),
    outPath,
  ]);
  return outPath;
}

export { tracksFromClips };
