import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateCaptionsHtml, normalizeTranscript } from "@donova/media";
import type { CutPlan, Transcript } from "@donova/media";
import { CliError, ERR } from "./errors.js";

/**
 * `donova captions` — generate a caption track into index.html from a
 * transcript + cuts plan (17 §4 / MV4). The transform itself lives in
 * @donova/media (shared with the cloud render-worker /run endpoint).
 */
export async function captionsCmd(opts: {
  dir: string;
  transcript: string;
  cuts?: string;
  mode?: "word" | "phrase";
  emphasis?: string[];
  maxPhraseWords?: number;
}): Promise<{ path: string; captions: number; mode: string }> {
  const dir = resolve(opts.dir);
  const transcriptPath = resolve(dir, opts.transcript);
  const transcript: Transcript = normalizeTranscript(JSON.parse(await readFile(transcriptPath, "utf8")));
  const plan: CutPlan | undefined = opts.cuts
    ? (JSON.parse(await readFile(resolve(dir, opts.cuts), "utf8")) as CutPlan)
    : undefined;

  const indexPath = join(dir, "index.html");
  const html = await readFile(indexPath, "utf8").catch(() => {
    throw new CliError(ERR.FILE_NOT_FOUND, `no index.html in ${dir}`);
  });

  try {
    const res = generateCaptionsHtml({
      html,
      transcript,
      plan,
      mode: opts.mode,
      emphasis: opts.emphasis,
      maxPhraseWords: opts.maxPhraseWords,
    });
    await writeFile(indexPath, res.html);
    return { path: indexPath, captions: res.captions, mode: res.mode };
  } catch (e) {
    throw new CliError(ERR.INVALID_PROJECT, e instanceof Error ? e.message : String(e));
  }
}
