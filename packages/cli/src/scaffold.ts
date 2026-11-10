import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { locateFfmpeg, probe } from "@editnce/engine";
import { planCuts, scaffoldFootage } from "@editnce/media";
import type { CutPlan, Transcript } from "@editnce/media";
import { CliError, ERR } from "./errors.js";

/**
 * `editnce scaffold <media>` — footage → neutral index.html (17 §3.4).
 * Optionally applies a cuts.json plan; otherwise keeps the whole file.
 */
export async function scaffoldCmd(opts: {
  media: string;
  cuts?: string;
  transcript?: string;
  width?: number;
  height?: number;
  dir?: string;
  out?: string;
}): Promise<{ path: string; segments: number; duration: number; width: number; height: number }> {
  const mediaAbs = resolve(opts.media);
  if (!existsSync(mediaAbs)) throw new CliError(ERR.FILE_NOT_FOUND, `media not found: ${mediaAbs}`);

  const { ffprobe } = await locateFfmpeg();
  const p = await probe(ffprobe, mediaAbs);
  if (!p.width || !p.height) {
    throw new CliError(ERR.INVALID_PROJECT, `cannot probe video dims: ${mediaAbs}`);
  }
  // Displayed dims: a ±90/±270 display matrix swaps width and height.
  const rot = Math.abs(p.rotation ?? 0);
  const dispW = rot === 90 || rot === 270 ? p.height : p.width;
  const dispH = rot === 90 || rot === 270 ? p.width : p.height;

  const dir = resolve(opts.dir ?? ".");
  await mkdir(dir, { recursive: true });

  // Media referenced relative to the composition when inside the project,
  // absolute otherwise (file server serves project root only → copy in).
  let src = basename(mediaAbs);
  if (resolve(join(dir, src)) !== mediaAbs) {
    const { copyFile } = await import("node:fs/promises");
    const assetsDir = join(dir, "assets");
    await mkdir(assetsDir, { recursive: true });
    await copyFile(mediaAbs, join(assetsDir, src));
    src = `assets/${src}`;
  }

  let plan: CutPlan;
  if (opts.cuts) {
    plan = JSON.parse(await readFile(resolve(opts.cuts), "utf8")) as CutPlan;
  } else if (opts.transcript) {
    const t = JSON.parse(await readFile(resolve(opts.transcript), "utf8")) as Transcript;
    plan = planCuts(t);
  } else {
    plan = {
      version: 1,
      source: src,
      silenceThreshold: 0,
      pad: 0,
      sourceDuration: p.duration,
      duration: p.duration,
      removed: 0,
      segments: [
        {
          srcStart: 0,
          srcEnd: p.duration,
          compStart: 0,
          duration: p.duration,
          wordStart: 0,
          wordEnd: -1,
        },
      ],
    };
  }

  const html = scaffoldFootage({
    source: src,
    outWidth: opts.width ?? dispW,
    outHeight: opts.height ?? dispH,
    plan,
  });
  const out = resolve(join(dir, opts.out ?? "index.html"));
  await writeFile(out, html);
  return {
    path: out,
    segments: plan.segments.length,
    duration: plan.duration,
    width: opts.width ?? dispW,
    height: opts.height ?? dispH,
  };
}
