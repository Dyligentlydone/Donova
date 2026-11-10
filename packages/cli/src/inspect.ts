import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseCompositionHtml, resolveTimeline } from "@donova/contract";
import { locateFfmpeg, probe } from "@donova/engine";
import { CliError, ERR } from "./errors.js";

/**
 * `donova probe <media>` — normalized media info for agents (17 §3.5).
 */
export async function probeCmd(media: string): Promise<Record<string, unknown>> {
  const p = resolve(media);
  const { ffprobe } = await locateFfmpeg();
  const r = await probe(ffprobe, p).catch(() => null);
  if (!r) throw new CliError(ERR.FILE_NOT_FOUND, `cannot probe: ${p}`);
  return {
    path: p,
    duration: r.duration,
    width: r.width,
    height: r.height,
    fps: r.fps,
    hasAudio: r.hasAudio,
    codec: r.codec,
    pixFmt: r.pixFmt,
    sampleRate: r.sampleRate,
    channels: r.channels,
  };
}

export interface TimelineClipInfo {
  id: string;
  tag: string;
  kind?: string;
  start: number;
  duration: number;
  src?: string;
  mediaIndex?: number;
  text?: string;
  hasAudio: boolean;
}

/**
 * `donova timeline <dir>` — resolved clip list (17 §3.5).
 * Agents use this to see the timeline without parsing HTML themselves.
 */
export async function timelineCmd(
  dir: string,
  composition = "index.html",
): Promise<{
  duration: number;
  width: number;
  height: number;
  fps?: number;
  clips: TimelineClipInfo[];
  mediaItems: number;
}> {
  const d = resolve(dir);
  const html = await readFile(join(d, composition), "utf8").catch(() => {
    throw new CliError(ERR.FILE_NOT_FOUND, `cannot read ${join(d, composition)}`);
  });
  const { spec } = parseCompositionHtml(html, { isRoot: true, path: composition });
  resolveTimeline(spec);
  return {
    duration: spec.duration,
    width: spec.width,
    height: spec.height,
    fps: spec.fps,
    clips: spec.clips.map((c) => ({
      id: c.id,
      tag: c.media.tag,
      kind: c.media.kind,
      start: c.timing.start,
      duration: c.timing.duration,
      src: c.media.src,
      mediaIndex: c.media.mediaIndex,
      text: c.textSnippet,
      hasAudio: c.audio.hasAudio,
    })),
    mediaItems: spec.mediaItems.length,
  };
}
