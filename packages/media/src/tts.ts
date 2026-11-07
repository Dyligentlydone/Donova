import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * TTS (MV9). Provider interface with a local `say` fallback on macOS;
 * other providers plug in via the same shape. Returns the audio file plus
 * its duration so callers can lay the clip on the timeline.
 */
export type TtsProvider = "say" | "edge" | "kokoro";

export interface TtsResult {
  path: string;
  duration: number;
  provider: TtsProvider;
  voice: string;
}

async function durationOf(ffprobe: string, file: string): Promise<number> {
  const { stdout } = await execFileP(ffprobe, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    file,
  ]);
  return Number(stdout.trim()) || 0;
}

async function sayProvider(
  text: string,
  out: string,
  voice: string | undefined,
  ffmpeg: string,
): Promise<void> {
  const tmp = join(await mkdtemp(join(tmpdir(), "fc-tts-")), "vo.aiff");
  const args = ["-o", tmp];
  if (voice) args.push("-v", voice);
  args.push(text);
  await execFileP("say", args);
  await execFileP(ffmpeg, ["-y", "-i", tmp, "-ar", "48000", "-ac", "1", out]);
}

export async function tts(opts: {
  text: string;
  out: string;
  voice?: string;
  provider?: TtsProvider;
  ffmpeg?: string;
  ffprobe?: string;
}): Promise<TtsResult> {
  const ffmpeg = opts.ffmpeg ?? "ffmpeg";
  const ffprobe = opts.ffprobe ?? "ffprobe";
  const provider: TtsProvider =
    opts.provider ??
    (process.platform === "darwin" ? "say" : (() => {
      throw new Error(
        `no default TTS provider on ${process.platform}. Pass --provider (say|edge|kokoro).`,
      );
    })());

  switch (provider) {
    case "say":
      if (process.platform !== "darwin" || !existsSync("/usr/bin/say")) {
        throw new Error("say provider requires macOS");
      }
      await sayProvider(opts.text, opts.out, opts.voice, ffmpeg);
      break;
    case "edge":
      throw new Error(
        "edge provider not bundled yet — install edge-tts and set FRAMECRAFT_TTS_EDGE, or use --provider say",
      );
    case "kokoro":
      throw new Error(
        "kokoro provider not bundled yet — needs a python env; use --provider say on macOS",
      );
    default:
      throw new Error(`unknown TTS provider ${provider}`);
  }
  return {
    path: opts.out,
    duration: await durationOf(ffprobe, opts.out),
    provider,
    voice: opts.voice ?? "default",
  };
}
