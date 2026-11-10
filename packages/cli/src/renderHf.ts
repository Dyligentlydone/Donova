import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runHyperframes } from "./hf.js";

/**
 * Render through the hyperframes engine — chosen by engineRoute when the
 * composition uses Studio-only features our producer doesn't implement yet.
 * Maps our render flags onto theirs; output lands at the same path the
 * editnce engine would have used.
 */

export interface HfRenderOptions {
  projectDir: string;
  composition: string;
  out: string;
  fps?: number;
  quality: string;
  format: string;
  workers: number;
  range?: string;
  scale?: number;
  json: boolean;
}

export interface HfRenderResult {
  out: string;
  width?: number;
  height?: number;
  fps?: number;
  frames?: number;
  duration?: number;
}

const QUALITY_MAP: Record<string, string> = { draft: "draft", standard: "standard", high: "high" };
const FORMAT_MAP: Record<string, string> = {
  mp4: "mp4",
  webm: "webm",
  mov: "mov",
  gif: "gif",
  "png-seq": "png-sequence",
  hls: "hls",
};

export async function renderViaHyperframes(opts: HfRenderOptions): Promise<HfRenderResult> {
  const projectDir = resolve(opts.projectDir);
  const out = resolve(opts.out);
  const args = ["render", projectDir, "-o", out, "-c", opts.composition];
  if (opts.fps) args.push("--fps", String(opts.fps));
  args.push("-q", QUALITY_MAP[opts.quality] ?? "standard");
  args.push("--format", FORMAT_MAP[opts.format] ?? "mp4");
  if (opts.workers > 1) args.push("-w", String(opts.workers));
  if (opts.range) {
    const m = /^\s*([\d.]+)\s*-\s*([\d.]+)\s*$/.exec(opts.range);
    if (m) args.push("--start", m[1] as string, "--end", m[2] as string);
  }
  if (opts.scale && opts.scale !== 1) {
    // hyperframes takes an absolute --resolution; derive from the comp root
    const root = readFileSync(resolve(projectDir, opts.composition), "utf8");
    const w = Number(/data-width=["'](\d+)/.exec(root)?.[1]);
    const h = Number(/data-height=["'](\d+)/.exec(root)?.[1]);
    if (w && h) args.push("--resolution", `${Math.round(w * opts.scale)}x${Math.round(h * opts.scale)}`);
  }
  if (opts.json) args.push("--quiet");
  const code = await runHyperframes(args, projectDir);
  if (code !== 0) throw new Error(`hyperframes render exited ${code}`);
  if (!existsSync(out)) throw new Error(`hyperframes render produced no file at ${out}`);
  return { out };
}
