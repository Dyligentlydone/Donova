import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeTranscript, planCuts } from "@framecraft/media";
import type { Transcript } from "@framecraft/media";
import { CliError, ERR } from "./errors.js";

/**
 * `framecraft cuts <transcript.json>` → cut plan JSON (17 §3.3).
 * Dead-air removal at word boundaries; no style decisions.
 */
export async function cutsCmd(opts: {
  transcript: string;
  threshold?: number;
  pad?: number;
  out?: string;
}): Promise<{ path: string; segments: number; duration: number; removed: number }> {
  const inPath = resolve(opts.transcript);
  let transcript: Transcript;
  try {
    const raw = JSON.parse(await readFile(inPath, "utf8")) as unknown;
    transcript = normalizeTranscript(raw);
  } catch {
    throw new CliError(
      ERR.FILE_NOT_FOUND,
      `cannot read transcript: ${inPath}`,
      "Run `framecraft transcribe <media>` first.",
    );
  }
  if (transcript.words.length === 0) {
    throw new CliError(ERR.INVALID_PROJECT, `${inPath} has no transcript words.`);
  }
  const plan = planCuts(transcript, { silenceThreshold: opts.threshold, pad: opts.pad });
  const out = resolve(opts.out ?? "cuts.json");
  await writeFile(out, `${JSON.stringify(plan, null, 2)}\n`);
  return { path: out, segments: plan.segments.length, duration: plan.duration, removed: plan.removed };
}
