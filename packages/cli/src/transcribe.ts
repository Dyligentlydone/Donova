import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { transcribe as runTranscribe } from "@framecraft/media";
import { CliError, ERR } from "./errors.js";

/**
 * `framecraft transcribe <media>` → transcript.json next to the media (17 §3.2).
 */
export async function transcribeCmd(opts: {
  media: string;
  model?: string;
  out?: string;
  json?: boolean;
  onBytes?: (n: number) => void;
}): Promise<{ path: string; words: number; duration: number; model: string }> {
  const mediaPath = resolve(opts.media);
  const t = await runTranscribe(mediaPath, {
    model: opts.model ?? "small.en",
    onBytes: opts.json ? undefined : opts.onBytes,
  }).catch((e: Error) => {
    const msg = e.message ?? String(e);
    if (/not found|ENOENT/.test(msg) && /whisper/i.test(msg)) {
      throw new CliError(ERR.BINARY_MISSING, msg, "brew install whisper-cpp");
    }
    if (/SHA-256|unknown whisper/.test(msg)) throw new CliError(ERR.MODEL_ERROR, msg);
    if (/ENOENT/.test(msg)) throw new CliError(ERR.FILE_NOT_FOUND, `media not found: ${mediaPath}`);
    throw new CliError(ERR.PROVIDER_ERROR, msg);
  });
  const out = resolve(opts.out ?? join(dirname(mediaPath), "transcript.json"));
  await writeFile(out, `${JSON.stringify(t, null, 2)}\n`);
  return { path: out, words: t.words.length, duration: t.duration, model: t.model };
}
